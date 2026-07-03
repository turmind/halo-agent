import { Hono, type Context } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { channelAccounts, getChannelDb } from '../db/channel-db.js'
import { getAccountByToken } from '../channels/web/accounts.js'
import { getClientIp, isLockedOut, recordFailure, clearFailures } from '../middleware/brute-force.js'
import { readonlySessionCounts, dropRoReader } from './show.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { SessionInfo } from '../agents/session-manager.js'

/** Shared lockout bucket with the rest of the public web/show surface. */
const TOKEN_BUCKET = 'web-token'

/** Per-workspace session cap mirrored from show.ts — the snapshot is bounded so
 *  one runaway workspace can't make a scrape O(all sessions ever). */
const SESSIONS_PER_WS = 500

/** Render one Prometheus metric family: HELP + TYPE header then sample lines. */
function family(name: string, type: 'gauge' | 'counter', help: string, samples: Array<{ labels?: string; value: number }>): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`]
  for (const s of samples) lines.push(`${name}${s.labels ? `{${s.labels}}` : ''} ${s.value}`)
  return lines.join('\n')
}

/** Discover every workspace a full-access scrape covers: live SessionManagers
 *  plus every channel-account-bound path. Deduped by realpath. (Same set
 *  show.ts surfaces, kept inline — the canonical copy is tied to show's route.) */
function discoverWorkspaces(registry: SessionManagerRegistry): Set<string> {
  const out = new Set<string>()
  const add = (p: string) => {
    try { out.add(fs.realpathSync(p)) } catch { /* gone from disk — skip */ }
  }
  for (const { workspacePath } of registry.list()) add(workspacePath)
  try {
    for (const row of getChannelDb().select().from(channelAccounts).all()) add(row.workspacePath)
  } catch { /* channel db not ready */ }
  return out
}

export function createMetricsRoutes(registry: SessionManagerRegistry) {
  const app = new Hono()

  /** Token auth mirroring show.ts. Metrics expose cross-workspace aggregates,
   *  so require a full-access token — a workspace-scoped one shouldn't learn
   *  the size of the whole deployment. */
  function auth(c: Context) {
    const ip = getClientIp(c)
    if (isLockedOut(TOKEN_BUCKET, ip)) {
      return { ok: false as const, response: c.text('# too many failed attempts\n', 429) }
    }
    const token = c.req.header('x-token') || c.req.query('token')
    if (!token) return { ok: false as const, response: c.text('# token required\n', 401) }
    const account = getAccountByToken(getChannelDb(), token)
    if (!account || !account.enabled) {
      recordFailure(TOKEN_BUCKET, ip)
      return { ok: false as const, response: c.text('# invalid token\n', 401) }
    }
    clearFailures(TOKEN_BUCKET, ip)
    // Metrics span all workspaces, so require a globally-scoped token: full, or
    // observer — the read-only global role minted exactly for dashboards/scrapes
    // (a workspace-scoped token shouldn't learn deployment-wide size).
    if (account.accessLevel !== 'full' && account.accessLevel !== 'observer') {
      return { ok: false as const, response: c.text('# global-scope token (full or observer) required\n', 403) }
    }
    return { ok: true as const }
  }

  // GET /api/metrics — Prometheus text exposition. Aggregates the same runtime
  //   signal halo-city's /show/state already collects (session counts by status,
  //   token usage, uptime), but flattened to scrape-friendly gauges.
  app.get('/metrics', (c) => {
    const a = auth(c)
    if (!a.ok) return a.response

    let running = 0, idle = 0, stopped = 0, total = 0
    let contextTokens = 0, outputTokens = 0
    let workspaces = 0

    for (const wsPath of discoverWorkspaces(registry)) {
      try {
        // peek, never getOrCreate — same rule as show.ts: this is a read-only
        // surface, and constructing a SessionManager has write side effects
        // (ensureWorkspaceHalo scaffolds .halo/, reconcileOrphansOnBoot stamps
        // stoppedAt over live sub-session rows). No live runtime in this
        // process → degraded read-only db counts (token gauges stay 0 there:
        // nothing in this process drives those sessions).
        const sm = registry.peek(wsPath)
        workspaces++
        if (!sm) {
          const counts = readonlySessionCounts(wsPath, SESSIONS_PER_WS)
          running += counts.running; idle += counts.idle; stopped += counts.stopped; total += counts.total
          continue
        }
        dropRoReader(wsPath) // live runtime took over — retire the ro connection
        const { sessions } = sm.listSessions({ includeArchived: false, limit: SESSIONS_PER_WS })
        for (const r of sessions as SessionInfo[]) {
          total++
          if (r.status === 'running') running++
          else if (r.status === 'idle') idle++
          else stopped++
        }
        // Token totals come from the in-memory UIState of sessions this process
        // is actively driving — the live signal, not a full disk re-read.
        for (const r of sessions as SessionInfo[]) {
          const live = sm.getCachedUIState(r.id.split('>')[0])
          if (live) { contextTokens += live.contextTokens ?? 0; outputTokens += live.outputTokens ?? 0 }
        }
      } catch { /* one broken workspace must not blank the scrape */ }
    }

    const body = [
      family('halo_uptime_seconds', 'gauge', 'Server process uptime in seconds.', [{ value: Math.floor(process.uptime()) }]),
      family('halo_workspaces', 'gauge', 'Number of workspaces visible to the server.', [{ value: workspaces }]),
      family('halo_sessions', 'gauge', 'Non-archived sessions by status.', [
        { labels: 'status="running"', value: running },
        { labels: 'status="idle"', value: idle },
        { labels: 'status="stopped"', value: stopped },
      ]),
      family('halo_sessions_total', 'gauge', 'Total non-archived sessions across all workspaces.', [{ value: total }]),
      family('halo_context_tokens', 'gauge', 'Sum of context tokens across actively-driven sessions.', [{ value: contextTokens }]),
      family('halo_output_tokens', 'gauge', 'Sum of output tokens across actively-driven sessions.', [{ value: outputTokens }]),
    ].join('\n\n') + '\n'

    return c.text(body, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
  })

  return app
}

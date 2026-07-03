/**
 * Self-evolution admin routes.
 *
 * Surfaces the global `evolution_runs` / `evolution_applies` tables to the
 * admin UI so the user can:
 *   - list pending / completed runs (across workspaces)
 *   - view a run's patch.md + score.json + meta + snapshot summary
 *   - approve / reject / append-hint a run
 *
 * Approval flips `evolution_runs.status='approved'` and inserts a matching
 * `evolution_applies` row in `pending` (the apply wrapper, phase 11, picks
 * it up). Rejection just flips status to `rejected`. Adding a hint appends
 * to `user_hint` without changing status — pure memo.
 *
 * Run dirs live under `<workspace_path>/.halo/evo/runs/<id>/`. We resolve
 * `workspace_path` from the db row, then read `patch.md` / `score.json`
 * lazily on detail fetch (small files, no caching).
 */
import { Hono } from 'hono'
import { eq, desc, asc, inArray, lt, and, or, sql } from 'drizzle-orm'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { evolutionApplies, evolutionRuns, getEvoDb } from '../db/evo-db.js'
import { removeRunArtifacts, removeApplyArtifacts } from '../evolution/archive.js'
import { broadcast } from '../ws/broadcast.js'

// Statuses a run must NOT be in to allow manual delete. `pending` (the ticker
// will claim it any tick) and `running` (a live wrapper is writing its run
// dir) race a process; `approved` has a queued/in-flight apply that reads the
// run dir in phase 11 — deleting it out from under the apply corrupts it.
// Everything terminal (awaiting_review / applied / rejected / skipped /
// failed / timeout, archived or not) is safe to remove.
const UNDELETABLE_RUN_STATUSES = new Set(['pending', 'running', 'approved'])

interface RunListItem {
  id: string
  workspacePath: string
  status: string
  triggerKind: string
  sourceSession: string
  userHint: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  appliedAt: number | null
  failureReason: string | null
  attempts: number
  /** Set once the row crosses the 14-day retention threshold and the
   *  archive job zips its run dir. UI surfaces these as a separate
   *  category and excludes them from the default "all" view. */
  archivedAt: number | null
  /** Approved/applied runs may be linked to an apply row — surface the latest. */
  applyId?: string
  applyStatus?: string
}

function runDirOf(workspacePath: string, runId: string): string {
  return path.join(workspacePath, '.halo', 'evo', 'runs', runId)
}

export function createEvolutionRoutes(): Hono {
  const router = new Hono()

  // GET /api/evolution/runs?archived=0|1&limit=20&before=<createdAt cursor>
  //   Cursor-paginated newest-first by `createdAt`. The archived flag picks
  //   the active or archived list (mutually exclusive views in the UI).
  //   `archivedAt` filtering happens in JS because drizzle's `is null`/`is
  //   not null` helpers needed on the column variant aren't worth the noise
  //   for what's already an in-memory pass; the limit caps the work to
  //   300 rows max.
  router.get('/evolution/runs', async (c) => {
    const archived = c.req.query('archived') === '1'
    // Cap 300 matches the admin session-list ceiling and the client's
    // MAX_RUNS — a refresh reloads the user's scrolled depth in one fetch,
    // so the clamp has to allow that depth or the reload silently truncates.
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 300)
    const beforeRaw = c.req.query('before')
    const before = beforeRaw ? Number(beforeRaw) : null
    const db = getEvoDb()
    // Pull a window large enough to filter + paginate. Without a SQL-level
    // archivedAt predicate we can't `LIMIT N` directly; over-fetch by 4×
    // (still bounded by limit, max 300 → ~1200 rows) and trim after the JS
    // filter. Real workloads won't have a 4× archived-to-active ratio inside
    // any single window.
    const fetchSize = (limit + 1) * 4
    const conditions = before !== null && Number.isFinite(before) ? [lt(evolutionRuns.createdAt, before)] : []
    const rawRows = db.select().from(evolutionRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(evolutionRuns.createdAt))
      .limit(fetchSize)
      .all()
    const filtered = rawRows.filter((r) => archived ? r.archivedAt != null : r.archivedAt == null)
    const hasMore = filtered.length > limit
    const rows = filtered.slice(0, limit)

    // Cross-table join: `evolution_applies.source_run_ids` is a JSON array
    // column, so we use sqlite's `json_each` to expand it and only fetch
    // applies that reference at least one run in the visible page. With
    // page size = 20 this looks at ~20 ids regardless of how many applies
    // the workspace has accumulated. Was previously `select * from applies`
    // every call — fine at N=10 applies, dies at N=10k.
    const applyByRunId = new Map<string, { id: string; status: string }>()
    if (rows.length > 0) {
      const sqlite = (db as unknown as { $client?: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).$client
        ?? (db as unknown as { session: { client: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } } }).session.client
      const placeholders = rows.map(() => '?').join(',')
      const stmt = sqlite.prepare(`
        SELECT a.id AS id, a.status AS status, a.created_at AS created_at, j.value AS run_id
        FROM evolution_applies a, json_each(a.source_run_ids) j
        WHERE j.value IN (${placeholders})
        ORDER BY a.created_at DESC
      `)
      const linkRows = stmt.all(...rows.map((r) => r.id)) as Array<{ id: string; status: string; run_id: string }>
      for (const lr of linkRows) {
        // We walk in desc(createdAt) order, so the first apply seen for a
        // given run is the latest one — same "first-seen wins" semantics
        // as the old in-memory pass.
        if (!applyByRunId.has(lr.run_id)) {
          applyByRunId.set(lr.run_id, { id: lr.id, status: lr.status })
        }
      }
    }

    const items: RunListItem[] = []
    for (const r of rows) {
      const apply = applyByRunId.get(r.id)
      items.push({
        id: r.id,
        workspacePath: r.workspacePath,
        status: r.status,
        triggerKind: r.triggerKind,
        sourceSession: r.sourceSession,
        userHint: r.userHint,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        appliedAt: r.appliedAt,
        failureReason: r.failureReason,
        attempts: r.attempts,
        archivedAt: r.archivedAt,
        applyId: apply?.id,
        applyStatus: apply?.status,
      })
    }

    const nextCursor = hasMore ? rows[rows.length - 1]!.createdAt : null
    return c.json({ runs: items, hasMore, nextCursor })
  })

  // GET /api/evolution/runs/:id — details for a single run, including
  // patch.md (raw markdown) and score.json (parsed) loaded from disk.
  router.get('/evolution/runs/:id', async (c) => {
    const id = c.req.param('id')
    const db = getEvoDb()
    const row = db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
    if (!row) return c.json({ error: 'not found' }, 404)

    const dir = runDirOf(row.workspacePath, id)

    let patchMd: string | null = null
    try { patchMd = await fs.readFile(path.join(dir, 'patch.md'), 'utf-8') } catch { /* may not exist yet */ }

    let scoreJson: Record<string, unknown> | null = null
    try {
      const raw = await fs.readFile(path.join(dir, 'score.json'), 'utf-8')
      scoreJson = JSON.parse(raw) as Record<string, unknown>
    } catch { /* may not exist yet */ }

    // Wrapper log (the orchestration log: phase boundaries, sub-cli command
    // lines, exit codes, finalize decisions). Lives at the well-known
    // `~/.halo/global/logs/evo/run-<id>.log` path — same place the wrapper
    // writes it. Read whether the run failed or succeeded; for a successful
    // run it's still useful to see what each phase took.
    let wrapperLog: string | null = null
    try {
      wrapperLog = await fs.readFile(
        path.join(homedir(), '.halo', 'global', 'logs', 'evo', `run-${id}.log`),
        'utf-8',
      )
    } catch { /* may not exist yet (e.g. wrapper hasn't started) */ }

    // Sub-cli log: tee'd stdout/stderr of every `halo cli` child the
    // wrapper spawns (draft, fix, dry-run, score). Single file with
    // `=== <ts> Phase ... ===` headers between sections so a tail covers
    // the whole run.
    let subCliLog: string | null = null
    try {
      subCliLog = await fs.readFile(path.join(dir, 'sub-cli.log'), 'utf-8')
    } catch { /* no sub-cli ran yet, or pre-tee old run */ }

    // .skip.md is evo's "no patch worth proposing" marker, with a brief
    // human-readable reason. Present iff status === 'skipped'.
    let skipReasonMd: string | null = null
    try { skipReasonMd = await fs.readFile(path.join(dir, '.skip.md'), 'utf-8') } catch { /* expected for non-skipped runs */ }

    // Pull just enough out of source-snapshot.json for the UI summary —
    // first user message + first assistant reply. The full file can be
    // multi-MB and the UI doesn't render it.
    let snapshotSummary: { firstUser?: string; firstAssistant?: string; messageCount?: number } | null = null
    try {
      const raw = await fs.readFile(path.join(dir, 'source-snapshot.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { rawMessages?: Array<{ role: string; content: unknown }> }
      const msgs = parsed.rawMessages ?? []
      const firstUser = msgs.find((m) => m.role === 'user')
      const firstAsst = msgs.find((m) => m.role === 'assistant')
      snapshotSummary = {
        firstUser: extractText(firstUser?.content),
        firstAssistant: extractText(firstAsst?.content),
        messageCount: msgs.length,
      }
    } catch { /* missing snapshot is unusual but not fatal */ }

    // Latest apply referencing this run — so the detail pane can surface an
    // "apply failed" state on an approved run (which deliberately stays
    // `approved` after a failed apply, per the regression-gate design) and
    // offer retry. Same json_each lookup the list endpoint uses, scoped to
    // this one id.
    const latestApply = db.select({ id: evolutionApplies.id, status: evolutionApplies.status, failureReason: evolutionApplies.failureReason })
      .from(evolutionApplies)
      .where(sql`exists (select 1 from json_each(${evolutionApplies.sourceRunIds}) where value = ${id})`)
      .orderBy(desc(evolutionApplies.createdAt))
      .get()

    return c.json({
      run: {
        id: row.id,
        workspacePath: row.workspacePath,
        status: row.status,
        triggerKind: row.triggerKind,
        sourceSession: row.sourceSession,
        userHint: row.userHint,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        appliedAt: row.appliedAt,
        failureReason: row.failureReason,
        attempts: row.attempts,
        applyId: latestApply?.id,
        applyStatus: latestApply?.status,
        applyFailureReason: latestApply?.failureReason,
      },
      patchMd,
      scoreJson,
      skipReasonMd,
      snapshotSummary,
      wrapperLog,
      subCliLog,
    })
  })

  // POST /api/evolution/runs/:id/approve { reviewerHint? }
  // Flips run → approved + queues an evolution_applies row.
  router.post('/evolution/runs/:id/approve', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { reviewerHint?: string }
    const reviewerHint = typeof body.reviewerHint === 'string' && body.reviewerHint.trim().length > 0
      ? body.reviewerHint.trim()
      : null

    const db = getEvoDb()
    const row = db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (row.status !== 'awaiting_review') {
      return c.json({ error: `cannot approve run in status=${row.status}` }, 409)
    }

    // Two writes in sequence — sqlite better-sqlite3 is synchronous so they're
    // effectively atomic from the UI's perspective. Using a transaction would
    // be marginally safer but drizzle-sqlite's tx wrapper is awkward and the
    // failure mode (run flipped, apply not inserted) is recoverable via the
    // ticker (it'll surface the run as approved-but-not-queued).
    db.update(evolutionRuns)
      .set({ status: 'approved' })
      .where(eq(evolutionRuns.id, id))
      .run()

    const applyId = `apply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    db.insert(evolutionApplies).values({
      id: applyId,
      workspacePath: row.workspacePath,
      status: 'pending',
      sourceRunIds: JSON.stringify([id]),
      reviewerHint,
      createdAt: Date.now(),
    }).run()

    broadcast({ type: 'evolution:run_changed', id, status: 'approved' })
    broadcast({ type: 'evolution:apply_changed', id: applyId, status: 'pending' })
    return c.json({ ok: true, applyId })
  })

  // POST /api/evolution/runs/:id/reject — flip status to rejected. No body.
  router.post('/evolution/runs/:id/reject', async (c) => {
    const id = c.req.param('id')
    const db = getEvoDb()
    const row = db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (row.status !== 'awaiting_review') {
      return c.json({ error: `cannot reject run in status=${row.status}` }, 409)
    }
    db.update(evolutionRuns)
      .set({ status: 'rejected' })
      .where(eq(evolutionRuns.id, id))
      .run()
    broadcast({ type: 'evolution:run_changed', id, status: 'rejected' })
    return c.json({ ok: true })
  })

  // POST /api/evolution/runs/:id/retry { hint }
  //
  // Reviewer-driven retry. Either the dry-run failed and they want another
  // shot, or the produced patch isn't satisfying and they want it redone
  // with steering. Resets row to pending + zeroes attempts/heartbeat/
  // failure_reason; the next ticker pass re-spawns the wrapper. Hint is
  // required — same input + same context with no new direction would just
  // reproduce the same output. Replaces the existing user_hint (the new
  // run is a fresh attempt, the old hint was for the old patch).
  //
  // Allowed from any status except 'running' (which would race the live
  // wrapper) and 'pending' (already queued — nothing to retry).
  router.post('/evolution/runs/:id/retry', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { hint?: string }
    const hint = typeof body.hint === 'string' ? body.hint.trim() : ''
    if (!hint) return c.json({ error: 'hint is required' }, 400)

    const db = getEvoDb()
    const row = db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (row.status === 'running' || row.status === 'pending') {
      return c.json({ error: `cannot retry run in status=${row.status}` }, 409)
    }
    db.update(evolutionRuns)
      .set({
        status: 'pending',
        attempts: 0,
        startedAt: null,
        heartbeatAt: null,
        completedAt: null,
        failureReason: null,
        userHint: hint,
      })
      .where(eq(evolutionRuns.id, id))
      .run()
    broadcast({ type: 'evolution:run_changed', id, status: 'pending' })
    return c.json({ ok: true })
  })

  // POST /api/evolution/runs/:id/hint { hint }
  // Append to user_hint (memo only — no status change). The wrapper re-reads
  // user_hint on apply, so this is the user's chance to leave a note that
  // the apply agent will see.
  router.post('/evolution/runs/:id/hint', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { hint?: string }
    const hint = typeof body.hint === 'string' ? body.hint.trim() : ''
    if (!hint) return c.json({ error: 'hint is required' }, 400)

    const db = getEvoDb()
    const row = db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
    if (!row) return c.json({ error: 'not found' }, 404)

    // Append to existing user_hint with a separator. Multiple appends from
    // the reviewer accumulate so the apply agent sees the full conversation
    // of memos.
    const next = row.userHint && row.userHint.trim().length > 0
      ? `${row.userHint}\n---\n${hint}`
      : hint
    db.update(evolutionRuns)
      .set({ userHint: next })
      .where(eq(evolutionRuns.id, id))
      .run()
    return c.json({ ok: true, userHint: next })
  })

  // DELETE /api/evolution/runs/:id — remove a finished run: its on-disk
  // artifacts (live run dir + archive zip) AND the db row. Blocked for
  // in-flight states (see UNDELETABLE_RUN_STATUSES) so we never delete a row
  // a wrapper or the ticker is mid-operation on. Artifact removal goes
  // through removeRunArtifacts (filesystem direct, no in-memory state) so a
  // server restart between list and delete can't strand files.
  router.delete('/evolution/runs/:id', async (c) => {
    const id = c.req.param('id')
    const db = getEvoDb()
    const row = db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (UNDELETABLE_RUN_STATUSES.has(row.status)) {
      return c.json({ error: `cannot delete run in status=${row.status}` }, 409)
    }

    // Cascade to the applies this run produced. An apply links to its source
    // run(s) only via the `source_run_ids` JSON array (no FK), so match with
    // json_each. Each apply has its own dir + history rollback snapshot +
    // archive zip + log; without this they'd be stranded on disk (and as
    // orphaned db rows) when the run is deleted. Filesystem + db are queried
    // directly here, never from in-memory state, so a restart between list
    // and delete can't strand artifacts.
    const applies = db
      .select({ id: evolutionApplies.id, workspacePath: evolutionApplies.workspacePath })
      .from(evolutionApplies)
      .where(sql`EXISTS (SELECT 1 FROM json_each(${evolutionApplies.sourceRunIds}) WHERE value = ${id})`)
      .all()
    for (const a of applies) {
      removeApplyArtifacts(a.workspacePath, a.id)
      db.delete(evolutionApplies).where(eq(evolutionApplies.id, a.id)).run()
      broadcast({ type: 'evolution:apply_changed', id: a.id, kind: 'deleted' })
    }

    removeRunArtifacts(row.workspacePath, id)
    db.delete(evolutionRuns).where(eq(evolutionRuns.id, id)).run()
    broadcast({ type: 'evolution:run_changed', id, kind: 'deleted' })
    return c.json({ ok: true })
  })

  // GET /api/evolution/applies — list in-flight applies (pending / running /
  // syncing). Terminal rows (applied / failed) are not useful for the UI's
  // "queued for apply" badge and only inflate response size, so they're
  // filtered server-side. Hard-limited to 200; once an installation has
  // more than that simultaneously in flight, the badge UI is the wrong
  // signal anyway.
  router.get('/evolution/applies', async (c) => {
    const db = getEvoDb()
    const rows = db.select().from(evolutionApplies)
      .where(or(
        eq(evolutionApplies.status, 'pending'),
        eq(evolutionApplies.status, 'running'),
        eq(evolutionApplies.status, 'syncing'),
      ))
      .orderBy(desc(evolutionApplies.createdAt))
      .limit(200)
      .all()
    return c.json({ applies: rows })
  })

  return router
}

/** Pull text content out of either a string or a content-block array. */
function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') return b.text
    }
  }
  return undefined
}

// Suppress unused-import warning — `inArray` and `asc` may be useful for
// future filter endpoints; keep them imported so editors don't strip the
// drizzle ops.
void inArray
void asc

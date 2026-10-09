/**
 * Inbound exposure: which workspace a request path names, who the caller is,
 * and the agent card served for it (plans/a2a.md §3–4). The route factory
 * (routes.ts) takes these as pluggable strategies so the same handler mounts
 * under `/a2a` today and at `/` inside an AgentCore runtime later.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Context } from 'hono'
import { config } from '../config.js'
import { resolveTokenAuth } from '../middleware/web-token.js'
import { getChannelDb } from '../db/channel-db.js'
import type { AccountAccessLevel } from '../channels/shared/accounts.js'
import { A2A_VERSION } from './wire.js'

export const CARD_FILE = path.join('.halo', 'agent-card.json')

export interface A2ACaller { accountId: string; label: string; accessLevel: AccountAccessLevel }
export type AuthOutcome = { ok: true; caller: A2ACaller; workspace: string } | { ok: false; status: 401 | 404 | 429 }

/** Per-path strategy bundle. `rel` = the raw (still percent-encoded) path
 *  after the mount prefix, card suffix and trailing slash stripped. */
export interface A2AStrategies {
  authenticate(c: Context, rel: string): AuthOutcome
  interfaceUrl(c: Context, rel: string): string
}

/** Win32 compares paths case-insensitively with either separator. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return a === b
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/** Workspace dir → the URL path segment after the mount (`A/B`, each segment
 *  percent-encoded, `\` → `/` on win32). null when outside `base`. */
export function relUrlPath(base: string, workspace: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix
  const rel = p.relative(base, workspace)
  if (!rel || rel.startsWith('..') || p.isAbsolute(rel)) return null
  return rel.split(platform === 'win32' ? /[\\/]/ : '/').map(encodeURIComponent).join('/')
}

let baseCache: { raw: string; real: string | null } | null = null
function realBase(): string | null {
  const raw = config.a2a.root
  if (baseCache?.raw !== raw) {
    let real: string | null = null
    try { real = fs.realpathSync(raw) } catch { console.warn(`[A2A] base dir ${raw} not found — nothing is exposed`) }
    baseCache = { raw, real }
  }
  return baseCache.real
}

/** Resolve `rel` under `base` to an exposed workspace realpath, or null.
 *  Rejects empty / `.` / `..` / separator-bearing segments, symlinks that
 *  leave the base, and dirs without `.halo/agent-card.json`. */
export function resolveExposedWorkspace(base: string, rel: string): string | null {
  if (!rel) return null
  const segs: string[] = []
  for (const raw of rel.split('/')) {
    let seg: string
    try { seg = decodeURIComponent(raw) } catch { return null }
    if (seg === '' || seg === '.' || seg === '..' || /[\\/\0]/.test(seg)) return null
    segs.push(seg)
  }
  let real: string
  try { real = fs.realpathSync(path.join(base, ...segs)) } catch { return null }
  if (!real.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return null
  try { if (!fs.statSync(path.join(real, CARD_FILE)).isFile()) return null } catch { return null }
  return real
}

/** Today's strategy: web-channel token in a header, workspace = home-relative
 *  path, token bound to exactly that workspace. Every refusal past "no token"
 *  is the same 404, so a caller can't map which dirs exist or are exposed. */
export const homeStrategies: A2AStrategies = {
  authenticate(c, rel) {
    const auth = resolveTokenAuth(c, getChannelDb(), { headerOnly: true })
    if (!auth.ok) return { ok: false, status: auth.reason === 'missing_token' ? 401 : auth.reason === 'locked_out' ? 429 : 404 }
    const base = realBase()
    const ws = base ? resolveExposedWorkspace(base, rel) : null
    if (!ws) return { ok: false, status: 404 }
    let bound: string
    try { bound = fs.realpathSync(auth.account.workspacePath) } catch { return { ok: false, status: 404 } }
    if (!samePath(bound, ws)) return { ok: false, status: 404 }
    return { ok: true, caller: { accountId: auth.account.accountId, label: auth.account.label, accessLevel: auth.account.accessLevel }, workspace: ws }
  },
  interfaceUrl(c, rel) {
    return `${publicOrigin(c)}/a2a/${rel}/`
  },
}

/** `general.a2a.public_url` / env, else the request's own origin. */
export function publicOrigin(c: Context): string {
  if (config.a2a.publicUrl) return config.a2a.publicUrl
  const url = new URL(c.req.url)
  const proto = config.server.trustProxy ? (c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '')) : url.protocol.replace(':', '')
  return `${proto}://${c.req.header('host') ?? url.host}`
}

export interface CardCaps { streaming: boolean }

/** Read the user-authored card and fill in the server-owned fields.
 *  Throws on an unreadable / incomplete file (the route answers 500). */
export function buildCard(workspace: string, interfaceUrl: string, caps: CardCaps): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(path.join(workspace, CARD_FILE), 'utf8')) as Record<string, unknown>
  if (typeof raw.name !== 'string' || typeof raw.description !== 'string' || !Array.isArray(raw.skills)) {
    throw new Error('agent-card.json needs string "name", string "description" and array "skills"')
  }
  return {
    name: raw.name,
    description: raw.description,
    version: typeof raw.version === 'string' ? raw.version : (process.env.HALO_VERSION ?? 'dev'),
    supportedInterfaces: [{ url: interfaceUrl, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION }],
    capabilities: { streaming: caps.streaming, pushNotifications: true, extendedAgentCard: false },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
      xToken: { apiKeySecurityScheme: { location: 'header', name: 'x-token' } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }, { schemes: { xToken: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: raw.skills,
  }
}

export function etagOf(body: string): string {
  return `"${crypto.createHash('sha1').update(body).digest('base64url')}"`
}

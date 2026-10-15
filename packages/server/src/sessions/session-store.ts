/**
 * Session store — file-based persistence for session logs.
 *
 * Layout (2.0): `.halo/sessions/{agentId}/{seg}.ui.jsonl` (UI log) and
 * `{seg}.raw.jsonl` (model history), plus UI archive segments — see
 * session-log.ts / session-archive.ts. The files hold messages only; every
 * piece of session metadata (title, counts, tokens, output, parent, agent
 * name) lives in the session's `agent_sessions` row.
 *
 * 1.x kept one `{seg}.json` with both halves and a metadata header. Nothing
 * here reads it: legacy-migrate.ts converts a session the first time its 2.0
 * log is opened (session-log.ts `openLog`), and never touches the `.json`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { and, eq, gte, inArray, lt, or } from 'drizzle-orm'
import type { SessionMessage } from './session-types.js'
import {
  uiLogPath, rawLogPath, readUILog, readRawLog, writeUILog, forgetLogCaches,
  type UIWriteResult,
} from './session-log.js'
import { internalSessionsDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { globalInternalSessionsDir } from '../paths.js'

/**
 * Internal agents (`__evo_agent__`, `__score__`, `__apply_agent__`) are
 * platform tooling — their sessions don't belong to any user workspace.
 * Their session files go to `~/.halo/global/internal-sessions/<agentId>/`
 * regardless of which workspace the cli was launched against, keeping
 * the user's workspace tree clean. Their rows live in that directory's own
 * db (`internalSessionsDb`, db/index.ts), same schema as a workspace's.
 *
 * Detection by id pattern (leading + trailing `__`); naming convention
 * the seed templates already use.
 */
export function isInternalAgent(agentId: string): boolean {
  return agentId.startsWith('__') && agentId.endsWith('__')
}

/** Resolve session directory for an agent: .halo/sessions/{agentId}/ */
export function getSessionDir(agentId: string, projectPath?: string | null): string {
  if (isInternalAgent(agentId)) {
    return path.join(homedir(), '.halo', 'global', 'internal-sessions', agentId)
  }
  const base = projectPath ? path.join(projectPath, '.halo') : path.join(homedir(), '.halo')
  return path.join(base, 'sessions', agentId)
}

/** Resolve sessions base directory: .halo/sessions/ */
export function getSessionsBaseDir(projectPath?: string | null): string {
  const base = projectPath ? path.join(projectPath, '.halo') : path.join(homedir(), '.halo')
  return path.join(base, 'sessions')
}

/** Extract the last segment of a hierarchical session ID for use as filename.
 *  Full IDs like `root>child>grandchild` exceed ext4's 255-byte filename limit
 *  at depth ~12. The segment alone (`grandchild`) stays short. */
export function fileSegment(sessionId: string): string {
  const parts = sessionId.split('>')
  return parts[parts.length - 1]
}

/** Strip the arrival-time stamp runAgentTurn prepends to every model-facing user
 *  turn (`[2026-09-12T15:17:44.153Z] `). The UI log keeps the user's raw text,
 *  so anything that matches or displays a raw user turn against it
 *  (deleteExchange's turn locator, the cold-path raw→display fallback) must
 *  drop the stamp first. */
export function stripTurnStamp(s: string): string {
  return s.replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] ?/, '')
}

/**
 * Main-conversation user turns in a UI log — `role === 'user'` without a
 * `taskId`, the same subset `archiveSplitIndex` splits on and `deleteExchange`
 * counts ordinals over.
 */
export function countMainUserMessages(messages: SessionMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role === 'user' && !m.taskId) n++
  }
  return n
}

/** The title a session gets from its log: a delegated session's brief, else
 *  the first user message minus the injected context lines. Only applied while
 *  the session row has no title yet (sticky). */
export function deriveSessionTitle(messages: SessionMessage[], opts: { delegated: boolean; description?: string; agentName: string }): string {
  if (opts.delegated) return (opts.description || `${opts.agentName} session`).slice(0, 60)
  const firstUser = messages.find((m) => m.role === 'user')
  const rawTitle = (firstUser ? firstUser.content : '')
    .replace(/\[Currently viewing:[^\]]*\]\s*/g, '')
    .replace(/\[Face open:[^\]]*\]\s*/g, '')
    .replace(/\[Selected text in[^\]]*\]\n```[\s\S]*?```\s*/g, '')
    .trim()
  return (rawTitle || 'New session').slice(0, 60)
}

// ── UI log ────────────────────────────────────────────────────────────

/** Load a session's UI log ([] when it has none). `prime` = the result
 *  becomes the log this process writes (see readUILog). */
export function loadSessionMessages(sessionId: string, projectPath?: string | null, agentId?: string, opts?: { prime?: boolean }): SessionMessage[] {
  const dir = getSessionDir(agentId ?? 'default', projectPath)
  return readUILog(uiLogPath(dir, fileSegment(sessionId)), opts) ?? []
}

/**
 * Persist a UI log (finalized rows + the optional in-flight assistant) —
 * appends what changed since this process's last write (session-log.ts).
 * Returns the main-user delta for the row's exchange count and the file size,
 * or null when nothing was written.
 */
export function saveUILog(
  sessionId: string, agentId: string, projectPath: string | null,
  rows: SessionMessage[], inflight: SessionMessage | null,
  opts?: { rewrite?: boolean },
): UIWriteResult | null {
  if (!sessionId || (rows.length === 0 && !inflight)) return null
  try {
    const dir = getSessionDir(agentId, projectPath)
    return writeUILog(uiLogPath(dir, fileSegment(sessionId)), rows, inflight, opts)
  } catch (err) {
    console.error(`[SessionStore] Failed to save UI log for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ── Raw log ───────────────────────────────────────────────────────────

/** Load a session's model history ([] when it has none). `prime` = the
 *  result becomes the live `agent.messages` (see readRawLog). */
export function loadRawMessages(sessionId: string, agentId: string, projectPath?: string | null, opts?: { prime?: boolean }): unknown[] {
  const dir = getSessionDir(agentId, projectPath)
  return readRawLog(rawLogPath(dir, fileSegment(sessionId)), opts) ?? []
}

// ── Readers ───────────────────────────────────────────────────────────

/** A session's UI + raw log for a known (agentId, sessionId) — the log route /
 *  halo-city view. Null when the session has no UI log on disk. */
export function loadSessionView(sessionId: string, agentId: string, projectPath?: string | null): { messages: SessionMessage[]; rawMessages: unknown[] } | null {
  const dir = getSessionDir(agentId, projectPath)
  const seg = fileSegment(sessionId)
  const messages = readUILog(uiLogPath(dir, seg))
  if (!messages) return null
  return { messages, rawMessages: readRawLog(rawLogPath(dir, seg)) ?? [] }
}

// ── Delete ────────────────────────────────────────────────────────────

/** A file of session `seg`: 2.0 logs and segments (plus a crashed write's
 *  `.tmp.<pid>.<ms>`), the 1.x `.json` and its segments. */
function isSessionFile(name: string, seg: string): boolean {
  if (!name.startsWith(`${seg}.`)) return false
  const rest = name.slice(seg.length + 1).replace(/\.tmp\.[^.]+\.[^.]+$/, '')
  return rest === 'ui.jsonl' || rest === 'raw.jsonl' || rest === 'json'
    || /^ui\.arch\.\d+\.[0-9a-f]{12}\.jsonl\.gz$/.test(rest)
    || /^arch\.\d+\.json\.gz$/.test(rest)
}

/** Delete every file of one session in `dir`, found by a directory listing —
 *  never by memory — and drop the writer caches. True when anything matched. */
async function deleteSessionFilesIn(dir: string, seg: string): Promise<boolean> {
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return false }
  let hit = false
  for (const name of names) {
    if (!isSessionFile(name, seg)) continue
    try { await fs.rm(path.join(dir, name)); hit = true } catch { /* raced with another delete */ }
  }
  forgetLogCaches(dir, seg)
  return hit
}

/** Delete a session's files for a known agent. */
export async function deleteSessionFile(sessionId: string, projectPath?: string | null, agentId?: string): Promise<void> {
  await deleteSessionFilesIn(getSessionDir(agentId ?? 'default', projectPath), fileSegment(sessionId))
}

async function subdirs(base: string): Promise<string[]> {
  try {
    return (await fs.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name))
  } catch {
    return []
  }
}

/**
 * Find and delete a session's files by id. Workspace sessions: the first agent
 * dir holding its files (the caller iterates the tree and deletes the rows via
 * `deleteSession`). Otherwise an internal session: its rows live in the global
 * db (its workspace never had one), so the whole subtree's rows and files go
 * here; a 1.x internal file without a row is found by scanning the dirs.
 */
export async function findAndDeleteSessionFile(sessionId: string, projectPath?: string | null): Promise<void> {
  const seg = fileSegment(sessionId)
  for (const dir of await subdirs(getSessionsBaseDir(projectPath))) {
    if (await deleteSessionFilesIn(dir, seg)) return
  }
  const db = internalSessionsDb()
  const tree = db.select({ id: agentSessions.id, agentId: agentSessions.agentId }).from(agentSessions)
    .where(or(eq(agentSessions.id, sessionId), and(gte(agentSessions.id, sessionId + '>'), lt(agentSessions.id, sessionId + '>\uffff'))))
    .all()
  for (const r of tree) await deleteSessionFilesIn(path.join(globalInternalSessionsDir(), r.agentId), fileSegment(r.id))
  if (tree.length > 0) {
    db.delete(agentSessions).where(inArray(agentSessions.id, tree.map((r) => r.id))).run()
    return
  }
  for (const dir of await subdirs(globalInternalSessionsDir())) {
    if (await deleteSessionFilesIn(dir, seg)) return
  }
}

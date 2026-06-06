/**
 * Session store — file-based persistence for session messages.
 *
 * All sessions stored as: .halo/sessions/{agentId}/{sessionId}.json
 * No more explorer/delegated split — agentId determines the directory.
 */
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import type { SessionMessage, SessionFileData } from './session-types.js'

/**
 * Internal agents (`__evo_agent__`, `__score__`, `__apply_agent__`) are
 * platform tooling — their sessions don't belong to any user workspace.
 * Their session files go to `~/.halo/global/internal-sessions/<agentId>/`
 * regardless of which workspace the cli was launched against, keeping
 * the user's workspace tree clean.
 *
 * Detection by id pattern (leading + trailing `__`); naming convention
 * the seed templates already use.
 */
export function isInternalAgent(agentId: string): boolean {
  return agentId.startsWith('__') && agentId.endsWith('__')
}

/**
 * Look up a session JSON file under `~/.halo/global/internal-sessions/`
 * by sessionId alone. Returns the matching agentId (and the parsed JSON
 * blob) or null.
 *
 * The cli `-s <id>` resume path calls this when the workspace db has no
 * row for the id — internal-agent sessions are stored globally and have
 * no workspace db row by design (so they never pollute user workspaces).
 * The leaf-segment filename + dir-by-agent layout makes a directory scan
 * cheap (small fanout, only platform agents).
 */
export function findInternalSession(sessionId: string): {
  agentId: string
  filePath: string
  data: { agentId?: string; rawMessages?: unknown[]; messages?: unknown[]; createdAt?: string; description?: string; title?: string }
} | null {
  const root = path.join(homedir(), '.halo', 'global', 'internal-sessions')
  if (!fsSync.existsSync(root)) return null
  const seg = fileSegment(sessionId)
  for (const agentDir of fsSync.readdirSync(root, { withFileTypes: true })) {
    if (!agentDir.isDirectory()) continue
    const filePath = path.join(root, agentDir.name, `${seg}.json`)
    if (!fsSync.existsSync(filePath)) continue
    try {
      const data = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'))
      const agentId = typeof data?.agentId === 'string' && data.agentId.length > 0
        ? data.agentId
        : agentDir.name
      return { agentId, filePath, data }
    } catch {
      // corrupt JSON — keep scanning, another agent dir may have it
    }
  }
  return null
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

/** Resolve the path for a session file. Always uses the segment-based name —
 *  hierarchical IDs (`a>b>c`) only matter at runtime; on disk the file is the
 *  leaf segment. */
function resolveSessionPath(dir: string, sessionId: string, ext: string): string {
  return path.join(dir, `${fileSegment(sessionId)}${ext}`)
}

/** Options for saving a session */
export interface SessionSaveOptions {
  sessionId: string
  projectPath: string | null
  messages: SessionMessage[]
  contextTokens: number
  outputTokens: number
  /** Agent ID (default: 'default') */
  agentId?: string
  /** Agent display name (default: 'Default') */
  agentName?: string
  /** Session source metadata (not used for path — kept for backward compat in JSON) */
  source?: 'explorer' | 'delegated'
  /** Description used as title for delegated sessions */
  description?: string
  /** Parent session ID (sub-sessions only) */
  parentSessionId?: string | null
}

/**
 * Atomic file write: write to a temp file in the same directory, then
 * rename to the final path. POSIX guarantees rename within the same
 * filesystem is atomic — readers always see either the old complete
 * file or the new complete file, never a half-written one. Used for
 * session jsonl writes which would otherwise corrupt under SIGKILL /
 * OOM mid-write.
 *
 * Windows note: NTFS rename-over-existing is also atomic at the
 * filesystem level, but can fail with EPERM/EBUSY if another process
 * (antivirus scanning, indexer) has the target open. Halo targets
 * Linux/macOS today; Windows support is a separate effort.
 *
 * The temp suffix includes pid + ms so concurrent writers (different
 * processes shouldn't happen — there's a single-instance lock — but
 * be defensive about a fork or test runner) don't collide.
 */
function atomicWriteJsonSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}`
  fsSync.writeFileSync(tmpPath, content, 'utf-8')
  try {
    fsSync.renameSync(tmpPath, filePath)
  } catch (err) {
    // rename failed — clean up the orphan temp so we don't leave
    // junk piling up. Best-effort; if cleanup also fails, the next
    // server boot will eventually accumulate them (acceptable: temp
    // files don't break listing — only `.json` files are scanned).
    try { fsSync.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/** Save session messages to JSON file — path determined by agentId */
export function saveSessionToFile(opts: SessionSaveOptions): void {
  const { sessionId, projectPath, messages, contextTokens, outputTokens } = opts
  const agentId = opts.agentId ?? 'default'
  const agentName = opts.agentName ?? 'Default'
  const source = opts.source ?? 'explorer'

  if (!sessionId || messages.length === 0) return
  try {
    const dir = getSessionDir(agentId, projectPath)
    fsSync.mkdirSync(dir, { recursive: true })

    const filePath = resolveSessionPath(dir, sessionId, '.json')

    const now = new Date().toISOString()
    let createdAt = now
    let existingParent: string | undefined
    let existingRawMessages: unknown
    let existingOutput: unknown
    let existingTitle: string | undefined
    try {
      const existing = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'))
      if (existing.createdAt) createdAt = existing.createdAt
      if (existing.parentSessionId) existingParent = existing.parentSessionId
      if (existing.title && existing.title !== 'New session') existingTitle = existing.title
      // Preserve agent state fields (written by session-manager saveAgentState)
      if (existing.rawMessages) existingRawMessages = existing.rawMessages
      if (existing.output !== undefined) existingOutput = existing.output
    } catch { /* new session */ }

    // Title: derived once from the first user message and sticky thereafter.
    // Callers may pass truncated message logs (e.g. event-driven views that
    // miss the user turn) — preserving the existing title avoids clobbering
    // a good title with 'New session' when the user msg isn't in `messages`.
    let title: string
    if (existingTitle) {
      title = existingTitle
    } else if (source === 'delegated') {
      title = (opts.description ?? `${agentName} session`).slice(0, 60)
    } else {
      const firstUser = messages.find((m) => m.role === 'user')
      let rawTitle = firstUser ? firstUser.content : ''
      rawTitle = rawTitle
        .replace(/\[Currently viewing:[^\]]*\]\s*/g, '')
        .replace(/\[Selected text in[^\]]*\]\n```[\s\S]*?```\s*/g, '')
        .trim()
      title = (rawTitle || 'New session').slice(0, 60)
    }

    const parentSessionId = existingParent ?? (opts.parentSessionId || undefined)
    const session: Record<string, unknown> = {
      version: 1,
      id: sessionId,
      agentId,
      agentName,
      title,
      source,
      createdAt,
      updatedAt: now,
      messageCount: messages.length,
      contextTokens,
      totalOutputTokens: outputTokens,
      messages,
      ...(parentSessionId ? { parentSessionId } : {}),
      // Preserve rawMessages/output from session-manager
      ...(existingRawMessages ? { rawMessages: existingRawMessages } : {}),
      ...(existingOutput !== undefined ? { output: existingOutput } : {}),
    }

    atomicWriteJsonSync(filePath, JSON.stringify(session, null, 2))
  } catch (err) {
    console.debug(`[SessionStore] Failed to save session: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Same atomic write helper, exported so session-manager's saveAgentState
 * (which writes to the same jsonl path with a different field set) can
 * use it without duplicating the temp+rename dance. Both callers MUST
 * use this — session-manager and session-store write to the same file,
 * so a non-atomic write from either side would still corrupt the file
 * the other side reads back.
 */
export function atomicWriteSessionFile(filePath: string, content: string): void {
  atomicWriteJsonSync(filePath, content)
}

/** Load session messages from JSON file */
export function loadSessionMessages(sessionId: string, projectPath?: string | null, agentId?: string): SessionMessage[] {
  try {
    const dir = getSessionDir(agentId ?? 'default', projectPath)
    const filePath = resolveSessionPath(dir, sessionId, '.json')
    const raw = fsSync.readFileSync(filePath, 'utf-8')
    const session = JSON.parse(raw)
    return (session.messages ?? []) as SessionMessage[]
  } catch {
    return []
  }
}

/** Load full session file data (including token counts) */
export function loadSessionFileData(sessionId: string, projectPath?: string | null, agentId?: string): SessionFileData | null {
  try {
    const dir = getSessionDir(agentId ?? 'default', projectPath)
    const filePath = resolveSessionPath(dir, sessionId, '.json')
    const raw = fsSync.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as SessionFileData
  } catch {
    return null
  }
}

/** Delete a session JSON file. */
export async function deleteSessionFile(sessionId: string, projectPath?: string | null, agentId?: string): Promise<void> {
  const dir = getSessionDir(agentId ?? 'default', projectPath)
  try { await fs.rm(path.join(dir, `${fileSegment(sessionId)}.json`)) } catch { /* not found */ }
}

/** List all session files for an agent */
export function listSessionFiles(projectPath?: string | null, agentId?: string): string[] {
  try {
    const dir = getSessionDir(agentId ?? 'default', projectPath)
    return fsSync.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
  } catch {
    return []
  }
}

// ── Per-session jsonl enrichment ──────────────────────────────────

/**
 * Read jsonl-only metadata for a known (agentId, sessionId). Returns the
 * fields the db row doesn't carry (title, messageCount, token counts).
 *
 * This is the per-row enrichment used by the paginated listing path: db
 * gives us the page (default 50), then we read at most that many jsonl
 * headers — orders of magnitude cheaper than the previous "scan every
 * file every time" pattern.
 */
export function readSessionFileMeta(
  sessionId: string,
  agentId: string,
  projectPath?: string | null,
): { title: string; messageCount: number; contextTokens?: number; totalOutputTokens?: number } | null {
  try {
    const dir = getSessionDir(agentId, projectPath)
    const filePath = resolveSessionPath(dir, sessionId, '.json')
    const raw = fsSync.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<SessionFileData>
    return {
      title: data.title ?? '',
      messageCount: data.messageCount ?? 0,
      contextTokens: data.contextTokens,
      totalOutputTokens: data.totalOutputTokens,
    }
  } catch {
    return null
  }
}

/** Find and load a session file by ID (scans all agent dirs). */
export function findSessionFileData(sessionId: string, projectPath?: string | null): SessionFileData | null {
  try {
    const baseDir = getSessionsBaseDir(projectPath)
    const agentDirs = fsSync.readdirSync(baseDir)
    const fileName = `${fileSegment(sessionId)}.json`
    for (const agentDir of agentDirs) {
      try {
        return JSON.parse(fsSync.readFileSync(path.join(baseDir, agentDir, fileName), 'utf-8')) as SessionFileData
      } catch { /* not in this agent's dir */ }
    }
  } catch { /* base dir doesn't exist */ }
  return null
}

/** Find and delete a session file by ID (scans all agent dirs). */
export async function findAndDeleteSessionFile(sessionId: string, projectPath?: string | null): Promise<void> {
  try {
    const baseDir = getSessionsBaseDir(projectPath)
    const agentDirs = await fs.readdir(baseDir)
    const fileName = `${fileSegment(sessionId)}.json`
    for (const agentDir of agentDirs) {
      try {
        await fs.rm(path.join(baseDir, agentDir, fileName))
        return
      } catch { /* not here, try next agent dir */ }
    }
  } catch { /* base dir doesn't exist */ }
}

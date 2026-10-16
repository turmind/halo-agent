import type { ModelRuntime } from './model-runtime.js'
import { getSessionDir, fileSegment, loadRawMessages } from '../sessions/session-store.js'
import { rawLogPath, writeRawLog } from '../sessions/session-log.js'
import { LegacyConversionError } from '../sessions/legacy-migrate.js'
import { updateSessionOutput, type HaloDb } from '../db/index.js'

/**
 * The slice of an AgentSession that `saveAgentState` needs. A narrow structural
 * type (rather than importing SessionManager's internal `AgentSession`) keeps
 * the dependency one-directional and minimal — the store reads these fields,
 * never the whole session object.
 */
export interface SavableSession {
  id: string
  agentId: string
  output: string
  lastActivityAt: string | null
  agent: Pick<ModelRuntime, 'messages'>
}

/**
 * Surface SessionStateStore needs from SessionManager. The tombstone check is
 * the one cross-read: a late save from an in-flight turn's releaseSession must
 * not resurrect a file the user just deleted. `metaDb` = the db holding the
 * session's row (the global internal-sessions db for `__*__` agents).
 */
export interface SessionStateStoreHost {
  readonly workspaceRoot: string
  isSessionDeleted(id: string): boolean
  metaDb(agentId: string): HaloDb
}

/**
 * SessionStateStore — persists/loads an agent's model history (`raw.jsonl`,
 * one message per line) plus its latest output / activity stamp (row
 * columns). Carved out of SessionManager (fifth knife); stateless — the
 * writer's append baseline lives in session-log.ts. This is the raw half of
 * session persistence; the UI-log half lives in SessionUIStore, in its own
 * file, so neither half rewrites the other.
 *
 * Contract: a persisted raw message must not be edited in place without
 * replacing its `content` array or changing its length — writeRawLog detects
 * changes by reference (every current mutator complies; see session-log.ts).
 */
/** Minimum gap between two row writes of one session's output /
 *  lastActivityAt on the hot save points (`throttle`). */
export const ROW_WRITE_THROTTLE_MS = 5_000

export class SessionStateStore {
  constructor(private host: SessionStateStoreHost) {}

  /** Per session: when its row was last written, and the trailing write
   *  pending (throttled saves). Process-local and lossy by design — the row
   *  is a cache of the in-memory output; a lost timer costs ≤ the throttle. */
  private rowWrites = new Map<string, { at: number; timer: NodeJS.Timeout | null }>()

  /** Directory for an agent's session files.
   *  Resolution lives in session-store.ts so that all session-path
   *  consumers (here, route handlers, future tools) share one source
   *  of truth — including the special-case routing for internal
   *  agents (__evo_agent__ / __score__ / __apply_agent__) into
   *  `~/.halo/global/internal-sessions/`. */
  sessionDir(agentId: string): string {
    return getSessionDir(agentId, this.host.workspaceRoot)
  }

  /** Persist agent.messages (append, or atomic rewrite on a non-append
   *  change) and the row's output / lastActivityAt. The raw log is written on
   *  every call. `throttle` (the per-event save points: tool_call /
   *  tool_result / usage) holds the row write to one per
   *  ROW_WRITE_THROTTLE_MS per session, with a trailing write of the latest
   *  values — each was a real UPDATE + WAL fsync, since output and
   *  lastActivityAt change on every event. Every other save writes the row at
   *  once and cancels the trailing write, so a turn end, a Stop or a graceful
   *  shutdown leaves the row exact; only a hard kill can leave it up to the
   *  throttle behind the last event. (The list sorts by updatedAt, written at
   *  turn end — not by these columns.) */
  saveAgentState(session: SavableSession, opts?: { throttle?: boolean }): void {
    // Honour the deletion tombstone like persistUILog does — a late
    // write from an in-flight turn's releaseSession must not resurrect a file
    // the user just deleted.
    if (this.host.isSessionDeleted(session.id)) return
    try {
      writeRawLog(rawLogPath(this.sessionDir(session.agentId), fileSegment(session.id)), session.agent.messages)
    } catch (err) {
      console.error(`[SessionStateStore] Failed to save state for ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const now = Date.now()
    const w = this.rowWrites.get(session.id)
    if (opts?.throttle && w && now - w.at < ROW_WRITE_THROTTLE_MS) {
      // The timer reads the session's fields when it fires: the latest values.
      w.timer ??= setTimeout(() => {
        w.timer = null
        if (this.host.isSessionDeleted(session.id)) return
        this.writeRow(session, Date.now())
      }, w.at + ROW_WRITE_THROTTLE_MS - now)
      w.timer.unref?.()
      return
    }
    this.writeRow(session, now)
  }

  /** Drop a session's throttle state (pending trailing write included) — it
   *  left memory (release saved the row) or was deleted. */
  forgetRowWrites(sessionId: string): void {
    const w = this.rowWrites.get(sessionId)
    if (w?.timer) clearTimeout(w.timer)
    this.rowWrites.delete(sessionId)
  }

  /** Write the row now (cancelling a pending trailing write) — for a caller
   *  that lands the raw log itself (landForShutdown). */
  saveRow(session: SavableSession): void {
    if (this.host.isSessionDeleted(session.id)) return
    this.writeRow(session, Date.now())
  }

  private writeRow(session: SavableSession, now: number): void {
    const w = this.rowWrites.get(session.id)
    if (w?.timer) clearTimeout(w.timer)
    this.rowWrites.set(session.id, { at: now, timer: null })
    try {
      updateSessionOutput(this.host.metaDb(session.agentId), session.id, session.output, session.lastActivityAt)
    } catch (err) {
      console.error(`[SessionStateStore] Failed to save state for ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Load agent.messages from `raw.jsonl` ([] when absent). The result
   *  becomes the live history, so it primes the writer's baseline: the next
   *  save appends instead of rewriting. A failed 1.x conversion throws — the
   *  session must not run on an empty history. */
  loadAgentState(sessionId: string, agentId: string): unknown[] {
    try {
      return loadRawMessages(sessionId, agentId, this.host.workspaceRoot, { prime: true })
    } catch (err) {
      if (err instanceof LegacyConversionError) throw err
      return []
    }
  }
}

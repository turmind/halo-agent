import fsSync from 'node:fs'
import path from 'node:path'
import type { ModelRuntime } from './model-runtime.js'
import { getSessionDir, fileSegment, atomicWriteSessionFile } from '../sessions/session-store.js'

/**
 * The slice of an AgentSession that `saveAgentState` needs. A narrow structural
 * type (rather than importing SessionManager's internal `AgentSession`) keeps
 * the dependency one-directional and minimal — the store reads these fields,
 * never the whole session object.
 */
export interface SavableSession {
  id: string
  agentId: string
  parentId: string | null
  description: string
  output: string
  agent: Pick<ModelRuntime, 'messages'>
}

/**
 * Surface SessionStateStore needs from SessionManager. The tombstone check is
 * the one cross-read: a late save from an in-flight turn's releaseSession must
 * not resurrect a file the user just deleted.
 */
export interface SessionStateStoreHost {
  readonly workspaceRoot: string
  isSessionDeleted(id: string): boolean
}

/**
 * SessionStateStore — persists/loads an agent's `rawMessages` (the LLM-facing
 * history) to its on-disk `.json` file. Carved out of SessionManager (fifth
 * knife); stateless. This is the `rawMessages` half of session persistence
 * (the UI-log half lives in SessionUIStore); the two write the same file via
 * read-merge-write so both survive.
 */
export class SessionStateStore {
  constructor(private host: SessionStateStoreHost) {}

  /** Directory for an agent's session files.
   *  Resolution lives in session-store.ts so that all session-path
   *  consumers (here, route handlers, future tools) share one source
   *  of truth — including the special-case routing for internal
   *  agents (__evo_agent__ / __score__ / __apply_agent__) into
   *  `~/.halo/global/internal-sessions/`. */
  sessionDir(agentId: string): string {
    return getSessionDir(agentId, this.host.workspaceRoot)
  }

  /** Save agent.messages as rawMessages field in the delegated log file (read-merge-write) */
  saveAgentState(session: SavableSession): void {
    // Honour the deletion tombstone like persistSessionFile/persistUIState do —
    // a late write from an in-flight turn's releaseSession must not resurrect a
    // file the user just deleted.
    if (this.host.isSessionDeleted(session.id)) return
    try {
      const dir = this.sessionDir(session.agentId)
      fsSync.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `${fileSegment(session.id)}.json`)

      let existing: Record<string, unknown> = {}
      try { existing = JSON.parse(fsSync.readFileSync(filePath, 'utf-8')) } catch { /* new file */ }

      const now = new Date().toISOString()
      existing.id = session.id
      existing.agentId = session.agentId
      if (!existing.agentName) existing.agentName = session.agentId
      if (session.parentId) existing.parentSessionId = session.parentId
      if (!existing.title) existing.title = session.description?.slice(0, 60) || `${session.agentId} session`
      if (!existing.createdAt) existing.createdAt = now
      existing.updatedAt = now
      existing.messageCount = Array.isArray(session.agent.messages) ? session.agent.messages.length : 0
      existing.output = session.output
      existing.rawMessages = session.agent.messages
      atomicWriteSessionFile(filePath, JSON.stringify(existing, null, 2))
    } catch (err) {
      console.error(`[SessionStateStore] Failed to save state for ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Load agent.messages from the delegated log file's rawMessages field */
  loadAgentState(sessionId: string, agentId: string): unknown[] {
    try {
      const filePath = path.join(this.sessionDir(agentId), `${fileSegment(sessionId)}.json`)
      const data = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'))
      return (data.rawMessages ?? []) as unknown[]
    } catch {
      return []
    }
  }
}

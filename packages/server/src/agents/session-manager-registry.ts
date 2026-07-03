import fs from 'node:fs'
import { SessionManager } from './session-manager.js'
import { ensureWorkspaceHalo } from '../init.js'

export class SessionManagerRegistry {
  private cache = new Map<string, SessionManager>()

  /**
   * @param opts.reconcileOrphansOnBoot — when true, every SessionManager this
   *   registry creates reconciles crash-orphaned sub-sessions on first build.
   *   ONLY the long-lived server process (index.ts) should set this; it owns
   *   the workspace runtime and holds server.lock. CLI/TUI registries must
   *   leave it off — they share the same db while the server may be running
   *   sessions, and reconciling there would stop the server's live sub-agents.
   *   Even with the flag set, the reconcile only runs if the per-workspace
   *   `.halo/runtime.lock` claim succeeds (two servers with different
   *   HALO_HOME can share one workspace — see workspace-runtime-lock.ts).
   */
  constructor(private opts: { reconcileOrphansOnBoot?: boolean } = {}) {}

  getOrCreate(workspacePath: string): SessionManager {
    const resolved = fs.realpathSync(workspacePath)
    ensureWorkspaceHalo(resolved)
    let sm = this.cache.get(resolved)
    if (!sm) {
      sm = new SessionManager(resolved, { reconcileOrphansOnBoot: this.opts.reconcileOrphansOnBoot })
      this.cache.set(resolved, sm)
    }
    return sm
  }

  list(): Array<{ workspacePath: string; sm: SessionManager }> {
    return [...this.cache.entries()].map(([wp, sm]) => ({ workspacePath: wp, sm }))
  }
}

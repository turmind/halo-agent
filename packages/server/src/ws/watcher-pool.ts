/**
 * One WorkspaceWatcher + GitDirWatcher per workspace root, shared by every WS
 * connection bound to that root.
 *
 * handler.ts used to create both watchers per connection: N tabs on the same
 * workspace meant N recursive @parcel/watcher native subscriptions, N debounce
 * timers, and N identical `file:changed` frames computed for one disk event.
 * The native subscription (a recursive inotify / FSEvents tree over the whole
 * workspace) is the expensive part; fanning one event out to N sockets is not.
 *
 * `attach(ws, root)` gets-or-creates the root's entry and adds the socket;
 * a socket is in at most one entry, so attaching to a different root moves
 * it. `detach(ws)` removes the socket and stops the watchers when the last
 * one leaves. Teardown of one entry never blocks a fresh start on the same
 * root — WorkspaceWatcher's process-wide native-op chain (file-watcher.ts
 * enqueueNativeOp) already orders every unsubscribe before any later
 * subscribe.
 */
import type { WebSocket } from 'ws'
import { WorkspaceWatcher } from './file-watcher.js'
import { GitDirWatcher } from './git-dir-watcher.js'
import { sendJson } from './event-processor.js'
import { skillFoldersChanged } from './skills-changed.js'

interface Entry {
  fileWatcher: WorkspaceWatcher
  gitDirWatcher: GitDirWatcher
  sockets: Set<WebSocket>
  /** Pending `skills:changed` check after `.halo/skills/` events. */
  skillsTimer: ReturnType<typeof setTimeout> | null
}

export class WatcherPool {
  private entries = new Map<string, Entry>()
  private rootOf = new Map<WebSocket, string>()

  attach(ws: WebSocket, root: string): void {
    const prev = this.rootOf.get(ws)
    if (prev === root) return
    if (prev !== undefined) this.detach(ws)
    let entry = this.entries.get(root)
    if (!entry) {
      const sockets = new Set<WebSocket>()
      const fileWatcher = new WorkspaceWatcher()
      // Command-line git ops (terminal commit/checkout/add) bypass the SC
      // panel's own re-broadcast, and WorkspaceWatcher ignores .git. Mirror
      // the panel's payload (path '.git') so the same debounced refresh fires.
      const gitDirWatcher = new GitDirWatcher()
      gitDirWatcher.setCallback(() => {
        for (const s of sockets) sendJson(s, { type: 'file:changed', path: '.git', action: 'change' })
      })
      const created: Entry = { fileWatcher, gitDirWatcher, sockets, skillsTimer: null }
      fileWatcher.setCallback((evt) => {
        for (const s of sockets) sendJson(s, { type: 'file:changed', path: evt.path, action: evt.action })
        // Skill folder written (agent file_write, hand edit): one 300ms-debounced
        // look, and a `skills:changed` only when the listed view moved — body
        // edits and the echo of a REST / `/skill` mutation stay silent.
        if ((evt.path !== '.halo/skills' && !evt.path.startsWith('.halo/skills/')) || created.skillsTimer) return
        created.skillsTimer = setTimeout(() => {
          created.skillsTimer = null
          if (!skillFoldersChanged(root)) return
          for (const s of sockets) sendJson(s, { type: 'skills:changed' })
        }, 300)
      })
      entry = created
      this.entries.set(root, entry)
      skillFoldersChanged(root) // seed the key — the first event compares against it
      void fileWatcher.start(root)
      gitDirWatcher.start(root)
    }
    entry.sockets.add(ws)
    this.rootOf.set(ws, root)
  }

  detach(ws: WebSocket): void {
    const root = this.rootOf.get(ws)
    if (root === undefined) return
    this.rootOf.delete(ws)
    const entry = this.entries.get(root)
    if (!entry) return
    entry.sockets.delete(ws)
    if (entry.sockets.size > 0) return
    this.entries.delete(root)
    if (entry.skillsTimer) clearTimeout(entry.skillsTimer)
    void entry.fileWatcher.stop()
    entry.gitDirWatcher.stop()
  }

  /** Workspace roots currently watched. */
  get size(): number {
    return this.entries.size
  }
}

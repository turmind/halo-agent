import fs, { type FSWatcher } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

/** Independent of Admin sockets. Recursive watches cover only entitlement
 * roots; a nonrecursive parent watch catches replacement/missing roots without
 * walking sibling session logs or private extension data. */
export class ExtensionAccessWatchers {
  private roots = new Map<string, { watchers: FSWatcher[]; timer?: NodeJS.Timeout }>()

  constructor(private invalidate: (projectId: string | null) => void) {}

  watchWorkspace(projectId: string): void {
    for (const name of ['skills', 'agents']) {
      this.watch(path.join(projectId, '.halo', name), projectId)
      this.watch(path.join(homedir(), '.halo', 'global', name), null)
    }
  }

  watch(root: string, projectId: string | null): void {
    root = path.resolve(root)
    if (this.roots.has(root)) return
    if (this.roots.size >= 8192) throw new Error('[ExtensionAccess] Entitlement watch limit reached')
    let parent = path.dirname(root)
    while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent)
    const entry: { watchers: FSWatcher[]; timer?: NodeJS.Timeout } = { watchers: [] }
    const changed = () => {
      // Invalidating is in-memory only. Do it even within a burst: a shell
      // could have loaded fresh eligibility since the preceding event.
      this.invalidate(projectId)
      if (entry.timer) return
      entry.timer = setTimeout(() => {
        for (const watcher of entry.watchers) watcher.close()
        this.roots.delete(root)
        this.invalidate(projectId) // discard any load made during replacement
        try { this.watch(root, projectId) } catch { /* issuance will retry/fail closed */ }
      }, 100)
      entry.timer.unref()
    }
    this.roots.set(root, entry)
    try {
      entry.watchers.push(fs.watch(parent, { persistent: false }, (_event, filename) => {
        const p = filename ? path.resolve(parent, filename.toString()) : root
        if (p === root || root.startsWith(p + path.sep)) changed()
      }))
      if (fs.existsSync(root)) entry.watchers.push(fs.watch(root, { recursive: true, persistent: false }, changed))
      for (const watcher of entry.watchers) watcher.on('error', changed)
    } catch {
      for (const watcher of entry.watchers) watcher.close()
      if (entry.timer) clearTimeout(entry.timer)
      this.roots.delete(root)
      this.invalidate(projectId)
      throw new Error('[ExtensionAccess] Cannot watch entitlement roots')
    }
  }

  unwatchWorkspace(projectId: string): void {
    for (const name of ['skills', 'agents']) {
      const root = path.join(projectId, '.halo', name)
      const entry = this.roots.get(root)
      if (!entry) continue
      for (const watcher of entry.watchers) watcher.close()
      if (entry.timer) clearTimeout(entry.timer)
      this.roots.delete(root)
    }
  }

  close(): void {
    for (const entry of this.roots.values()) {
      for (const watcher of entry.watchers) watcher.close()
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.roots.clear()
  }
}

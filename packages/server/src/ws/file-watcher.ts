/**
 * File system watcher — monitors the workspace directory for changes and emits
 * events via callback. Uses @parcel/watcher (native FSEvents on macOS, inotify
 * on Linux, ReadDirectoryChangesW on Windows) — the same engine VS Code uses.
 *
 * Why @parcel/watcher and not chokidar: we watch the workspace RECURSIVELY from
 * the root (mirroring VS Code / code-server). chokidar's recursive mode piles
 * up per-file watches and overflows the macOS FSEvents queue on large repos
 * (events silently dropped → tree stops refreshing). @parcel/watcher uses the
 * OS-native recursive APIs with event coalescing, so a big tree (even $HOME)
 * stays responsive, and a file created in a deep, never-"expanded" subdirectory
 * still fires — no lazy per-directory subscription needed.
 */
import type { AsyncSubscription } from '@parcel/watcher'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Directory names to exclude from watching. These easily cross 100k inodes and
 * are never interesting to the Explorer; excluding them keeps the watch cheap.
 * Mirrors VS Code's default `files.watcherExclude` principle.
 *
 * `.halo/sessions/` and `.halo/logs/` are intentionally NOT excluded — the
 * front-end drops `change` events for files not open in the editor and the
 * 300ms dedup below collapses rapid writes, so the cost is a few small WS
 * frames per second and the Explorer stays in sync as sessions come and go.
 */
const IGNORED_SEGMENTS = [
  // VCS
  '.git', '.hg', '.svn',
  // JS / web deps & build output & caches
  'node_modules', 'bower_components', '.pnpm-store', '.yarn',
  '.next', 'dist', 'build', 'out', 'target',
  '.turbo', '.cache', '.parcel-cache', '.nuxt', '.vite',
  '.svelte-kit', '.angular', '.vercel', '.netlify', '.expo',
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '.venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.eggs', '__pypackages__',
  // JVM / mobile / native build dirs (huge)
  '.gradle', '.m2', 'Pods', 'DerivedData', '.dart_tool',
  // Editors
  '.idea', '.vscode', '.vs', '.history', '.fleet',
  // macOS metadata / junk
  '.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems',
  '.DocumentRevisions-V100', '.PKInstallSandboxManager',
  // Windows system / junk (relevant when a drive root is opened)
  '$RECYCLE.BIN', 'System Volume Information', 'AppData',
]

/** @parcel/watcher `ignore` accepts directory names / globs. Passing the bare
 *  segment names excludes them at any depth. */
const IGNORE_GLOBS = IGNORED_SEGMENTS.flatMap((seg) => [seg, `**/${seg}/**`])

/**
 * Directories we refuse to watch outright — only the true filesystem root and
 * OS system trees, which are enormous and never a real workspace. $HOME is
 * deliberately allowed: @parcel/watcher's native recursive watcher + the ignore
 * list handle a large home dir fine, and users do open project dirs under it.
 */
function isUnwatchablePath(absPath: string): string | null {
  const norm = path.resolve(absPath)
  if (norm === '/' || norm === path.parse(norm).root) return 'filesystem root'
  const banned = ['/System', '/Library', '/private', '/usr', '/bin', '/sbin', '/etc']
  for (const b of banned) {
    if (norm === b || norm.startsWith(b + path.sep)) return `system path ${b}`
  }
  return null
}

export type FileChangeEvent = {
  /** Relative path from workspace root (POSIX separators) */
  path: string
  action: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
}

export type FileChangeCallback = (event: FileChangeEvent) => void

export class WorkspaceWatcher {
  private subscription: AsyncSubscription | null = null
  private workspaceRoot: string | null = null
  private callback: FileChangeCallback | null = null
  /** Debounce: batch rapid changes into a single notification per path */
  private pending = new Map<string, FileChangeEvent>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  setCallback(cb: FileChangeCallback): void {
    this.callback = cb
  }

  async start(workspaceRoot: string): Promise<void> {
    if (this.subscription && this.workspaceRoot === workspaceRoot) return
    await this.stop()

    const reject = isUnwatchablePath(workspaceRoot)
    if (reject) {
      console.warn(`[FileWatcher] refusing to watch ${workspaceRoot} (${reject}) — Explorer live-refresh disabled for this workspace`)
      return
    }

    this.workspaceRoot = workspaceRoot
    try {
      // Dynamic import so the native @parcel/watcher binary loads only when a
      // watch actually starts — keeps lightweight cli paths (halo acp / setup)
      // from pulling it in just by being bundled alongside server code.
      const { default: watcher } = await import('@parcel/watcher')
      this.subscription = await watcher.subscribe(workspaceRoot, (err, events) => {
        if (err) {
          console.warn(`[FileWatcher] watcher error on ${workspaceRoot}: ${err.message}`)
          return
        }
        for (const e of events) this.handleEvent(e.type, e.path)
      }, { ignore: IGNORE_GLOBS })
    } catch (err) {
      // Native subscribe can throw (permissions, vanished dir, unsupported FS).
      // Don't take the connection down — just lose live-refresh for this dir.
      console.warn(`[FileWatcher] failed to watch ${workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`)
      this.subscription = null
      this.workspaceRoot = null
    }
  }

  /** Map a parcel event to our add/change/unlink/addDir/unlinkDir shape and
   *  queue it. parcel events don't carry the file-vs-dir distinction, so on
   *  create we stat to tell them apart (the frontend tree needs it to render
   *  the right node). delete can't stat (already gone); the frontend's
   *  removeFileNode doesn't need the type. */
  private handleEvent(type: 'create' | 'update' | 'delete', absPath: string): void {
    const root = this.workspaceRoot
    if (!root) return
    const raw = path.relative(root, absPath)
    if (!raw || raw.startsWith('..')) return
    // POSIX-style path — the browser file tree keys/navigates by '/'.
    const rel = raw.split(path.sep).join('/')

    let action: FileChangeEvent['action']
    if (type === 'delete') {
      action = 'unlink'
    } else if (type === 'update') {
      action = 'change'
    } else {
      // create — distinguish file vs directory for the tree.
      let isDir = false
      try { isDir = fs.statSync(absPath).isDirectory() } catch { /* vanished between event and stat */ }
      action = isDir ? 'addDir' : 'add'
    }
    this.coalesce(rel, action)
    this.scheduleFlush()
  }

  /**
   * Merge a new event into the per-path pending slot. Plain last-wins is wrong
   * for the common "create then write" burst: a file_write (or any create
   * immediately followed by a modify) fires `create` then `update` within the
   * 300ms window; last-wins would collapse that to `change`, which the
   * front-end tree ignores (it only inserts on `add`) — so the new file never
   * appears. Precedence rules, per path per window:
   *   - pending add/addDir + change  → keep add  (file is net-new; the tree
   *                                     needs the `add` to insert the node)
   *   - pending add/addDir + unlink  → drop      (created and removed within
   *                                     the window → no net change to emit)
   *   - pending (anything)  + add/addDir/unlink → take the new one (a real
   *                                     structural transition supersedes)
   *   - otherwise → last-wins
   */
  private coalesce(rel: string, action: FileChangeEvent['action']): void {
    const prev = this.pending.get(rel)
    if (prev && (prev.action === 'add' || prev.action === 'addDir')) {
      if (action === 'change') return                 // keep the pending add
      if (action === 'unlink') { this.pending.delete(rel); return }  // add+unlink cancels out
    }
    this.pending.set(rel, { path: rel, action })
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const sub = this.subscription
    this.subscription = null
    this.workspaceRoot = null
    this.pending.clear()
    if (!sub) return
    // unsubscribe is async + native; race a timeout so a wedged watcher can't
    // block shutdown / workspace switch.
    await Promise.race([
      sub.unsubscribe().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const events = Array.from(this.pending.values())
      this.pending.clear()
      if (this.callback) {
        for (const evt of events) {
          this.callback(evt)
        }
      }
    }, 300) // 300ms debounce
  }
}

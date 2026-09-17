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

const IS_WIN32 = process.platform === 'win32'

/** For the win32 JS-side event filter — see NATIVE_IGNORE below. */
const IGNORED_SEGMENT_SET = new Set(IGNORED_SEGMENTS)

/**
 * @parcel/watcher's JS wrapper splits `ignore` entries in two: bare names
 * become `ignorePaths` (exact-path string compare in native Watcher::isIgnored,
 * resolved against the watch root so they only match at the TOP level), while
 * glob-magic names compile to C++ std::regex run against EVERY event's
 * relative path on the watcher thread.
 *
 * win32: no globs. MSVC std::regex recursion depth scales with input length —
 * a ~300-byte relative path (~85-100 CJK chars) overflows the watcher thread's
 * stack → 0xC0000409 (upstream parcel-bundler/watcher#250). Bare segments
 * still prune top-level heavy dirs natively (node_modules, .git); NESTED
 * occurrences are filtered in JS in handleEvent instead.
 * Non-win32 keeps the globs — Linux inotify relies on native ignore to avoid
 * registering watches on huge trees.
 */
const NATIVE_IGNORE = IS_WIN32
  ? IGNORED_SEGMENTS
  : IGNORED_SEGMENTS.flatMap((seg) => [seg, `**/${seg}/**`])

/**
 * Process-wide serialization of native subscribe/unsubscribe. Watchers are
 * one per workspace root (ws/watcher-pool.ts), so on workspace switch the old
 * root's stop() races the new root's start() ACROSS instances — an
 * instance-level guard can't help. @parcel/watcher's native layer is not
 * safe against that overlap on Windows: Backend.cc mutates the static
 * shared-backends map from a threadpool thread with no lock while
 * Backend::getShared reads it on the JS thread, and WindowsBackend's
 * CancelIo/APC teardown can use-after-free → 0xC0000005. Every native op from
 * every instance funnels through this one chain, so no subscribe ever starts
 * while an unsubscribe is still settling.
 */
let nativeOpChain: Promise<unknown> = Promise.resolve()

function enqueueNativeOp<T>(op: () => Promise<T>): Promise<T> {
  const result = nativeOpChain.then(op)
  // Keep the chain alive across failures — a rejected op must not poison
  // every later op.
  nativeOpChain = result.catch(() => {})
  return result
}

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
  /** Bumped by every start()/stop(). A start() whose subscribe resolves after
   *  a newer start()/stop() has bumped the epoch is stale: assigning its
   *  subscription would overwrite (and leak) the current one, so it tears its
   *  own subscription down instead. */
  private startEpoch = 0

  setCallback(cb: FileChangeCallback): void {
    this.callback = cb
  }

  async start(workspaceRoot: string): Promise<void> {
    // Checked on the ORIGINAL path (not the realpath below) so accept/refuse
    // semantics stay exactly as before — e.g. a macOS /tmp/... workspace
    // realpaths to /private/tmp/... which the ban list would refuse.
    const reject = isUnwatchablePath(workspaceRoot)
    if (reject) {
      console.warn(`[FileWatcher] refusing to watch ${workspaceRoot} (${reject}) — Explorer live-refresh disabled for this workspace`)
      return
    }

    // Resolve symlinks before subscribing: some backends emit event paths
    // under the REAL directory (macOS FSEvents always realpaths — /tmp →
    // /private/tmp), so keying workspaceRoot to a symlinked root made
    // handleEvent's path.relative() return '..'-prefixed paths for every
    // event — all silently dropped, live-refresh dead even though subscribe
    // succeeded. Watch the real path and compute relatives against it.
    // (Windows junctions / mapped drives resolve the same way, keeping the
    // event prefix and our root consistent.)
    let root = workspaceRoot
    try { root = fs.realpathSync(workspaceRoot) } catch { /* vanished dir — let subscribe() report it */ }

    if (this.subscription && this.workspaceRoot === root) return
    await this.stop()

    // stop() bumped the epoch; claim the next one. Any later start()/stop()
    // bumps it again, marking this start stale (see startEpoch).
    const epoch = ++this.startEpoch
    this.workspaceRoot = root
    try {
      // Dynamic import so the native @parcel/watcher binary loads only when a
      // watch actually starts — keeps lightweight cli paths (halo acp / setup)
      // from pulling it in just by being bundled alongside server code.
      const { default: watcher } = await import('@parcel/watcher')
      // Through the process-wide chain so this subscribe can never overlap a
      // pending native unsubscribe from ANY instance (see enqueueNativeOp).
      const sub = await enqueueNativeOp(() => watcher.subscribe(root, (err, events) => {
        if (err) {
          console.warn(`[FileWatcher] watcher error on ${root}: ${err.message}`)
          return
        }
        for (const e of events) this.handleEvent(e.type, e.path)
      }, { ignore: NATIVE_IGNORE }))
      if (this.startEpoch !== epoch) {
        // Superseded by a newer start()/stop() while subscribing. Assigning
        // now would overwrite this.subscription and leak a live native
        // subscription — tear ours down instead, again via the chain.
        void enqueueNativeOp(() => sub.unsubscribe()).catch((err) => {
          console.warn(`[FileWatcher] failed to unsubscribe superseded watch on ${root}: ${err instanceof Error ? err.message : String(err)}`)
        })
        return
      }
      this.subscription = sub
      console.debug(`[FileWatcher] watching ${root}`)
    } catch (err) {
      // Two distinct failure classes land here, both fatal to live-refresh:
      // the dynamic import failing (per-platform native binary missing from
      // the install — the packaged-build regression class) and the native
      // subscribe throwing (permissions, vanished dir, unsupported FS).
      // Don't take the connection down — just lose live-refresh for this
      // dir. Log the stack so the two are tellable apart from the log alone.
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
      console.warn(`[FileWatcher] failed to watch ${root} — Explorer live-refresh disabled: ${detail}`)
      if (this.startEpoch === epoch) {
        // Only reset if still current — a superseding start() owns the state now.
        this.subscription = null
        this.workspaceRoot = null
      }
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
    // win32: nested ignored dirs aren't pruned natively (NATIVE_IGNORE drops
    // the globs to dodge the std::regex overflow — #250); drop their events
    // here instead. Cheap: split + Set lookups per event.
    if (IS_WIN32 && rel.split('/').some((seg) => IGNORED_SEGMENT_SET.has(seg))) return

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
    // Invalidate any in-flight start() so its late-resolving subscribe can't
    // resurrect a subscription after we cleared state (see startEpoch).
    this.startEpoch++
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const sub = this.subscription
    this.subscription = null
    this.workspaceRoot = null
    this.pending.clear()
    if (!sub) return
    // The unsubscribe rides the process-wide chain, so no later subscribe
    // (this or any other instance) starts until it TRULY settles — the native
    // teardown/subscribe overlap is what crashed Windows (0xC0000005). The
    // 2s timeout only unblocks OUR caller (WS close handlers / shutdown must
    // not hang on a wedged watcher); it no longer lets the next subscribe
    // proceed early.
    const settled = enqueueNativeOp(() => sub.unsubscribe()).then(
      () => true,
      (err) => {
        console.warn(`[FileWatcher] unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`)
        return true
      },
    )
    const done = await Promise.race([
      settled,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
    ])
    if (!done) console.warn('[FileWatcher] unsubscribe still pending after 2s — continuing; next subscribe will wait for it')
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

/**
 * Non-recursive `fs.watch` on `~/.halo/global/extensions/` — the one place
 * every install path converges (admin zip upload, `extension` skill's ext.sh,
 * a manual `cp -r`): each ends with a rename INTO or an rm OF a direct child
 * of the root, so watching the root's direct children catches all of them at
 * the cost of a single inode (same reasoning as ws/git-dir-watcher.ts, whose
 * shape this copies). Edits inside an installed extension are deliberately
 * not observed — reinstalling is the supported way to change one.
 *
 * Event burst → 300ms debounce → rescan → broadcast `extension:changed` to
 * every admin socket, but only when the snapshot key actually changed (the
 * installer's `.tmp-*` / `.old-*` staging dirs are skipped by the scanner, so
 * a normal install yields exactly one broadcast). The on / off switch's
 * `.state.json` is a direct child too, so its rename lands here the same way.
 */
import fs, { type FSWatcher } from 'node:fs'
import type { ExtensionsSnapshot } from '@turmind/halo-core/protocol'
import { broadcast } from '../ws/broadcast.js'
import { sttModels } from '../stt/models.js'
import { extensionsRoot, getSnapshot, scanExtensions, snapshotKey } from './registry.js'

let watcher: FSWatcher | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let lastKey = ''

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    rescanAndBroadcast()
  }, 300)
}

/** Rescan; push the full snapshot when it differs from the last one. Also the
 *  entry point routes use after their own writes — they don't broadcast
 *  themselves, the watcher path is the single notifier. */
export function rescanAndBroadcast(): void {
  const snap = scanExtensions()
  reconcileSttModels(snap)
  const key = snapshotKey(snap)
  if (key === lastKey) return
  lastKey = key
  broadcast({ type: 'extension:changed', ...snap })
}

/** An installed `stt-local` extension wants its model files: start the
 *  download unless they are ready or already coming (no-op otherwise). */
function reconcileSttModels(snap: ExtensionsSnapshot): void {
  if (!snap.extensions.some((e) => e.capabilities.includes('stt-local'))) return
  const { state } = sttModels.status()
  if (state !== 'ready' && state !== 'downloading') void sttModels.ensure()
}

function openWatcher(root: string): void {
  try {
    watcher = fs.watch(root, { persistent: false, recursive: false }, () => scheduleFlush())
    // Async 'error' (root removed, EPERM on Windows) without a listener would
    // reach the global uncaughtException handler and leave us silently stale.
    // Close and retry once a second — the root gets recreated by the next
    // install, and until then a rescan of a missing dir is just "empty".
    watcher.on('error', (err) => {
      console.warn(`[Extensions] watch error on ${root}: ${err.message} — retrying in 1s`)
      closeWatcher()
      restartTimer = setTimeout(() => { restartTimer = null; start() }, 1000)
      scheduleFlush()
    })
  } catch (err) {
    console.warn(`[Extensions] failed to watch ${root}: ${err instanceof Error ? err.message : String(err)} — live extension updates disabled`)
    watcher = null
  }
}

function closeWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

/** Create the root if needed, take the initial snapshot (no broadcast — there
 *  is nobody connected yet at boot), and start watching. Idempotent. */
export function start(): void {
  if (watcher) return
  const root = extensionsRoot()
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (err) {
    console.warn(`[Extensions] cannot create ${root}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const snap = scanExtensions()
  lastKey = snapshotKey(snap)
  reconcileSttModels(snap)
  openWatcher(root)
  const { extensions, disabled, errors } = getSnapshot()
  if (extensions.length > 0 || disabled.length > 0 || errors.length > 0) {
    console.log(`[Extensions] ${extensions.length} installed${disabled.length ? `, ${disabled.length} off` : ''}${errors.length ? `, ${errors.length} invalid` : ''}: ${[...extensions.map((e) => `${e.id}@${e.version}`), ...disabled.map((e) => `${e.id}@${e.version}(off)`), ...errors.map((e) => `${e.id}(!)`)].join(', ')}`)
  }
}

export function stop(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
  closeWatcher()
}

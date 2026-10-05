/**
 * Non-recursive `fs.watch` on `~/.halo/global/models.d/` — where `halo models
 * install` (the `/extension models` skill path) atomically renames each hub
 * provider yaml, and where a manual `rm` takes one back out. Same shape as
 * extensions/watcher.ts: event burst → 300ms debounce → drop the registry
 * cache (config.ts) → re-merge → broadcast `models:changed` to every admin
 * socket, but only when the merged view actually changed (the installer's
 * `.tmp-*` staging file isn't a `.yaml`, so one install = one broadcast).
 *
 * `models/` itself isn't watched: only template refresh writes it, and that
 * runs before the registry is first read.
 */
import fs, { type FSWatcher } from 'node:fs'
import { broadcast } from '../ws/broadcast.js'
import { invalidateModelsRegistry } from '../config.js'
import { globalHubModelsDir } from '../paths.js'
import { loadProviders } from './registry.js'

let watcher: FSWatcher | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let lastKey = ''

function snapshot(): { key: string; hub: string[]; total: number } {
  const { effective } = loadProviders()
  return {
    key: JSON.stringify(effective.map((p) => [p.source, p.data])),
    hub: effective.filter((p) => p.source === 'hub').map((p) => `${p.id}@${p.revision}`),
    total: effective.length,
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    reloadAndBroadcast()
  }, 300)
}

/** Drop the cached registry; push `models:changed` when the merged view
 *  differs from the last one. */
export function reloadAndBroadcast(): void {
  invalidateModelsRegistry()
  const snap = snapshot()
  if (snap.key === lastKey) return
  lastKey = snap.key
  console.log(`[Models] models.d changed — registry reloaded: ${snap.total} providers, ${snap.hub.length} from hub${snap.hub.length ? ` (${snap.hub.join(', ')})` : ''}`)
  broadcast({ type: 'models:changed' })
}

function openWatcher(root: string): void {
  try {
    watcher = fs.watch(root, { persistent: false, recursive: false }, () => scheduleFlush())
    // Same recovery as extensions/watcher.ts: an async 'error' without a
    // listener would reach uncaughtException and leave the registry stale.
    watcher.on('error', (err) => {
      console.warn(`[Models] watch error on ${root}: ${err.message} — retrying in 1s`)
      closeWatcher()
      restartTimer = setTimeout(() => { restartTimer = null; start() }, 1000)
      scheduleFlush()
    })
  } catch (err) {
    console.warn(`[Models] failed to watch ${root}: ${err instanceof Error ? err.message : String(err)} — hub model updates need a restart`)
    watcher = null
  }
}

function closeWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

/** Create `models.d/` if needed, take the initial snapshot (no broadcast —
 *  nobody is connected at boot), and start watching. Idempotent. */
export function start(): void {
  if (watcher) return
  const root = globalHubModelsDir()
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (err) {
    console.warn(`[Models] cannot create ${root}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const snap = snapshot()
  lastKey = snap.key
  openWatcher(root)
  if (snap.hub.length > 0) console.log(`[Models] ${snap.hub.length} provider(s) in effect from models.d: ${snap.hub.join(', ')}`)
}

export function stop(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
  closeWatcher()
}

import { useSyncExternalStore } from 'react'
import type { ExtensionInfo, ExtensionsSnapshot } from '@turmind/halo-core/protocol'
import type { PreviewPlugin, Resolved } from './types'

/**
 * Two layers behind one lookup:
 *   - built-in plugins, registered at module load by `plugins/index.ts`
 *   - runtime extensions, the server's `ExtensionsSnapshot` (initial GET +
 *     every `extension:changed` WS frame — see ws-handlers/state-handlers)
 * `resolve(ext)` merges them into the ordered candidate list the editor picks
 * from; the version counter lets render-time consumers re-run when either
 * layer changes.
 */
const builtins = new Map<string, PreviewPlugin>() // ext (lowercase, no dot) → plugin
let snapshot: ExtensionsSnapshot = { extensions: [], errors: [] }

let version = 0
const listeners = new Set<() => void>()
function bump(): void {
  version++
  for (const cb of listeners) cb()
}
export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export function getVersion(): number {
  return version
}
export function useRegistryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

/** Register a built-in plugin. Later calls with the same extension override. */
export function register(plugin: PreviewPlugin): void {
  for (const ext of plugin.extensions) {
    builtins.set(ext.toLowerCase(), plugin)
  }
  bump()
}

/** Replace the runtime-extension layer with the server's current snapshot. */
export function setExtensions(next: ExtensionsSnapshot): void {
  snapshot = next
  bump()
}

export function getExtensionsSnapshot(): ExtensionsSnapshot {
  return snapshot
}

/** Manifest `extensions` carry the dot (`.glb`); the editor passes bare exts. */
function normalize(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '')
}

function extensionsFor(key: string, priority: ExtensionInfo['priority']): Resolved[] {
  const dotted = `.${key}`
  return snapshot.extensions
    .filter((e) => e.priority === priority && e.extensions.includes(dotted))
    .sort((a, b) => b.installedAt - a.installedAt) // newest install first
    .map((info) => ({ kind: 'extension', info }))
}

/**
 * Every way to open a file with this extension, best first:
 *   1. `default` extensions (newest install wins — deliberately not VS Code's
 *      "ask the user": there's nothing to remember the answer in yet)
 *   2. the built-in plugin, if any
 *   3. `option` extensions
 *   4. Open as Text — always present, always last
 * With no extensions installed this is `[builtin, text]` or `[text]`, i.e.
 * exactly the pre-extension behavior.
 */
export function resolve(ext: string): Resolved[] {
  const key = normalize(ext)
  const out: Resolved[] = extensionsFor(key, 'default')
  const plugin = builtins.get(key)
  if (plugin) out.push({ kind: 'builtin', plugin })
  out.push(...extensionsFor(key, 'option'))
  out.push({ kind: 'text' })
  return out
}

/** Stable identity for a candidate — what the "open with" menu remembers. */
export function resolvedKey(r: Resolved): string {
  switch (r.kind) {
    case 'extension': return `extension:${r.info.id}`
    case 'builtin': return `builtin:${r.plugin.id}`
    case 'text': return 'text'
  }
}

/** True when something other than the text editor can show this extension. */
export function canPreview(ext: string): boolean {
  return resolve(ext)[0].kind !== 'text'
}

/**
 * Heavy previews mount active-only instead of staying in the MRU cache. A
 * built-in is heavy when it says so (pptx). A read-only extension is heavy:
 * nothing to lose on unmount, and every viewer iframe may hold a WebGL
 * context (Chrome caps ~16 per page). An extension with `save` stays mounted
 * — its dirty state lives inside the iframe. Judged on the default candidate.
 */
export function isHeavyPreview(ext: string): boolean {
  const first = resolve(ext)[0]
  if (first.kind === 'builtin') return !!first.plugin.heavy
  if (first.kind === 'extension') return !first.info.capabilities.includes('save')
  return false
}

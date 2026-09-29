import { useSyncExternalStore } from 'react'
import type { PreviewPlugin } from './types'

const registry = new Map<string, PreviewPlugin>() // extension → plugin

// Change signal for consumers that derive render-time state from the registry
// (editor-panel's `isHeavyPath` → which previews stay mounted). Built-ins
// register at module load, before any subscriber exists; the hook exists so
// registrations that arrive later re-render those consumers instead of
// leaving them on a stale memoized value.
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

/** Register a plugin. Later calls with the same extension override. */
export function register(plugin: PreviewPlugin): void {
  for (const ext of plugin.extensions) {
    registry.set(ext.toLowerCase(), plugin)
  }
  bump()
}

export function getPlugin(ext: string): PreviewPlugin | undefined {
  return registry.get(ext.toLowerCase())
}

export function canPreview(ext: string): boolean {
  return registry.has(ext.toLowerCase())
}

/** True if a file's ext matches a plugin flagged as heavy (pptx). */
export function isHeavyPreview(ext: string): boolean {
  return !!registry.get(ext.toLowerCase())?.heavy
}

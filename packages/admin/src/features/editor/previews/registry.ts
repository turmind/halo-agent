import type { PreviewPlugin } from './types'

const registry = new Map<string, PreviewPlugin>() // extension → plugin

/** Register a plugin. Later calls with the same extension override. */
export function register(plugin: PreviewPlugin): void {
  for (const ext of plugin.extensions) {
    registry.set(ext.toLowerCase(), plugin)
  }
}

export function getPlugin(ext: string): PreviewPlugin | undefined {
  return registry.get(ext.toLowerCase())
}

export function canPreview(ext: string): boolean {
  return registry.has(ext.toLowerCase())
}

/** All registered extensions — used by editor-panel to decide binary-vs-text routing. */
export function registeredExtensions(): string[] {
  return [...registry.keys()]
}

/** True if a file's ext matches a plugin flagged as heavy (pptx). */
export function isHeavyPreview(ext: string): boolean {
  return !!registry.get(ext.toLowerCase())?.heavy
}

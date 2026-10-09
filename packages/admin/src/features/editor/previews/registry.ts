import { useSyncExternalStore } from 'react'
import type { ExtensionInfo, ExtensionPlatform, ExtensionsSnapshot } from '@turmind/halo-core/protocol'
import { api } from '@/shared/api-client'
import type { PreviewPlugin, Resolved } from './types'

/**
 * Two layers behind one lookup:
 *   - built-in plugins, registered at module load by `plugins/index.ts`
 *   - runtime extensions, the server's `ExtensionsSnapshot` (initial GET via
 *     `loadExtensions()` + every `extension:changed` WS frame — see
 *     ws-handlers/state-handlers)
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

/** Longest a caller waits for the initial list before routing without it. */
const INITIAL_LOAD_WAIT_MS = 3_000
let initialLoad: Promise<void> | null = null

/**
 * The page's initial `GET /extensions`, one request shared by every caller.
 * Until it lands the extension layer is indistinguishable from "nothing
 * installed", so a one-shot routing decision (tab restore after a reload)
 * must await this or a type only an extension handles (`.glb`) resolves to
 * text. Never rejects and is never re-issued: a failed fetch leaves the layer
 * empty (pre-extension routing) so callers proceed without re-delaying later
 * opens; the WS reconnect re-fetch and `extension:changed` frames fill it.
 * The wait is capped at INITIAL_LOAD_WAIT_MS, counted from the first call —
 * a request hung on a dead connection (sleep / wake) would otherwise block
 * every open. Past the cap callers proceed as if nothing were installed, so
 * an extension-only type (`.glb`) opens as text; the request is not
 * cancelled, and a late list still lands via `setExtensions` (bump).
 */
export function loadExtensions(): Promise<void> {
  if (!initialLoad) {
    const listed = api.extensions.list().then(setExtensions).catch((err) => {
      console.error('[PreviewRegistry] Failed to load extensions:', err)
    })
    initialLoad = Promise.race([listed, new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[PreviewRegistry] Extension list not back after ${INITIAL_LOAD_WAIT_MS}ms, opening files without it`)
        resolve()
      }, INITIAL_LOAD_WAIT_MS)
      void listed.finally(() => clearTimeout(timer))
    })])
  }
  return initialLoad
}

export function getExtensionsSnapshot(): ExtensionsSnapshot {
  return snapshot
}

/** Manifest `extensions` carry the dot (`.glb`); the editor passes bare exts. */
function normalize(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '')
}

/** The desktop shell keeps Chromium's UA, which carries `Electron/<ver>`. */
export function detectPlatform(ua: string): ExtensionPlatform {
  if (!ua.includes('Electron/')) return 'web'
  if (/Macintosh|Mac OS X/.test(ua)) return 'desktop-mac'
  if (ua.includes('Windows')) return 'desktop-win'
  return 'desktop-linux'
}

let platform: ExtensionPlatform | null = null
/** Host platform, computed once (prerender has no navigator → 'web', uncached). */
export function currentPlatform(): ExtensionPlatform {
  if (platform) return platform
  if (typeof navigator === 'undefined') return 'web'
  platform = detectPlatform(navigator.userAgent)
  return platform
}

/** "Browser, Mac app" / "浏览器、Mac 客户端" — shared by the no-preview page and
 *  Settings → Extensions (lives here, not in FilePreview, so Settings doesn't
 *  pull in the plugin registrations). */
export function platformLabels(platforms: readonly string[], t: (key: string) => string): string {
  return platforms.map((p) => t(`extensions.platform.${p}`)).join(t('extensions.platform.sep'))
}

/** `platforms` absent = everywhere. An excluded extension routes as if not installed. */
export function runsHere(info: ExtensionInfo): boolean {
  return !info.platforms || info.platforms.includes(currentPlatform())
}

/** `bundle` extensions only open directories, the rest only files; `!!` so a
 *  snapshot without the field (older server) reads as non-bundle. */
function claims(e: ExtensionInfo, key: string, bundle: boolean): boolean {
  return !!e.bundle === bundle && e.extensions.includes(`.${key}`)
}

function extensionsFor(key: string, priority: ExtensionInfo['priority'], bundle = false): Resolved[] {
  return snapshot.extensions
    .filter((e) => e.priority === priority && claims(e, key, bundle) && runsHere(e))
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

/** Candidates for a bundle DIRECTORY (`foo.htrans/`): bundle extensions only
 *  (default → option, newest first). Text stays last only as the "nothing can
 *  open this" terminal (→ fallback page); a directory never opens as text. */
export function resolveBundle(ext: string): Resolved[] {
  const key = normalize(ext)
  return [...extensionsFor(key, 'default', true), ...extensionsFor(key, 'option', true), { kind: 'text' }]
}

/** True when a directory with this name opens as a preview tab instead of
 *  expanding: a `default` bundle extension that runs here claims its suffix.
 *  Dot-less / dot-first names never qualify (`htrans`, `.htrans`). */
export function isBundleName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return extensionsFor(normalize(name.slice(dot + 1)), 'default', true).length > 0
}

/** Installed extensions for this suffix that this platform excludes — what the
 *  fallback page names ("only runs on …"). */
export function excludedByPlatform(ext: string, bundle = false): ExtensionInfo[] {
  const key = normalize(ext)
  return snapshot.extensions.filter((e) => claims(e, key, bundle) && !runsHere(e))
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
 * — its dirty state lives inside the iframe — and so does a bundle extension:
 * switching tabs must not unmount a recording. Judged on the default candidate.
 */
export function isHeavyPreview(ext: string, bundle = false): boolean {
  const first = (bundle ? resolveBundle(ext) : resolve(ext))[0]
  if (first.kind === 'builtin') return !!first.plugin.heavy
  if (first.kind === 'extension') return isReadOnlyViewer(first.info)
  return false
}

/** A single-file extension with nothing to save (no `save`, not a bundle) —
 *  heavy above. */
export function isReadOnlyViewer(info: ExtensionInfo): boolean {
  return !info.capabilities.includes('save') && !info.bundle
}

/** An extension the canvas maximize turns immersive (iframe fills the
 *  viewport, all chrome hidden): anything without `save` — bundles included,
 *  whose state lives in their own directory, not behind a Save button. */
export function isImmersiveViewer(info: ExtensionInfo): boolean {
  return !info.capabilities.includes('save')
}

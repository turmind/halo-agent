/**
 * Canvas preview extensions — scan + validate `~/.halo/global/extensions/`.
 *
 * The directory IS the install: `<root>/<id>/halo-extension.json` present and
 * valid = installed; directory gone = uninstalled. No db table, no registry
 * file — the filesystem is the truth (same model as global skills). This
 * module is the ONLY validator: whoever puts a directory there (the admin's
 * zip upload, the `extension` skill's ext.sh, a manual `cp -r`) gets the same
 * verdict, and an invalid directory is still LISTED (as an error entry) so the
 * admin shows "installed but broken" rather than "not installed". The one
 * piece of user state, the on / off switch, lives beside the dirs in
 * `.state.json` (state.ts) and only splits valid entries into
 * `extensions` / `disabled`.
 *
 * `scanExtensions` runs at boot and whenever extensions/watcher.ts sees the
 * root change — never per request. Routes read the cached snapshot.
 *
 * Design: .halo/tmp/canvas-extensions-design.md §2–§4.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ExtensionActivity, ExtensionBackend, ExtensionCanvasDeclaration, ExtensionCapability, ExtensionChatbar, ExtensionError, ExtensionInfo, ExtensionPlatform, ExtensionSettingField, ExtensionSettings, ExtensionsSnapshot } from '@turmind/halo-core/protocol'
import { globalExtensionsDir } from '../paths.js'
import { backendIsolation } from '../tools/sandbox.js'
import { confirmedBackendIds, disabledExtensionIds, dropBackendConfirmations } from './state.js'

export const MANIFEST_FILE = 'halo-extension.json'

// halo-hub/scripts/pack.mjs mirrors these rules; test/extension-manifest-rules-drift.test.ts trips on change
/** Extension ids are directory names AND URL segments: lowercase slug only —
 *  tighter than routes/workspace-path.ts isSafeIdSegment (which admits `.`,
 *  `:`, `>` for session ids), so `.tmp-*` / `.old-*` staging dirs can never
 *  collide with a real id. Shared with ext.sh's regex — keep in sync. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const FILE_EXT_RE = /^\.[a-z0-9]+$/
const CAPABILITIES: ReadonlySet<string> = new Set<ExtensionCapability>(['save', 'media', 'transcribe', 'fs-read'])
const PLATFORMS: ReadonlySet<string> = new Set<ExtensionPlatform>(['web', 'desktop-mac', 'desktop-win', 'desktop-linux'])
/** Settings keys become the leaf of `ext-<id>.{params|secrets}.<key>`. */
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/
const SETTING_TYPES: ReadonlySet<string> = new Set(['string', 'int', 'float', 'boolean', 'enum'])

/** Strict `settings` validation (skills' config.yaml parsing is lenient; a
 *  manifest is the extension author's contract, so a bad field is a red row). */
function parseSettings(raw: unknown): ExtensionSettings | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'settings must be an object' }
  const s = raw as Record<string, unknown>
  const seen = new Set<string>()
  const out: ExtensionSettings = {}
  for (const kind of ['params', 'secrets'] as const) {
    if (s[kind] === undefined) continue
    if (!Array.isArray(s[kind])) return { error: `settings.${kind} must be an array` }
    const fields: ExtensionSettingField[] = []
    for (const item of s[kind] as unknown[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return { error: `settings.${kind} entries must be objects` }
      const f = item as Record<string, unknown>
      if (typeof f.key !== 'string' || !SETTING_KEY_RE.test(f.key)) return { error: `settings key "${String(f.key)}" must match ^[a-z][a-z0-9_]{0,63}$` }
      if (seen.has(f.key)) return { error: `duplicate settings key: ${f.key}` }
      seen.add(f.key)
      for (const k of ['description', 'description_zh'] as const) {
        if (f[k] !== undefined && typeof f[k] !== 'string') return { error: `settings ${f.key}.${k} must be a string` }
      }
      // JSON `"default": 16000` is natural to write — stringify scalars like
      // the skill config.yaml parser does; objects/arrays are malformed.
      if (f.default !== undefined && !['string', 'number', 'boolean'].includes(typeof f.default)) return { error: `settings ${f.key}.default must be a scalar` }
      if (f.type !== undefined && (typeof f.type !== 'string' || !SETTING_TYPES.has(f.type))) return { error: `settings ${f.key}.type must be one of string|int|float|boolean|enum` }
      if (f.options !== undefined && (!Array.isArray(f.options) || f.options.length === 0 || f.options.some((o) => typeof o !== 'string'))) {
        return { error: `settings ${f.key}.options must be a non-empty string array` }
      }
      if (f.type === 'enum' && f.options === undefined) return { error: `settings ${f.key}: type enum requires options` }
      fields.push({
        key: f.key,
        ...(f.description !== undefined ? { description: f.description as string } : {}),
        ...(f.description_zh !== undefined ? { description_zh: f.description_zh as string } : {}),
        ...(f.default !== undefined ? { default: String(f.default) } : {}),
        ...(f.type !== undefined ? { type: f.type as ExtensionSettingField['type'] } : {}),
        ...(f.options !== undefined ? { options: f.options as string[] } : {}),
      })
    }
    if (fields.length > 0) out[kind] = fields
  }
  return out
}

export function isExtensionId(id: string): boolean {
  return ID_RE.test(id)
}

/** Root directory; resolved per call so tests can redirect HOME. */
export function extensionsRoot(): string {
  return globalExtensionsDir()
}

/** Pure manifest validation. `dirName` is the directory the manifest came
 *  from (must equal manifest.id); `entryExists` lets the caller supply the
 *  filesystem check so this stays unit-testable without a disk layout. */
export function parseManifest(
  raw: unknown,
  dirName: string,
  entryExists: (entry: string) => boolean,
): Omit<ExtensionInfo, 'installedAt'> | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'manifest must be a JSON object' }
  const m = raw as Record<string, unknown>

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return { error: 'id must match ^[a-z0-9][a-z0-9_-]{0,63}$' }
  if (m.id !== dirName) return { error: `id mismatch: manifest "${m.id}" vs directory "${dirName}"` }
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > 64) return { error: 'name must be a non-empty string (≤ 64 chars)' }
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return { error: 'version must be semver (x.y.z[-pre])' }
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 200)) return { error: 'description must be a string (≤ 200 chars)' }

  let activity: ExtensionActivity | undefined
  if (m.activity !== undefined) {
    if (typeof m.activity !== 'object' || m.activity === null || Array.isArray(m.activity)) return { error: 'activity must be an object' }
    const a = m.activity as Record<string, unknown>
    activity = { order: 100 }
    if (a.icon !== undefined) {
      if (typeof a.icon !== 'string' || a.icon === '' || a.icon.startsWith('/') || a.icon.split(/[\\/]/).includes('..') || !/\.(svg|png)$/i.test(a.icon)) {
        return { error: 'activity.icon must be a relative .svg or .png path inside the extension directory' }
      }
      if (!entryExists(a.icon)) return { error: `activity icon not found: ${a.icon}` }
      activity.icon = a.icon
    }
    for (const k of ['title', 'title_zh'] as const) {
      const v = a[k]
      if (v === undefined) continue
      if (typeof v !== 'string' || v.trim() === '' || v.length > 64) return { error: `activity.${k} must be a non-empty string (≤ 64 chars)` }
      activity[k] = v
    }
    for (const k of ['description', 'description_zh'] as const) {
      const v = a[k]
      if (v === undefined) continue
      if (typeof v !== 'string' || v.length > 200) return { error: `activity.${k} must be a string (≤ 200 chars)` }
      activity[k] = v
    }
    if (a.order !== undefined) {
      if (typeof a.order !== 'number' || !Number.isInteger(a.order) || a.order < 0 || a.order > 1000) return { error: 'activity.order must be an integer 0–1000' }
      activity.order = a.order
    }
  }

  let chatbar: ExtensionChatbar | undefined
  if (m.chatbar !== undefined) {
    if (typeof m.chatbar !== 'object' || m.chatbar === null || Array.isArray(m.chatbar)) return { error: 'chatbar must be an object' }
    const c = m.chatbar as Record<string, unknown>
    chatbar = { height: 160, order: 100 }
    if (c.icon !== undefined) {
      if (typeof c.icon !== 'string' || c.icon === '' || c.icon.startsWith('/') || c.icon.split(/[\\/]/).includes('..') || !/\.(svg|png)$/i.test(c.icon)) {
        return { error: 'chatbar.icon must be a relative .svg or .png path inside the extension directory' }
      }
      if (!entryExists(c.icon)) return { error: `chatbar icon not found: ${c.icon}` }
      chatbar.icon = c.icon
    }
    for (const k of ['title', 'title_zh'] as const) {
      const v = c[k]
      if (v === undefined) continue
      if (typeof v !== 'string' || v.trim() === '' || v.length > 64) return { error: `chatbar.${k} must be a non-empty string (≤ 64 chars)` }
      chatbar[k] = v
    }
    if (c.height !== undefined) {
      if (typeof c.height !== 'number' || !Number.isInteger(c.height) || c.height < 80 || c.height > 480) return { error: 'chatbar.height must be an integer 80–480' }
      chatbar.height = c.height
    }
    if (c.order !== undefined) {
      if (typeof c.order !== 'number' || !Number.isInteger(c.order) || c.order < 0 || c.order > 1000) return { error: 'chatbar.order must be an integer 0–1000' }
      chatbar.order = c.order
    }
  }

  let canvas: ExtensionCanvasDeclaration | undefined
  if (m.canvas !== undefined) {
    if (typeof m.canvas !== 'object' || m.canvas === null || Array.isArray(m.canvas)) return { error: 'canvas must be an object' }
    const c = m.canvas as Record<string, unknown>
    canvas = {}
    if (c.icon !== undefined) {
      if (typeof c.icon !== 'string' || c.icon === '' || c.icon.startsWith('/') || c.icon.split(/[\\/]/).includes('..') || !/\.(svg|png)$/i.test(c.icon)) {
        return { error: 'canvas.icon must be a relative .svg or .png path inside the extension directory' }
      }
      if (!entryExists(c.icon)) return { error: `canvas icon not found: ${c.icon}` }
      canvas.icon = c.icon
    }
    for (const k of ['title', 'title_zh'] as const) {
      const v = c[k]
      if (v === undefined) continue
      if (typeof v !== 'string' || v.trim() === '' || v.length > 64) return { error: `canvas.${k} must be a non-empty string (≤ 64 chars)` }
      canvas[k] = v
    }
  }

  let backend: ExtensionBackend | undefined
  if (m.backend !== undefined) {
    if (typeof m.backend !== 'object' || m.backend === null || Array.isArray(m.backend)) return { error: 'backend must be an object' }
    const b = m.backend as Record<string, unknown>
    if (typeof b.entry !== 'string' || b.entry === '' || b.entry.startsWith('/') || b.entry.split(/[\\/]/).includes('..') || !/\.(js|mjs|cjs)$/.test(b.entry)) {
      return { error: 'backend.entry must be a relative .js / .mjs / .cjs path inside the extension directory' }
    }
    if (!entryExists(b.entry)) return { error: `backend entry not found: ${b.entry}` }
    backend = { entry: b.entry }
  }

  // The key stays required even for a file-less extension (`[]`):
  // the `extension` skill's ext.sh pre-check demands it.
  if (activity || chatbar || canvas) {
    if (!Array.isArray(m.extensions)) return { error: 'extensions must be an array (empty is fine with activity, chatbar or canvas)' }
  } else if (!Array.isArray(m.extensions) || m.extensions.length === 0) return { error: 'extensions must be a non-empty array' }
  for (const e of m.extensions) {
    if (typeof e !== 'string' || !FILE_EXT_RE.test(e)) return { error: `extensions entry "${String(e)}" must look like ".glb" (lowercase, with dot)` }
  }

  if (typeof m.entry !== 'string' || m.entry === '' || m.entry.startsWith('/') || m.entry.split(/[\\/]/).includes('..')) {
    return { error: 'entry must be a relative path inside the extension directory' }
  }
  if (!entryExists(m.entry)) return { error: `entry not found: ${m.entry}` }

  let priority: ExtensionInfo['priority'] = 'default'
  if (m.priority !== undefined) {
    if (m.priority !== 'default' && m.priority !== 'option') return { error: 'priority must be "default" or "option"' }
    priority = m.priority
  }

  const capabilities: ExtensionCapability[] = []
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) return { error: 'capabilities must be an array' }
    for (const cap of m.capabilities) {
      // Unknown → reject rather than ignore: an extension that declared `x`
      // and had the host silently drop it is harder to debug than a red row.
      if (typeof cap !== 'string' || !CAPABILITIES.has(cap)) return { error: `unknown capability: ${String(cap)}` }
      if (!capabilities.includes(cap as ExtensionCapability)) capabilities.push(cap as ExtensionCapability)
    }
  }

  // bundle = every suffix names a DIRECTORY; the extension gets scoped `fs`
  // frames instead of load/save, so `save` makes no sense alongside it.
  if (m.bundle !== undefined && typeof m.bundle !== 'boolean') return { error: 'bundle must be a boolean' }
  const bundle = m.bundle === true
  if (bundle && capabilities.includes('save')) return { error: 'bundle extensions cannot declare save' }

  let platforms: ExtensionPlatform[] | undefined
  if (m.platforms !== undefined) {
    if (!Array.isArray(m.platforms) || m.platforms.length === 0) return { error: 'platforms must be a non-empty array' }
    platforms = []
    for (const p of m.platforms) {
      if (typeof p !== 'string' || !PLATFORMS.has(p)) return { error: `unknown platform: ${String(p)}` }
      if (!platforms.includes(p as ExtensionPlatform)) platforms.push(p as ExtensionPlatform)
    }
  }

  let settings: ExtensionSettings | undefined
  if (m.settings !== undefined) {
    const parsed = parseSettings(m.settings)
    if ('error' in parsed) return parsed
    if (parsed.params || parsed.secrets) settings = parsed
  }

  if (m.homepage !== undefined && (typeof m.homepage !== 'string' || !/^https?:\/\//.test(m.homepage))) return { error: 'homepage must be an http(s) URL' }
  if (m.license !== undefined && typeof m.license !== 'string') return { error: 'license must be a string' }
  if (m.source !== undefined && (typeof m.source !== 'string' || !/^https:\/\/\S+$/.test(m.source) || !URL.canParse(m.source))) return { error: 'source must be an https URL (of the update.json)' }

  return {
    id: m.id,
    name: m.name,
    version: m.version,
    ...(m.description !== undefined ? { description: m.description } : {}),
    extensions: m.extensions as string[],
    entry: m.entry,
    priority,
    capabilities,
    bundle,
    ...(platforms ? { platforms } : {}),
    ...(settings ? { settings } : {}),
    ...(activity ? { activity } : {}),
    ...(chatbar ? { chatbar } : {}),
    ...(canvas ? { canvas } : {}),
    ...(backend ? { backend } : {}),
    ...(m.homepage !== undefined ? { homepage: m.homepage } : {}),
    ...(m.license !== undefined ? { license: m.license } : {}),
    ...(m.source !== undefined ? { source: m.source } : {}),
  }
}

/** Validate one installed directory. Exported for install.ts's pre-check
 *  (same rules, so a package that would scan as an error is refused before
 *  it replaces a working install); the installer passes the id explicitly
 *  because its staging dir is not yet named after the extension. */
export function readExtensionDir(dir: string, id: string = path.basename(dir)): ExtensionInfo | ExtensionError {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf-8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { id, error: code === 'ENOENT' ? `${MANIFEST_FILE} missing` : `${MANIFEST_FILE} unreadable: ${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = parseManifest(raw, id, (entry) => {
    try { return fs.statSync(path.join(dir, entry)).isFile() } catch { return false }
  })
  if ('error' in parsed) return { id, error: parsed.error }
  // Directory mtime: the installer's final rename refreshes it, so a
  // reinstall counts as "newer" for the admin's newest-default-wins rule.
  let installedAt = 0
  try { installedAt = Math.round(fs.statSync(dir).mtimeMs) } catch { /* raced with an uninstall — 0 sorts last */ }
  // The admin's confirmation lives in .state.json, not the manifest; the
  // isolation is this host's (tools/sandbox.ts).
  if (parsed.backend) {
    parsed.backend.confirmed = confirmedBackendIds().has(id)
    parsed.backend.isolation = backendIsolation()
  }
  return { ...parsed, installedAt }
}

/** backend.ts registers its restart-budget lookup (registry can't import it:
 *  backend.ts imports this module). Unset in CLI / TUI processes. */
let backendFailure: ((ext: ExtensionInfo) => string | undefined) | undefined
export function setBackendFailureLookup(fn: (ext: ExtensionInfo) => string | undefined): void {
  backendFailure = fn
}

let snapshot: ExtensionsSnapshot = { extensions: [], disabled: [], errors: [] }

/** An installer staging dir (`.tmp-<id>-<rand>` / `.old-<id>-<rand>`,
 *  install.ts and ext.sh) older than this is a leftover of an interrupted
 *  install, not one in flight (a swap is a few renames; the unpack before it
 *  is bounded by the 100 MB zip cap). Judged by the later of mtime and
 *  ctime: `.old-<id>-*` is the old `<id>/` renamed (and `.tmp-<id>-*` an
 *  unzipped tree, whose dir mtimes unzip restores), so its mtime can be
 *  months old — the rename only bumps ctime. */
export const STAGING_MAX_AGE_MS = 10 * 60_000
const STAGING_RE = /^\.(?:tmp|old)-(.+)-[0-9a-z]+$/

function stagingAge(root: string, name: string): number {
  try {
    const st = fs.statSync(path.join(root, name))
    return Date.now() - Math.max(st.mtimeMs, st.ctimeMs)
  } catch { return Infinity }
}

/** Drop the backend confirmation of every id whose `<id>/` is not on disk
 *  any more, unless an installer rename is in flight for it (`.tmp-<id>-*` /
 *  `.old-<id>-*` younger than STAGING_MAX_AGE_MS — `<id>/` is about to be
 *  back). */
function dropGoneConfirmations(root: string, entries: fs.Dirent[]): void {
  const present = new Set<string>()
  for (const e of entries) {
    if (!e.isDirectory()) continue
    present.add(e.name)
    const staged = STAGING_RE.exec(e.name)
    if (staged && stagingAge(root, e.name) < STAGING_MAX_AGE_MS) present.add(staged[1])
  }
  const gone = [...confirmedBackendIds()].filter((id) => !present.has(id))
  if (gone.length === 0) return
  try {
    if (dropBackendConfirmations(gone)) console.log(`[Extensions] backend confirmation dropped (no longer installed): ${gone.join(', ')}`)
  } catch (err) {
    console.warn(`[Extensions] could not drop the backend confirmation of ${gone.join(', ')}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Boot: remove installer staging dirs (`.tmp-*` / `.old-*`) older than
 *  STAGING_MAX_AGE_MS — what an install interrupted by a crash or a kill
 *  left behind. A younger one may be another process's install in flight
 *  (ext.sh, a second server on the same HOME) and stays. */
export function removeStaleStagingDirs(): void {
  const root = extensionsRoot()
  let names: string[]
  try { names = fs.readdirSync(root) } catch { return }
  for (const name of names) {
    if (!/^\.(?:tmp|old)-/.test(name) || stagingAge(root, name) < STAGING_MAX_AGE_MS) continue
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      console.log(`[Extensions] removed leftover staging dir ${name}`)
    } catch (err) {
      console.warn(`[Extensions] could not remove leftover staging dir ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Scan the root and replace the cached snapshot. Missing root = empty.
 *  Valid extensions the user switched off (state.ts) go to `disabled`.
 *  A backend confirmation whose `<id>/` is gone from disk — uninstalled by
 *  any means, a manual `rm -rf` with the server down included — is dropped
 *  here, so the same id put back after a rescan asks again; an id mid-swap
 *  (installer staging dir younger than STAGING_MAX_AGE_MS) keeps it. The
 *  disk is the truth, not a process's memory: this runs at boot and on every
 *  watcher rescan. Not a guarantee for filesystem edits between two scans or
 *  with the server down — whoever can write the root can write .state.json. */
export function scanExtensions(): ExtensionsSnapshot {
  const root = extensionsRoot()
  let entries: fs.Dirent[] | null = null
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch { /* root not created yet — nothing installed */ }
  // An unreadable root drops nothing: "can't list" is not "uninstalled".
  if (entries) dropGoneConfirmations(root, entries)
  const off = disabledExtensionIds()
  const extensions: ExtensionInfo[] = []
  const disabled: ExtensionInfo[] = []
  const errors: ExtensionError[] = []
  for (const entry of entries ?? []) {
    // `.tmp-<id>-<rand>` / `.old-<id>-<rand>` are the installer's staging
    // dirs (in flight or about to be removed); never list them.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!ID_RE.test(entry.name)) {
      errors.push({ id: entry.name, error: 'directory name is not a valid extension id' })
      continue
    }
    const result = readExtensionDir(path.join(root, entry.name))
    if ('error' in result) errors.push(result)
    else if (off.has(result.id)) disabled.push(result)
    else {
      // The running server's restart budget (backend.ts); switching it off
      // resets that, so only an on extension can show it.
      const failed = result.backend && backendFailure?.(result)
      if (failed) result.backend!.failed = failed
      extensions.push(result)
    }
  }
  extensions.sort((a, b) => a.id.localeCompare(b.id))
  disabled.sort((a, b) => a.id.localeCompare(b.id))
  errors.sort((a, b) => a.id.localeCompare(b.id))
  snapshot = { extensions, disabled, errors }
  return snapshot
}

export function getSnapshot(): ExtensionsSnapshot {
  return snapshot
}

/** Installed, valid and switched ON extension by id, or undefined. A
 *  switched-off one counts as not installed (the proxies' handshakes, the
 *  backend gate) — use getInstalledExtension where off still counts. */
export function getExtension(id: string): ExtensionInfo | undefined {
  return snapshot.extensions.find((e) => e.id === id)
}

/** Installed and valid, on or off: asset serving (a dirty tab kept open on a
 *  switched-off extension may still lazy-load assets) and the on / off route. */
export function getInstalledExtension(id: string): ExtensionInfo | undefined {
  return getExtension(id) ?? snapshot.disabled.find((e) => e.id === id)
}

/** Cheap change detection for the watcher: id@version per extension, the
 *  switched-off ones marked `-`, an unconfirmed backend marked `?`, plus the
 *  error list. Staging-dir churn during an install produces identical keys
 *  (staging dirs are skipped), so no spurious broadcast. */
export function snapshotKey(s: ExtensionsSnapshot): string {
  const key = (e: ExtensionInfo) => `${e.id}@${e.version}#${e.installedAt}${e.backend && !e.backend.confirmed ? '?' : ''}${e.backend?.failed ? `!${e.backend.failed}` : ''}`
  return [
    ...s.extensions.map(key),
    ...s.disabled.map((e) => `-${key(e)}`),
    ...s.errors.map((e) => `!${e.id}:${e.error}`),
  ].join('\n')
}

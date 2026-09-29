/**
 * Canvas preview extensions — scan + validate `~/.halo/global/extensions/`.
 *
 * The directory IS the install: `<root>/<id>/halo-extension.json` present and
 * valid = installed; directory gone = uninstalled. No db table, no registry
 * file — the filesystem is the truth (same model as global skills). This
 * module is the ONLY validator: whoever puts a directory there (the admin's
 * zip upload, the `extension` skill's ext.sh, a manual `cp -r`) gets the same
 * verdict, and an invalid directory is still LISTED (as an error entry) so the
 * admin shows "installed but broken" rather than "not installed".
 *
 * `scanExtensions` runs at boot and whenever extensions/watcher.ts sees the
 * root change — never per request. Routes read the cached snapshot.
 *
 * Design: .halo/tmp/canvas-extensions-design.md §2–§4.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ExtensionCapability, ExtensionError, ExtensionInfo, ExtensionsSnapshot } from '@turmind/halo-core/protocol'
import { globalExtensionsDir } from '../paths.js'

export const MANIFEST_FILE = 'halo-extension.json'

/** Extension ids are directory names AND URL segments: lowercase slug only —
 *  tighter than routes/workspace-path.ts isSafeIdSegment (which admits `.`,
 *  `:`, `>` for session ids), so `.tmp-*` / `.old-*` staging dirs can never
 *  collide with a real id. Shared with ext.sh's regex — keep in sync. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const FILE_EXT_RE = /^\.[a-z0-9]+$/
const CAPABILITIES: ReadonlySet<string> = new Set<ExtensionCapability>(['save'])

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

  if (!Array.isArray(m.extensions) || m.extensions.length === 0) return { error: 'extensions must be a non-empty array' }
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

  if (m.homepage !== undefined && (typeof m.homepage !== 'string' || !/^https?:\/\//.test(m.homepage))) return { error: 'homepage must be an http(s) URL' }
  if (m.license !== undefined && typeof m.license !== 'string') return { error: 'license must be a string' }

  return {
    id: m.id,
    name: m.name,
    version: m.version,
    ...(m.description !== undefined ? { description: m.description } : {}),
    extensions: m.extensions as string[],
    entry: m.entry,
    priority,
    capabilities,
    ...(m.homepage !== undefined ? { homepage: m.homepage } : {}),
    ...(m.license !== undefined ? { license: m.license } : {}),
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
  return { ...parsed, installedAt }
}

let snapshot: ExtensionsSnapshot = { extensions: [], errors: [] }

/** Scan the root and replace the cached snapshot. Missing root = empty. */
export function scanExtensions(): ExtensionsSnapshot {
  const root = extensionsRoot()
  const extensions: ExtensionInfo[] = []
  const errors: ExtensionError[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch { /* root not created yet — nothing installed */ }
  for (const entry of entries) {
    // `.tmp-<id>-<rand>` / `.old-<id>-<rand>` are the installer's staging
    // dirs (in flight or about to be removed); never list them.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!ID_RE.test(entry.name)) {
      errors.push({ id: entry.name, error: 'directory name is not a valid extension id' })
      continue
    }
    const result = readExtensionDir(path.join(root, entry.name))
    if ('error' in result) errors.push(result)
    else extensions.push(result)
  }
  extensions.sort((a, b) => a.id.localeCompare(b.id))
  errors.sort((a, b) => a.id.localeCompare(b.id))
  snapshot = { extensions, errors }
  return snapshot
}

export function getSnapshot(): ExtensionsSnapshot {
  return snapshot
}

/** Installed (valid) extension by id, or undefined. */
export function getExtension(id: string): ExtensionInfo | undefined {
  return snapshot.extensions.find((e) => e.id === id)
}

/** Cheap change detection for the watcher: id@version per extension plus the
 *  error list. Staging-dir churn during an install produces identical keys
 *  (staging dirs are skipped), so no spurious broadcast. */
export function snapshotKey(s: ExtensionsSnapshot): string {
  return [
    ...s.extensions.map((e) => `${e.id}@${e.version}#${e.installedAt}`),
    ...s.errors.map((e) => `!${e.id}:${e.error}`),
  ].join('\n')
}

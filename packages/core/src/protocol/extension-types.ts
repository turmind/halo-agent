/**
 * Canvas preview extensions — the installed-extension shape shared by the
 * server's scanner (packages/server/src/extensions/registry.ts, which parses
 * `~/.halo/global/extensions/<id>/halo-extension.json`), the
 * `extension:changed` WS frame and the admin's preview registry.
 *
 * Field rules mirror the manifest table in the design doc
 * (.halo/tmp/canvas-extensions-design.md §3); the server is the only
 * validator — the admin trusts what arrives here.
 */

/** Manifest `capabilities` values the host understands. Unknown values are a
 *  manifest error on the server, so this union is exhaustive on the wire. */
export type ExtensionCapability = 'save'

/** `default` opens matching files directly (ahead of built-in plugins);
 *  `option` only appears in the "open with" menu. */
export type ExtensionPriority = 'default' | 'option'

export interface ExtensionInfo {
  /** Directory name under `~/.halo/global/extensions/`; must equal manifest.id. */
  id: string
  name: string
  /** semver string, compared for equality only; part of the static asset URL
   *  `/api/extensions/<id>/<version>/…` so a bump busts browser caches. */
  version: string
  description?: string
  /** Lower-case file extensions including the dot, e.g. `['.glb']`. */
  extensions: string[]
  /** HTML entry relative to the extension directory. */
  entry: string
  priority: ExtensionPriority
  capabilities: ExtensionCapability[]
  homepage?: string
  license?: string
  /** Extension directory mtime (ms). Among several `default` extensions for
   *  the same file extension the newest install wins. */
  installedAt: number
}

/** A directory the scanner refused; still listed so the admin can show and
 *  uninstall it. `id` is the directory name (the manifest may be unreadable). */
export interface ExtensionError {
  id: string
  error: string
}

export interface ExtensionsSnapshot {
  extensions: ExtensionInfo[]
  errors: ExtensionError[]
}

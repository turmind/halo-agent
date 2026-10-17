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
 *  manifest error on the server, so this union is exhaustive on the wire.
 *  `media` = iframe gets `allow="microphone; display-capture; clipboard-write"`;
 *  `transcribe` = may open the server's `/api/transcribe/stream` WS proxy;
 *  `fs-read` = read-only `fs` over the workspace (`scope: 'workspace'`) and
 *  the whole machine (`scope: 'system'`) + the host file picker (`pick`),
 *  bundle or not;
 *  `stt-local` = may open the server's `/api/stt/stream` WS (on-device
 *  SenseVoice speech-to-text, no cloud credentials). */
export type ExtensionCapability = 'save' | 'media' | 'transcribe' | 'fs-read' | 'stt-local'

/** One declared `settings.params[]` / `settings.secrets[]` entry — same field
 *  format as a skill's `config.yaml`. Declarations only: values live in the
 *  global settings.yaml under `ext-<id>.{params|secrets}.<key>` and never
 *  travel on this wire. */
export interface ExtensionSettingField {
  key: string
  description?: string
  description_zh?: string
  default?: string
  type?: 'string' | 'int' | 'float' | 'boolean' | 'enum'
  options?: string[]
}

export interface ExtensionSettings {
  params?: ExtensionSettingField[]
  secrets?: ExtensionSettingField[]
}

/** Where an extension may run: `web` = any normal browser, `desktop-*` = the
 *  Halo desktop shell on that OS. */
export type ExtensionPlatform = 'web' | 'desktop-mac' | 'desktop-win' | 'desktop-linux'

/** `default` opens matching files directly (ahead of built-in plugins);
 *  `option` only appears in the "open with" menu. */
export type ExtensionPriority = 'default' | 'option'

/** Manifest `activity`: one admin activity-bar button that opens the
 *  extension's `entry` as a full-width page (no file, `init.view: 'activity'`).
 *  `icon` = relative `.svg` / `.png` inside the extension dir, rendered as a
 *  CSS mask in the bar's current colour (absent = generic puzzle icon).
 *  `title` / `description` fall back to the top-level `name` / `description`;
 *  `_zh` variants are used when the admin UI is Chinese. Buttons sort by
 *  `order` (default 100), then id. */
export interface ExtensionActivity {
  icon?: string
  title?: string
  title_zh?: string
  description?: string
  description_zh?: string
  order: number
}

/** Manifest `chatbar`: one button on the chat input toolbar that opens the
 *  extension's `entry` in a small panel above the input (`init.view:
 *  'chatbar'`); the extension may only `insert-text` into the draft at the
 *  caret — never send. `icon` / `title` / `title_zh` as in `activity` (no
 *  icon = generic mic). `height` = panel height in px (80–480, default 160).
 *  Buttons sort by `order` (default 100), then id. */
export interface ExtensionChatbar {
  icon?: string
  title?: string
  title_zh?: string
  height: number
  order: number
}

export interface ExtensionInfo {
  /** Directory name under `~/.halo/global/extensions/`; must equal manifest.id. */
  id: string
  name: string
  /** semver string, compared for equality only; part of the static asset URL
   *  `/api/extensions/<id>/<version>/…` so a bump busts browser caches. */
  version: string
  description?: string
  /** Lower-case file extensions including the dot, e.g. `['.glb']`. Empty
   *  only for an `activity` / `chatbar` extension that opens no files. */
  extensions: string[]
  /** HTML entry relative to the extension directory. */
  entry: string
  priority: ExtensionPriority
  capabilities: ExtensionCapability[]
  /** true = every suffix in `extensions` names a DIRECTORY (`foo.htrans/`);
   *  the extension gets scoped `fs` frames instead of `load`/`save`. */
  bundle: boolean
  /** Absent = runs everywhere. */
  platforms?: ExtensionPlatform[]
  /** Declared config fields; absent = none. Rendered as a Settings section. */
  settings?: ExtensionSettings
  /** Activity-bar entry; absent = none (a pure file viewer). */
  activity?: ExtensionActivity
  /** Chat-input toolbar button; absent = none. */
  chatbar?: ExtensionChatbar
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
  /** Valid and switched on — the only list the host offers anywhere. */
  extensions: ExtensionInfo[]
  /** Valid but switched off (Settings → Extensions; server
   *  extensions/state.ts): treated as not installed everywhere except the
   *  Settings list, files and settings values kept. Sorted by id. */
  disabled: ExtensionInfo[]
  errors: ExtensionError[]
}

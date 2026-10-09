/**
 * Canvas preview extension protocol — the `postMessage` frames between the
 * admin's iframe host (packages/admin/src/features/editor/previews/extension-host*)
 * and an installed extension running in a sandboxed iframe.
 *
 * Every frame carries `haloExt: 1` so both sides can drop unrelated messages;
 * origin can't be used for that (every extension iframe on the page shares the
 * admin's origin), so receivers additionally check `e.source` against the
 * expected window. `ArrayBuffer` payloads are meant to be transferred, not
 * copied. Sequence and error handling: design doc §6
 * (.halo/tmp/canvas-extensions-design.md).
 */
import type { ExtensionCapability, ExtensionPlatform } from './extension-types.js'

export const EXTENSION_PROTOCOL_VERSION = 1

/** Marker field present on every frame in both directions. */
export interface ExtensionFrameBase {
  haloExt: 1
}

/** Light or dark — derived by the host from the rendered `--background`
 *  luminance, not from the admin theme's name. */
export type ExtensionTheme = 'light' | 'dark'
export type ExtensionLang = 'zh' | 'en'

/** The admin's semantic palette: every admin theme defines these CSS
 *  variables (`--<token>` in globals.css, shadcn naming). The host forwards
 *  the current values verbatim, so a new admin theme needs no host or
 *  extension change. */
export const EXTENSION_THEME_TOKENS = [
  'background', 'foreground', 'card', 'card-foreground', 'border', 'input',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground',
  'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'ring',
] as const
export type ExtensionThemeToken = (typeof EXTENSION_THEME_TOKENS)[number]
/** token → CSS color string; a token the admin theme leaves empty is omitted. */
export type ExtensionThemeVars = Partial<Record<ExtensionThemeToken, string>>

/** Scoped file access. Without `scope`: bundle extensions only, inside the
 *  bundle directory, every op. With a scope (capability `fs-read`, bundle or
 *  not): `read` / `stat` / `list` only — `write` / `append` → `denied`.
 *  Paths: no scope / `'workspace'` = POSIX relative to the bundle dir /
 *  workspace root — no leading `/`, no `.`/`..`/empty segments, `list` also
 *  accepts `''` = that root. `'system'` = an absolute, normalized path on the
 *  server machine (POSIX `/…`, Windows `C:/…` with forward slashes), no `..`. */
export type ExtensionFsOp = 'read' | 'write' | 'append' | 'list' | 'stat'
export type ExtensionFsScope = 'workspace' | 'system'
export type ExtensionFsErrorCode = 'not-found' | 'invalid-path' | 'denied' | 'io'
export interface ExtensionFsEntry { name: string; type: 'file' | 'directory' }
export type ExtensionPickErrorCode = 'cancelled' | 'denied'

// ── Host → Extension ─────────────────────────────────────────────────

export type ExtensionHostFrame =
  // sent once, right after the extension's `ready`
  | (ExtensionFrameBase & {
      type: 'init'
      protocol: typeof EXTENSION_PROTOCOL_VERSION
      /** For a bundle: name / workspace-relative path of the DIRECTORY. */
      file: { name: string; path: string; size: number; ext: string }
      /** Capabilities the host grants this extension (manifest ∩ host support). */
      capabilities: ExtensionCapability[]
      theme: ExtensionTheme
      /** Current admin palette. Always sent by this host; older hosts omit it. */
      themeVars: ExtensionThemeVars
      /** true for bundle extensions — no `load` frame follows; use `fs`. */
      bundle: boolean
      platform: ExtensionPlatform
      lang: ExtensionLang
      /** true = this host accepts `export` frames (save-capable, non-bundle
       *  extension); older hosts omit it — show export UI only when true. */
      export: boolean
    })
  // file bytes; after `init`, and again on external change while not dirty
  // (never sent to bundle extensions)
  | (ExtensionFrameBase & { type: 'load'; buffer: ArrayBuffer; mtime: number })
  // exactly one reply per `fs` request, same `id`
  | (ExtensionFrameBase & {
      type: 'fs-result'
      id: number
      ok: true
      /** read (transferred) */
      buffer?: ArrayBuffer
      /** list */
      entries?: ExtensionFsEntry[]
      /** stat / write / append */
      size?: number
      mtime?: number
    })
  | (ExtensionFrameBase & { type: 'fs-result'; id: number; ok: false; code: ExtensionFsErrorCode; error: string })
  // exactly one reply per `pick`, same `id`; `path` = workspace-relative POSIX
  // when the file is inside the workspace (realpath-compared), else absolute
  // (read it with `scope: 'system'`)
  | (ExtensionFrameBase & { type: 'pick-result'; id: number; ok: true; path: string; name: string; size: number })
  // `cancelled` = the user closed the picker; `denied` = no `fs-read`
  | (ExtensionFrameBase & { type: 'pick-result'; id: number; ok: false; code: ExtensionPickErrorCode; error: string })
  // user pressed save; extension answers with `save` or `error`
  | (ExtensionFrameBase & { type: 'save-request' })
  | (ExtensionFrameBase & { type: 'saved'; mtime: number })
  // `conflict` carries the on-disk mtime; `denied` = capability not declared
  | (ExtensionFrameBase & { type: 'save-error'; reason: 'conflict' | 'denied' | 'io'; message: string; mtime?: number })
  // on every admin theme switch (dark ↔ midnight too, though both are 'dark')
  | (ExtensionFrameBase & { type: 'theme'; theme: ExtensionTheme; themeVars: ExtensionThemeVars })
  | (ExtensionFrameBase & { type: 'lang'; lang: ExtensionLang })
  // exactly one reply per `export`: `path` = workspace-relative path written
  | (ExtensionFrameBase & { type: 'exported'; name: string; path: string })
  // `cancelled` = the user declined to overwrite an existing file
  | (ExtensionFrameBase & { type: 'export-error'; reason: 'denied' | 'cancelled' | 'invalid' | 'io'; message: string })

// ── Extension → Host ─────────────────────────────────────────────────

export type ExtensionClientFrame =
  // script loaded and listening; the host waits for this before `init`
  | (ExtensionFrameBase & { type: 'ready'; protocol: number })
  // for a bundle extension: "busy (e.g. recording) — don't drop me"
  | (ExtensionFrameBase & { type: 'dirty'; dirty: boolean })
  | (ExtensionFrameBase & { type: 'save'; buffer: ArrayBuffer })
  | (ExtensionFrameBase & { type: 'error'; message: string })
  // init.export hosts only: write `buffer` (transferred) next to the open
  // file as `name` (a plain file name, not the open file's own)
  | (ExtensionFrameBase & { type: 'export'; name: string; buffer: ArrayBuffer })
  // bundle extensions, or a `scope` with `fs-read` (see ExtensionFsOp);
  // `buffer` for write / append
  | (ExtensionFrameBase & { type: 'fs'; id: number; op: ExtensionFsOp; path: string; scope?: ExtensionFsScope; buffer?: ArrayBuffer })
  // `fs-read` only: open the host's file picker (whole machine). `accept` =
  // lower-case suffixes with the dot (`['.zip', '.7z']`), `[]` = any file;
  // `start` = dir to open at, workspace-relative or absolute (default: the
  // bundle dir for a bundle, else the open file's dir)
  | (ExtensionFrameBase & { type: 'pick'; id: number; accept: string[]; start?: string })

export type ExtensionHostFrameType = ExtensionHostFrame['type']
export type ExtensionClientFrameType = ExtensionClientFrame['type']

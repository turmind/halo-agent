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
import type { ExtensionCapability } from './extension-types.js'

export const EXTENSION_PROTOCOL_VERSION = 1

/** Marker field present on every frame in both directions. */
export interface ExtensionFrameBase {
  haloExt: 1
}

export type ExtensionTheme = 'light' | 'dark'

// ── Host → Extension ─────────────────────────────────────────────────

export type ExtensionHostFrame =
  // sent once, right after the extension's `ready`
  | (ExtensionFrameBase & {
      type: 'init'
      protocol: typeof EXTENSION_PROTOCOL_VERSION
      file: { name: string; path: string; size: number; ext: string }
      /** Capabilities the host grants this extension (manifest ∩ host support). */
      capabilities: ExtensionCapability[]
      theme: ExtensionTheme
    })
  // file bytes; after `init`, and again on external change while not dirty
  | (ExtensionFrameBase & { type: 'load'; buffer: ArrayBuffer; mtime: number })
  // user pressed save; extension answers with `save` or `error`
  | (ExtensionFrameBase & { type: 'save-request' })
  | (ExtensionFrameBase & { type: 'saved'; mtime: number })
  // `conflict` carries the on-disk mtime; `denied` = capability not declared
  | (ExtensionFrameBase & { type: 'save-error'; reason: 'conflict' | 'denied' | 'io'; message: string; mtime?: number })
  | (ExtensionFrameBase & { type: 'theme'; theme: ExtensionTheme })

// ── Extension → Host ─────────────────────────────────────────────────

export type ExtensionClientFrame =
  // script loaded and listening; the host waits for this before `init`
  | (ExtensionFrameBase & { type: 'ready'; protocol: number })
  | (ExtensionFrameBase & { type: 'dirty'; dirty: boolean })
  | (ExtensionFrameBase & { type: 'save'; buffer: ArrayBuffer })
  | (ExtensionFrameBase & { type: 'error'; message: string })

export type ExtensionHostFrameType = ExtensionHostFrame['type']
export type ExtensionClientFrameType = ExtensionClientFrame['type']

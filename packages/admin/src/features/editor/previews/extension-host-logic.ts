import type { ExtensionCapability, ExtensionClientFrame, ExtensionHostFrame, ExtensionTheme } from '@turmind/halo-core/protocol'
import { EXTENSION_PROTOCOL_VERSION } from '@turmind/halo-core/protocol'

/**
 * The extension host's protocol brain, kept free of React and I/O so it can
 * be unit-tested frame by frame: every entry point takes the current state
 * plus one input and returns the next state and a list of effects for the
 * component (`extension-host.tsx`) to carry out — post a frame, fetch the
 * file, PUT bytes, flip the tab's dirty dot, show a message. Wire format:
 * design doc §6 (.halo/tmp/canvas-extensions-design.md).
 */

export interface HostFile {
  name: string
  path: string
  size: number
  ext: string
}

export interface HostState {
  /** Extension sent `ready`; nothing is posted before that. */
  ready: boolean
  dirty: boolean
  /** mtime of the bytes the extension currently holds — the `expectMtime`
   *  baseline for the next save; null until the first load completes. */
  mtime: number | null
  /** A PUT is in flight; further `save` frames are dropped until it settles. */
  saving: boolean
  /** The user already chose "overwrite" once for this save; a second 409 is an error. */
  retried: boolean
  capabilities: ExtensionCapability[]
}

export type HostEffect =
  | { type: 'post'; frame: ExtensionHostFrame; transfer?: Transferable[] }
  /** Fetch the file bytes (+ fresh mtime) and feed them to `onLoaded`. */
  | { type: 'load' }
  /** PUT the bytes; feed the outcome to `onPutResult`. */
  | { type: 'put'; buffer: ArrayBuffer; expectMtime: number | null }
  /** Mirror dirty into the editor store (tab dot, close-confirm). */
  | { type: 'set-modified'; modified: boolean }
  /** Show above the iframe, with Open as Text / Download. */
  | { type: 'error'; message: string }
  /** Disk changed under a dirty document — ask overwrite / discard / cancel,
   *  then call `onConflictChoice`. */
  | { type: 'confirm-conflict'; buffer: ArrayBuffer; diskMtime: number }
  /** Extension-author mistake, not the user's: console only. */
  | { type: 'warn'; message: string }

export interface Step {
  state: HostState
  effects: HostEffect[]
}

export function initialHostState(capabilities: ExtensionCapability[]): HostState {
  return { ready: false, dirty: false, mtime: null, saving: false, retried: false, capabilities }
}

export function isClientFrame(data: unknown): data is ExtensionClientFrame {
  return typeof data === 'object' && data !== null
    && (data as { haloExt?: unknown }).haloExt === 1
    && typeof (data as { type?: unknown }).type === 'string'
}

function canSave(state: HostState): boolean {
  return state.capabilities.includes('save')
}

export function onClientFrame(state: HostState, frame: ExtensionClientFrame, ctx: { file: HostFile; theme: ExtensionTheme }): Step {
  switch (frame.type) {
    case 'ready': {
      if (state.ready) return { state, effects: [{ type: 'warn', message: 'duplicate ready frame ignored' }] }
      return {
        state: { ...state, ready: true },
        effects: [
          { type: 'post', frame: { haloExt: 1, type: 'init', protocol: EXTENSION_PROTOCOL_VERSION, file: ctx.file, capabilities: state.capabilities, theme: ctx.theme } },
          { type: 'load' },
        ],
      }
    }
    case 'dirty': {
      if (!state.ready) return { state, effects: [{ type: 'warn', message: 'dirty before ready ignored' }] }
      if (!canSave(state)) return { state, effects: [{ type: 'warn', message: 'dirty from an extension without the save capability ignored' }] }
      if (state.dirty === frame.dirty) return { state, effects: [] }
      return { state: { ...state, dirty: frame.dirty }, effects: [{ type: 'set-modified', modified: frame.dirty }] }
    }
    case 'save': {
      if (!state.ready) return { state, effects: [{ type: 'warn', message: 'save before ready ignored' }] }
      if (!canSave(state)) {
        return {
          state,
          effects: [
            { type: 'post', frame: { haloExt: 1, type: 'save-error', reason: 'denied', message: 'extension did not declare the save capability' } },
            { type: 'warn', message: 'save from an extension without the save capability denied' },
          ],
        }
      }
      if (state.saving) return { state, effects: [{ type: 'warn', message: 'save while a save is in flight dropped' }] }
      return { state: { ...state, saving: true }, effects: [{ type: 'put', buffer: frame.buffer, expectMtime: state.mtime }] }
    }
    case 'error':
      return { state, effects: [{ type: 'error', message: frame.message }] }
  }
}

/** File bytes arrived (initial load, external change, or conflict "discard"). */
export function onLoaded(state: HostState, buffer: ArrayBuffer, mtime: number | null): Step {
  const effects: HostEffect[] = [{ type: 'post', frame: { haloExt: 1, type: 'load', buffer, mtime: mtime ?? 0 }, transfer: [buffer] }]
  if (state.dirty) effects.push({ type: 'set-modified', modified: false })
  return { state: { ...state, mtime, dirty: false }, effects }
}

/** Shape of `api.files.saveRaw`'s resolution; the 409 branch carries the disk mtime. */
export type PutResult =
  | { ok: true; mtime: number }
  | { ok: false; status: 409; mtime: number }
  | { ok: false; status: number; message: string }

export function onPutResult(state: HostState, buffer: ArrayBuffer, result: PutResult): Step {
  if (result.ok) {
    return {
      state: { ...state, saving: false, retried: false, dirty: false, mtime: result.mtime },
      effects: [
        { type: 'post', frame: { haloExt: 1, type: 'saved', mtime: result.mtime } },
        { type: 'set-modified', modified: false },
      ],
    }
  }
  if ('mtime' in result) {
    if (state.retried) {
      return {
        state: { ...state, saving: false, retried: false },
        effects: [
          { type: 'post', frame: { haloExt: 1, type: 'save-error', reason: 'conflict', message: 'file changed on disk again', mtime: result.mtime } },
          { type: 'error', message: 'Save failed: the file keeps changing on disk' },
        ],
      }
    }
    return { state: { ...state, saving: false }, effects: [{ type: 'confirm-conflict', buffer, diskMtime: result.mtime }] }
  }
  return {
    state: { ...state, saving: false, retried: false },
    effects: [
      { type: 'post', frame: { haloExt: 1, type: 'save-error', reason: 'io', message: result.message } },
      { type: 'error', message: `Save failed: ${result.message}` },
    ],
  }
}

export type ConflictChoice = 'overwrite' | 'discard' | 'cancel'

export function onConflictChoice(state: HostState, choice: ConflictChoice, buffer: ArrayBuffer, diskMtime: number): Step {
  switch (choice) {
    case 'overwrite':
      return { state: { ...state, saving: true, retried: true }, effects: [{ type: 'put', buffer, expectMtime: diskMtime }] }
    case 'discard':
      return { state, effects: [{ type: 'load' }] }
    case 'cancel':
      return { state, effects: [] }
  }
}

/** `file:changed` for this path. Our own save's echo (mtime already known)
 *  and changes under a dirty document are ignored — the latter surfaces as a
 *  409 on the next save instead. */
export function onFileChanged(state: HostState, diskMtime: number): Step {
  if (!state.ready) return { state, effects: [] }
  if (state.mtime != null && diskMtime <= state.mtime) return { state, effects: [] }
  if (state.dirty) return { state, effects: [] }
  return { state, effects: [{ type: 'load' }] }
}

/** User asked to save (Ctrl/Cmd+S, Save button). */
export function onSaveRequest(state: HostState): Step {
  if (!state.ready || !canSave(state) || !state.dirty || state.saving) return { state, effects: [] }
  return { state, effects: [{ type: 'post', frame: { haloExt: 1, type: 'save-request' } }] }
}

export function onThemeChange(state: HostState, theme: ExtensionTheme): Step {
  if (!state.ready) return { state, effects: [] }
  return { state, effects: [{ type: 'post', frame: { haloExt: 1, type: 'theme', theme } }] }
}

// ── Host registry ────────────────────────────────────────────────────
// editor-panel reaches mounted hosts through this map (same shape as
// face-bridge.ts's iframe set): `handleSave` on an extension tab forwards a
// save request; its `file:changed` handler forwards the disk change. Keyed by
// panel (projectId) + path because several EditorPanels (Explorer, Skills,
// Agents) can hold the same relative path.

export interface ExtensionHostHandle {
  requestSave(): void
  fileChanged(): void
}

const hosts = new Map<string, ExtensionHostHandle>()

function hostKey(projectId: string | undefined, path: string): string {
  return `${projectId ?? ''}::${path}`
}

export function registerExtensionHost(projectId: string | undefined, path: string, handle: ExtensionHostHandle): () => void {
  const key = hostKey(projectId, path)
  hosts.set(key, handle)
  return () => { if (hosts.get(key) === handle) hosts.delete(key) }
}

export function getExtensionHost(projectId: string | undefined, path: string): ExtensionHostHandle | undefined {
  return hosts.get(hostKey(projectId, path))
}

import type {
  ExtensionCapability, ExtensionClientFrame, ExtensionFsEntry, ExtensionFsErrorCode, ExtensionFsOp, ExtensionFsScope,
  ExtensionHostFrame, ExtensionLang, ExtensionPickErrorCode, ExtensionPlatform, ExtensionTheme, ExtensionThemeVars,
} from '@turmind/halo-core/protocol'
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
  /** Bundle extension: the tab is a directory; `fs` frames instead of load/save,
   *  and `dirty` means "busy — don't drop me". */
  bundle: boolean
}

export interface HostContext {
  file: HostFile
  theme: ExtensionTheme
  themeVars: ExtensionThemeVars
  platform: ExtensionPlatform
  lang: ExtensionLang
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
  /** Run a validated `fs` request (path is bundle-relative; workspace-relative
   *  with `scope: 'workspace'`; absolute with `scope: 'system'` — scoped =
   *  read / stat / list only); feed the outcome to `onFsResult`. write /
   *  append to one path run in request order. */
  | { type: 'fs'; id: number; op: ExtensionFsOp; path: string; scope?: ExtensionFsScope; buffer?: ArrayBuffer }
  /** Open the file picker (`fs-read`); answer with exactly one `pick-result`
   *  (see `pickResult`). `start` = workspace-relative or absolute dir, or undefined. */
  | { type: 'pick'; id: number; accept: string[]; start?: string }
  /** Write a validated `export` next to the open file (`name` is a plain
   *  file name); answer with exactly one `exported` / `export-error`. */
  | { type: 'export'; name: string; buffer: ArrayBuffer }

export interface Step {
  state: HostState
  effects: HostEffect[]
}

export function initialHostState(capabilities: ExtensionCapability[], bundle = false): HostState {
  return { ready: false, dirty: false, mtime: null, saving: false, retried: false, capabilities, bundle }
}

export function isClientFrame(data: unknown): data is ExtensionClientFrame {
  return typeof data === 'object' && data !== null
    && (data as { haloExt?: unknown }).haloExt === 1
    && typeof (data as { type?: unknown }).type === 'string'
}

function canSave(state: HostState): boolean {
  return state.capabilities.includes('save')
}

function canReadFs(state: HostState): boolean {
  return state.capabilities.includes('fs-read')
}

const FS_OPS: ReadonlySet<string> = new Set<ExtensionFsOp>(['read', 'write', 'append', 'list', 'stat'])

/** Bundle-relative POSIX path: no leading `/`, no `\`, no NUL, no empty / `.`
 *  / `..` segment. `''` (= the bundle root) only where `allowRoot`. */
export function isBundlePath(p: unknown, allowRoot: boolean): boolean {
  if (typeof p !== 'string') return false
  if (p === '') return allowRoot
  if (p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** `scope: 'system'` path: absolute (POSIX `/…`, Windows `C:/…`), forward
 *  slashes only, normalized — no NUL, no empty / `.` / `..` segment past the root. */
export function isSystemPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.includes('\\') || p.includes('\0')) return false
  const root = /^(\/|[A-Za-z]:\/)/.exec(p)?.[0]
  if (!root) return false
  const rest = p.slice(root.length)
  return rest === '' || rest.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

function isArrayBuffer(v: unknown): v is ArrayBuffer {
  // Not `instanceof`: the frame may come from another realm.
  return Object.prototype.toString.call(v) === '[object ArrayBuffer]'
}

/** Export target: one path segment — non-empty, no `/` `\` NUL, not `.` / `..`. */
function isPlainFileName(n: unknown): n is string {
  return typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !/[/\\\0]/.test(n)
}

export function exportError(reason: 'denied' | 'cancelled' | 'invalid' | 'io', message: string): HostEffect {
  return { type: 'post', frame: { haloExt: 1, type: 'export-error', reason, message } }
}

function onExportFrame(state: HostState, frame: Extract<ExtensionClientFrame, { type: 'export' }>, ctx: HostContext): Step {
  if (!state.ready) return { state, effects: [{ type: 'warn', message: 'export before ready ignored' }] }
  if (!canSave(state) || state.bundle) {
    return { state, effects: [exportError('denied', 'export needs the save capability (non-bundle)'), { type: 'warn', message: 'export from an extension without export support denied' }] }
  }
  if (!isPlainFileName(frame.name)) return { state, effects: [exportError('invalid', `invalid export file name: ${JSON.stringify(frame.name)}`)] }
  if (frame.name === ctx.file.name) return { state, effects: [exportError('invalid', 'export must not overwrite the open file')] }
  if (!isArrayBuffer(frame.buffer)) return { state, effects: [exportError('invalid', 'export needs an ArrayBuffer buffer')] }
  return { state, effects: [{ type: 'export', name: frame.name, buffer: frame.buffer }] }
}

function fsError(id: number, code: ExtensionFsErrorCode, error: string): HostEffect {
  return { type: 'post', frame: { haloExt: 1, type: 'fs-result', id, ok: false, code, error } }
}

/** Validate one `fs` request: exactly one reply comes out of here (an error
 *  frame) or out of `onFsResult` (after the `fs` effect ran). */
function onFsFrame(state: HostState, frame: Extract<ExtensionClientFrame, { type: 'fs' }>): Step {
  const { id } = frame
  if (typeof id !== 'number' || !Number.isFinite(id)) return { state, effects: [{ type: 'warn', message: 'fs frame without a numeric id ignored' }] }
  if (frame.scope !== undefined) {
    const { scope } = frame
    if (scope !== 'workspace' && scope !== 'system') return { state, effects: [fsError(id, 'denied', `unknown fs scope: ${String(scope)}`)] }
    if (!canReadFs(state)) {
      return { state, effects: [fsError(id, 'denied', `${scope} fs needs the fs-read capability`), { type: 'warn', message: `${scope} fs without fs-read denied` }] }
    }
    if (!FS_OPS.has(frame.op)) return { state, effects: [fsError(id, 'denied', `unknown fs op: ${String(frame.op)}`)] }
    if (frame.op === 'write' || frame.op === 'append') return { state, effects: [fsError(id, 'denied', `${scope} scope is read-only`)] }
    if (scope === 'system' ? !isSystemPath(frame.path) : !isBundlePath(frame.path, frame.op === 'list')) {
      return { state, effects: [fsError(id, 'invalid-path', `invalid ${scope} path: ${JSON.stringify(frame.path)}`)] }
    }
    return { state, effects: [{ type: 'fs', id, op: frame.op, path: frame.path, scope }] }
  }
  if (!state.bundle) {
    return { state, effects: [fsError(id, 'denied', 'fs is only available to bundle extensions'), { type: 'warn', message: 'fs from a non-bundle extension denied' }] }
  }
  if (!FS_OPS.has(frame.op)) return { state, effects: [fsError(id, 'denied', `unknown fs op: ${String(frame.op)}`)] }
  if (!isBundlePath(frame.path, frame.op === 'list')) {
    return { state, effects: [fsError(id, 'invalid-path', `invalid bundle path: ${JSON.stringify(frame.path)}`)] }
  }
  if (frame.op === 'write' || frame.op === 'append') {
    if (!isArrayBuffer(frame.buffer)) return { state, effects: [fsError(id, 'io', `${frame.op} needs an ArrayBuffer buffer`)] }
    return { state, effects: [{ type: 'fs', id, op: frame.op, path: frame.path, buffer: frame.buffer }] }
  }
  return { state, effects: [{ type: 'fs', id, op: frame.op, path: frame.path }] }
}

export function pickResult(id: number, outcome: { ok: true; path: string; name: string; size: number } | { ok: false; code: ExtensionPickErrorCode; error: string }): HostEffect {
  return { type: 'post', frame: { haloExt: 1, type: 'pick-result', id, ...outcome } }
}

/** Validate one `pick`: a `denied` reply here, or a `pick` effect whose
 *  picker answers through `pickResult` exactly once. */
function onPickFrame(state: HostState, frame: Extract<ExtensionClientFrame, { type: 'pick' }>): Step {
  const { id } = frame
  if (typeof id !== 'number' || !Number.isFinite(id)) return { state, effects: [{ type: 'warn', message: 'pick frame without a numeric id ignored' }] }
  if (!canReadFs(state)) {
    return { state, effects: [pickResult(id, { ok: false, code: 'denied', error: 'pick needs the fs-read capability' }), { type: 'warn', message: 'pick without fs-read denied' }] }
  }
  const accept = Array.isArray(frame.accept)
    ? frame.accept.filter((a): a is string => typeof a === 'string' && a !== '').map((a) => a.toLowerCase())
    : []
  const start = isBundlePath(frame.start, true) || isSystemPath(frame.start) ? frame.start : undefined
  return { state, effects: [{ type: 'pick', id, accept, ...(start !== undefined ? { start } : {}) }] }
}

/** Outcome of one executed `fs` effect. Failures carry the HTTP status (0 = network). */
export type FsOutcome =
  | { ok: true; buffer?: ArrayBuffer; entries?: ExtensionFsEntry[]; size?: number; mtime?: number }
  | { ok: false; status: number; message: string }

export function onFsResult(state: HostState, id: number, outcome: FsOutcome): Step {
  if (!outcome.ok) {
    const code: ExtensionFsErrorCode = outcome.status === 404 ? 'not-found' : outcome.status === 403 ? 'denied' : 'io'
    return { state, effects: [fsError(id, code, outcome.message)] }
  }
  const { ok: _ok, ...data } = outcome
  return {
    state,
    effects: [{ type: 'post', frame: { haloExt: 1, type: 'fs-result', id, ok: true, ...data }, ...(data.buffer ? { transfer: [data.buffer] } : {}) }],
  }
}

/** Per-key FIFO: a task starts only after every earlier task for the same key
 *  settled (resolved or rejected); different keys run concurrently. The host
 *  routes write / append through it so appends to one file land in request order. */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const result = (tails.get(key) ?? Promise.resolve()).then(task)
      const tail = result.then(() => {}, () => {})
      tails.set(key, tail)
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
      return result
    },
  }
}

export function onClientFrame(state: HostState, frame: ExtensionClientFrame, ctx: HostContext): Step {
  switch (frame.type) {
    case 'ready': {
      // A second `ready` = the extension reloaded itself (`location.reload()`):
      // it holds nothing, so it gets init (+ load) again and loses its dirty flag.
      const reset: HostEffect[] = state.dirty ? [{ type: 'set-modified', modified: false }] : []
      const init: HostEffect = {
        type: 'post',
        frame: {
          haloExt: 1, type: 'init', protocol: EXTENSION_PROTOCOL_VERSION, file: ctx.file, capabilities: state.capabilities,
          theme: ctx.theme, themeVars: ctx.themeVars, bundle: state.bundle, platform: ctx.platform, lang: ctx.lang,
          export: canSave(state) && !state.bundle,
        },
      }
      // A bundle never gets `load` — it reads what it needs through `fs`.
      return { state: { ...state, ready: true, dirty: false }, effects: state.bundle ? [...reset, init] : [...reset, init, { type: 'load' }] }
    }
    case 'dirty': {
      if (!state.ready) return { state, effects: [{ type: 'warn', message: 'dirty before ready ignored' }] }
      // Bundle: dirty = busy (recording) — same tab dot / close confirm / MRU pin.
      if (!canSave(state) && !state.bundle) return { state, effects: [{ type: 'warn', message: 'dirty from an extension without the save capability ignored' }] }
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
    case 'fs':
      return onFsFrame(state, frame)
    case 'export':
      return onExportFrame(state, frame, ctx)
    case 'pick':
      return onPickFrame(state, frame)
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
  // A bundle owns its directory's contents and never gets `load`.
  if (!state.ready || state.bundle) return { state, effects: [] }
  if (state.mtime != null && diskMtime <= state.mtime) return { state, effects: [] }
  if (state.dirty) return { state, effects: [] }
  return { state, effects: [{ type: 'load' }] }
}

/** User asked to save (Ctrl/Cmd+S, Save button). */
export function onSaveRequest(state: HostState): Step {
  if (!state.ready || !canSave(state) || !state.dirty || state.saving) return { state, effects: [] }
  return { state, effects: [{ type: 'post', frame: { haloExt: 1, type: 'save-request' } }] }
}

export function onThemeChange(state: HostState, theme: ExtensionTheme, themeVars: ExtensionThemeVars): Step {
  if (!state.ready) return { state, effects: [] }
  return { state, effects: [{ type: 'post', frame: { haloExt: 1, type: 'theme', theme, themeVars } }] }
}

export function onLangChange(state: HostState, lang: ExtensionLang): Step {
  if (!state.ready) return { state, effects: [] }
  return { state, effects: [{ type: 'post', frame: { haloExt: 1, type: 'lang', lang } }] }
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

'use client'

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { api } from '@/shared/api-client'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { useTheme } from '@/shared/theme'
import { readHostTheme } from '@/shared/theme/palette'
import { useI18n } from '@/shared/i18n'
import { cn, confirmAction } from '@/shared/utils'
import { FilePicker, type PickedFile } from '@/shared/components/file-picker'
import { PreviewShell, ToolbarButton } from './ui/preview-shell'
import { extensionEntryUrl, getExtensionToken } from './extension-token'
import { currentPlatform, isImmersiveViewer } from './registry'
import { ImmersivePane, claimImmersive, createExitPill, exitImmersive, takeFullscreenArm, takeRefocus } from '../immersive'
import {
  createKeyedQueue, exportError, initialHostState, isClientFrame, onClientFrame, onConflictChoice, onFileChanged, onFsResult, onLoaded,
  isSystemPath, onLangChange, onPutResult, onSaveRequest, onThemeChange, pickResult, registerExtensionHost,
  type FsOutcome, type HostContext, type HostEffect, type HostState, type Step,
} from './extension-host-logic'
import type { PreviewProps } from './types'

const READY_TIMEOUT_MS = 10_000
const SAVE_TIMEOUT_MS = 5_000
/** `media` capability: mic + screen capture (+ copy). Everyone else gets nothing. */
const MEDIA_ALLOW = 'microphone; display-capture; clipboard-write'

/** Absolute paths on the wire use forward slashes (Windows `C:/…`). */
const toSlash = (p: string) => p.replace(/\\/g, '/')

async function httpFailure(res: Response): Promise<FsOutcome> {
  const body = await res.json().catch(() => ({})) as { error?: string }
  return { ok: false, status: res.status, message: body.error ?? res.statusText }
}

/** `scope: 'system'` (absolute path, read / stat / list) against the
 *  admin-cookie `/fs/*` routes. */
async function execSystemFs(eff: Extract<HostEffect, { type: 'fs' }>): Promise<FsOutcome> {
  const q = encodeURIComponent(eff.path)
  switch (eff.op) {
    case 'read': {
      const res = await fetch(`/api/fs/raw?path=${q}`)
      return res.ok ? { ok: true, buffer: await res.arrayBuffer() } : await httpFailure(res)
    }
    case 'list': {
      const res = await fetch(`/api/fs/browse?path=${q}&files=1`)
      if (!res.ok) return await httpFailure(res)
      const body = await res.json() as { entries: Array<{ name: string; type: 'file' | 'directory' }> }
      return { ok: true, entries: body.entries.map(({ name, type }) => ({ name, type })) }
    }
    case 'stat': {
      const res = await fetch(`/api/fs/stat?path=${q}`)
      if (!res.ok) return await httpFailure(res)
      const body = await res.json() as { size: number; modifiedAt: number }
      return { ok: true, size: body.size, mtime: body.modifiedAt }
    }
    default:
      return { ok: false, status: 403, message: 'system scope is read-only' }
  }
}

/** Run one validated `fs` request (protocol §3) against the files API;
 *  `eff.path` is bundle-relative, workspace-relative with `scope:
 *  'workspace'`, or absolute with `scope: 'system'` (scoped = read / stat /
 *  list only); '' = that root (list only). */
async function execFs(projectId: string, bundlePath: string, eff: Extract<HostEffect, { type: 'fs' }>): Promise<FsOutcome> {
  if (eff.scope === 'system') {
    try { return await execSystemFs(eff) } catch (err) {
      return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) }
    }
  }
  const full = eff.scope === 'workspace' ? eff.path : eff.path ? `${bundlePath}/${eff.path}` : bundlePath
  const query = new URLSearchParams({ path: full, projectId })
  try {
    switch (eff.op) {
      case 'read': {
        const res = await fetch(api.files.viewUrl(full, projectId))
        return res.ok ? { ok: true, buffer: await res.arrayBuffer() } : await httpFailure(res)
      }
      case 'list': {
        const res = await fetch(`/api/files/tree?${query}`)
        if (!res.ok) return await httpFailure(res)
        const body = await res.json() as { tree: Array<{ name: string; type: 'file' | 'directory' }> }
        return { ok: true, entries: body.tree.map(({ name, type }) => ({ name, type })) }
      }
      case 'stat': {
        const res = await fetch(`/api/files/stat?${query}`)
        if (!res.ok) return await httpFailure(res)
        const body = await res.json() as { size: number; modifiedAt: number }
        return { ok: true, size: body.size, mtime: body.modifiedAt }
      }
      case 'write':
      case 'append': {
        // root = the bundle dir: a bundle deleted / renamed mid-recording 404s
        // (→ not-found) instead of being recreated at its old path.
        const r = await api.files.saveRaw(full, eff.buffer!, projectId, undefined, { create: true, append: eff.op === 'append', root: bundlePath })
        if (r.ok) return { ok: true, size: r.size, mtime: r.mtime }
        return { ok: false, status: r.status, message: 'message' in r ? r.message : 'conflict' }
      }
    }
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) }
  }
}

interface Props extends PreviewProps {
  info: ExtensionInfo
  /** The registry no longer lists this extension but the document has
   *  unsaved edits — keep the loaded iframe alive so they can be saved. */
  uninstalled?: boolean
}

/**
 * Runs one installed extension in a sandboxed iframe and speaks the
 * host↔extension postMessage protocol to it. `sandbox="allow-scripts
 * allow-same-origin"` — same grant as html-preview.tsx, and for the same
 * trust model (code the user chose to install, like a skill). Without
 * `allow-same-origin` the iframe is an opaque origin and its module-script /
 * fetch / wasm requests carry NO cookie at all, so any cookie-auth proxy in
 * front of halo (midway / CloudFront, oauth2-proxy, Cloudflare Access) 307s
 * them to its login page → CORS error → no `ready` → "unresponsive". Our own
 * asset route doesn't need the cookie (path token), the proxy does.
 * The extension never fetches the file itself; the host fetches and
 * transfers the bytes (§6). Protocol decisions live in extension-host-logic.ts;
 * this component only executes the effects it returns.
 */
export function ExtensionHostPreview({ info, uninstalled, name, path, projectId, viewUrl, downloadUrl, size, onOpenAsText }: Props) {
  const { t, lang } = useI18n()
  const useEditorStore = useScopedEditorStore()
  const { theme } = useTheme()
  // The provider stamps <html data-theme> in the same tick as its setState, so
  // by this render the DOM already carries `theme`'s variables. Keyed on the
  // raw theme: dark ↔ midnight are both 'dark' but repaint the palette.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `theme` is the DOM-change signal, not an input
  const hostTheme = useMemo(() => readHostTheme(), [theme])
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const stateRef = useRef<HostState>(initialHostState(info.capabilities, info.bundle))
  // Bundle write / append, serialized per file so appends land in request order (§3).
  const fsQueueRef = useRef(createKeyedQueue())
  // Bumped on every reload (retry / upgrade) so the iframe remounts.
  const [attempt, setAttempt] = useState(0)
  // Mounted attempt, read when an async fs result lands: a result for an
  // iframe that has since been remounted is dropped (its ids mean nothing
  // to the new document).
  const attemptRef = useRef(attempt)
  const [src, setSrc] = useState<string | null>(null)
  const [phase, setPhase] = useState<'token' | 'loading' | 'ready' | 'failed'>('token')
  const [message, setMessage] = useState<string | null>(null)
  // Last successful export: workspace-relative path + its download URL.
  const [exported, setExported] = useState<{ path: string; url: string } | null>(null)
  const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null)
  // Open file picker (`pick`, fs-read): one at a time, tied to the
  // iframe attempt that asked.
  // The ref is the truth (two picks in one tick), the state drives the render.
  type Picking = { id: number; accept: string[]; start: string; attempt: number }
  const pickingRef = useRef<Picking | null>(null)
  const [picking, setPickingState] = useState<Picking | null>(null)
  const setPicking = (p: Picking | null) => { pickingRef.current = p; setPickingState(p) }
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Version this iframe was mounted with; a differing `info.version` → §9.3.
  const mountedVersionRef = useRef(info.version)

  // Latest-props refs (same pattern as code-editor.tsx's onSaveRef) so the
  // stable `run` never executes a stale closure. Frames only arrive after
  // effects have run, so the one-render lag is never observed.
  const ctx: HostContext = {
    file: { name, path, size: size ?? 0, ext: name.split('.').pop()?.toLowerCase() ?? '' },
    theme: hostTheme.theme,
    themeVars: hostTheme.themeVars,
    platform: currentPlatform(),
    lang,
  }
  const ctxRef = useRef(ctx)
  const applyEffectRef = useRef<(eff: HostEffect) => void>(() => {})
  const run = useCallback((step: Step) => {
    stateRef.current = step.state
    for (const eff of step.effects) applyEffectRef.current(eff)
  }, [])

  const clearSaveTimer = () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
  }

  const applyEffect = (eff: HostEffect) => {
    switch (eff.type) {
      case 'post':
        iframeRef.current?.contentWindow?.postMessage(eff.frame, '*', eff.transfer ?? [])
        return
      case 'load':
        void (async () => {
          try {
            // The mtime that comes with the bytes is the next save's baseline (§6.3).
            const [res, stat] = await Promise.all([
              fetch(viewUrl),
              projectId ? api.files.stat(path, projectId).catch(() => null) : Promise.resolve(null),
            ])
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const buffer = await res.arrayBuffer()
            run(onLoaded(stateRef.current, buffer, stat?.modifiedAt ?? null))
          } catch (err) {
            setMessage(`Failed to load file: ${err instanceof Error ? err.message : String(err)}`)
          }
        })()
        return
      case 'put':
        clearSaveTimer()
        if (!projectId) {
          run(onPutResult(stateRef.current, eff.buffer, { ok: false, status: 0, message: 'no workspace' }))
          return
        }
        void api.files.saveRaw(path, eff.buffer, projectId, eff.expectMtime ?? undefined)
          .then((result) => run(onPutResult(stateRef.current, eff.buffer, result)))
        return
      case 'set-modified':
        if (eff.modified) useEditorStore.getState().markModified(path)
        else useEditorStore.getState().clearModified(path)
        return
      case 'error':
        setMessage(eff.message)
        return
      case 'confirm-conflict':
        void (async () => {
          // confirmAction is yes/no, so the three-way choice is two questions:
          // overwrite? — if not, discard? — otherwise cancel (keep editing).
          const fileName = path.split('/').pop()
          const overwrite = await confirmAction(`"${fileName}" changed on disk since you opened it. Overwrite the disk version with your changes?`)
          const choice = overwrite ? 'overwrite'
            : (await confirmAction(`Discard your changes and reload "${fileName}" from disk? (Cancel keeps your unsaved changes.)`)) ? 'discard' : 'cancel'
          run(onConflictChoice(stateRef.current, choice, eff.buffer, eff.diskMtime))
        })()
        return
      case 'warn':
        console.warn(`[ExtensionHost] ${info.id}: ${eff.message}`)
        return
      case 'fs': {
        if (!projectId) {
          run(onFsResult(stateRef.current, eff.id, { ok: false, status: 0, message: 'no workspace' }))
          return
        }
        const issuedFor = attemptRef.current
        const exec = () => execFs(projectId, path, eff)
        const pending = eff.op === 'write' || eff.op === 'append'
          ? fsQueueRef.current.run(eff.path, exec)
          : exec()
        void pending.then((outcome) => {
          if (attemptRef.current !== issuedFor) return
          run(onFsResult(stateRef.current, eff.id, outcome))
        })
        return
      }
      case 'export': {
        const issuedFor = attemptRef.current
        // A reply for a since-remounted iframe means nothing to the new document.
        const reply = (frame: HostEffect) => { if (attemptRef.current === issuedFor) applyEffectRef.current(frame) }
        if (!projectId) {
          reply(exportError('io', 'no workspace'))
          return
        }
        const slash = path.lastIndexOf('/')
        const target = slash < 0 ? eff.name : `${path.slice(0, slash)}/${eff.name}`
        void (async () => {
          const exists = await api.files.stat(target, projectId).then(() => true, () => false)
          if (exists && !(await confirmAction(t('editor.extension.exportOverwrite', { name: eff.name })))) {
            reply(exportError('cancelled', 'overwrite declined'))
            return
          }
          const r = await api.files.saveRaw(target, eff.buffer, projectId, undefined, { create: true })
          if (r.ok) {
            reply({ type: 'post', frame: { haloExt: 1, type: 'exported', name: eff.name, path: target } })
            setExported({ path: target, url: api.files.downloadUrl(target, projectId) })
            return
          }
          const reason = 'message' in r ? r.message : `HTTP ${r.status}`
          reply(exportError('io', reason))
          setMessage(t('editor.extension.exportFailed', { message: reason }))
        })()
        return
      }
      case 'pick': {
        if (!projectId || pickingRef.current) {
          run({ state: stateRef.current, effects: [pickResult(eff.id, { ok: false, code: 'cancelled', error: projectId ? 'a picker is already open' : 'no workspace' })] })
          return
        }
        // The viewer's own fullscreen (the iframe is this document's
        // fullscreen element) would cover the picker: drop back one level —
        // to our immersive <html> fullscreen, or to none.
        const fs = document.fullscreenElement
        if (fs && fs !== document.documentElement) void document.exitFullscreen().catch(() => { /* already left */ })
        // The picker speaks absolute paths; `start` may be workspace-relative.
        const ws = toSlash(projectId).replace(/(.)\/$/, '$1')
        const rel = eff.start ?? (info.bundle ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
        const start = isSystemPath(rel) ? rel : rel ? `${ws}/${rel}` : ws
        setPicking({ id: eff.id, accept: eff.accept, start, attempt: attemptRef.current })
        return
      }
    }
  }

  const onPicked = async (file: PickedFile | null) => {
    const p = pickingRef.current
    setPicking(null)
    // A reply for a since-remounted iframe means nothing to the new document.
    const reply = (outcome: Parameters<typeof pickResult>[1]) => {
      if (!p || p.attempt !== attemptRef.current) return
      run({ state: stateRef.current, effects: [pickResult(p.id, outcome)] })
      focusFrame()
    }
    if (!file || !projectId) { reply({ ok: false, code: 'cancelled', error: 'picker closed' }); return }
    // Inside the workspace (realpath-compared, so a symlinked workspace or ROM
    // dir lands on the right side) → workspace-relative; else absolute.
    try {
      const [real, wsReal] = await Promise.all([api.fs.stat(file.path), api.fs.stat(projectId)])
      const r = toSlash(real.realPath), w = toSlash(wsReal.realPath).replace(/(.)\/$/, '$1')
      const inside = r.startsWith(w.endsWith('/') ? w : `${w}/`)
      reply({ ok: true, path: inside ? r.slice(w.length).replace(/^\//, '') : file.path, name: file.name, size: real.size })
    } catch (err) {
      reply({ ok: false, code: 'cancelled', error: `could not stat the picked file: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  useEffect(() => {
    ctxRef.current = ctx
    applyEffectRef.current = applyEffect
  })

  // Remount the iframe from scratch (retry / upgrade); the initial mount has
  // the same starting state via useState defaults.
  const remount = () => {
    setUpgradeNotice(null)
    setPhase('token')
    setMessage(null)
    setSrc(null)
    setAttempt((n) => n + 1)
  }

  // Mount / reload: mint (or reuse) the asset token, then navigate the iframe.
  useEffect(() => {
    let cancelled = false
    attemptRef.current = attempt
    // A confirmed "discard and reload" throws the iframe's edits away — the
    // tab's dirty dot goes with them.
    if (stateRef.current.dirty) useEditorStore.getState().clearModified(path)
    stateRef.current = initialHostState(info.capabilities, info.bundle)
    getExtensionToken().then((token) => {
      if (cancelled) return
      mountedVersionRef.current = info.version
      setSrc(extensionEntryUrl(info.id, info.version, token, info.entry))
      setPhase('loading')
      readyTimerRef.current = setTimeout(() => {
        if (!stateRef.current.ready) setPhase('failed')
      }, READY_TIMEOUT_MS)
    }).catch((err) => {
      if (cancelled) return
      setMessage(err instanceof Error ? err.message : String(err))
      setPhase('failed')
    })
    return () => {
      cancelled = true
      if (readyTimerRef.current) clearTimeout(readyTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs on explicit reload only; `info` is read at that moment
  }, [attempt])

  // Inbound frames. `e.source` is the only reliable sender check: every
  // extension iframe on the page shares the admin's origin, so `e.origin`
  // can't tell two of them apart.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (!isClientFrame(e.data)) return
      if (e.data.type === 'ready') {
        if (readyTimerRef.current) { clearTimeout(readyTimerRef.current); readyTimerRef.current = null }
        setPhase('ready')
      }
      if (e.data.type === 'save') clearSaveTimer()
      run(onClientFrame(stateRef.current, e.data, ctxRef.current))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [run])

  useEffect(() => {
    run(onThemeChange(stateRef.current, hostTheme.theme, hostTheme.themeVars))
  }, [hostTheme, run])

  useEffect(() => {
    run(onLangChange(stateRef.current, lang))
  }, [lang, run])

  const requestSave = useCallback(() => {
    const step = onSaveRequest(stateRef.current)
    run(step)
    // Nothing forwarded (not ready / clean / saving / no save capability —
    // e.g. a busy bundle tab's Ctrl+S) → nothing to wait for.
    if (step.effects.length === 0) return
    clearSaveTimer()
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      if (stateRef.current.dirty && !stateRef.current.saving) window.alert(`Extension "${info.name}" did not respond to the save request.`)
    }, SAVE_TIMEOUT_MS)
  }, [run, info.name])

  // editor-panel's Ctrl+S and its file:changed handler reach us through this registry.
  useEffect(() => registerExtensionHost(projectId, path, {
    requestSave,
    fileChanged() {
      // A bundle reads its directory through `fs`; there is nothing to reload.
      if (!projectId || stateRef.current.bundle) return
      api.files.stat(path, projectId)
        .then((stat) => run(onFileChanged(stateRef.current, stat.modifiedAt)))
        .catch(() => { /* file gone or unreadable — nothing to reload */ })
    },
  }), [projectId, path, requestSave, run])

  // Upgraded while mounted (§9.3): reload unless there are unsaved edits, in
  // which case a banner offers the reload once the user is ready.
  useEffect(() => {
    if (info.version === mountedVersionRef.current) return
    if (stateRef.current.dirty) {
      setUpgradeNotice(t('editor.extension.updated', { version: info.version }))
      return
    }
    remount()
  }, [info.version, t])

  useEffect(() => () => {
    clearSaveTimer()
    // The iframe — and any unsaved edits inside it — go away with this
    // component; the tab's dirty dot must not outlive them.
    if (stateRef.current.dirty) useEditorStore.getState().clearModified(path)
  }, [useEditorStore, path])

  const reload = async () => {
    if (stateRef.current.dirty && !(await confirmAction(`"${name}" has unsaved changes. Discard them and reload?`))) return
    remount()
  }

  // Immersive maximize (immersive.ts): this viewer is the maximized panel's
  // focused tab and has nothing to save (bundles included) → its banners +
  // iframe region become a viewport overlay. Pure CSS: the iframe is never
  // reparented or remounted.
  const immersive = useContext(ImmersivePane) === path && isImmersiveViewer(info)
  const [pillOpen, setPillOpen] = useState(false)
  const [pill] = useState(() => createExitPill(setPillOpen))
  const [coarse] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches)
  // The pill exits only for a press that started on it: a touch tap in the
  // band widens the pill on pointerdown, and that tap's click would otherwise
  // land on the pill that just grew under the finger.
  const pillPressRef = useRef(false)
  // Bumped on every iframe `load`: each document needs its own listeners.
  const [frameLoads, setFrameLoads] = useState(0)
  const focusFrame = () => {
    const el = iframeRef.current
    el?.focus()
    el?.contentWindow?.focus()
  }

  useEffect(() => {
    if (!immersive) return
    const release = claimImmersive()
    pill.start()
    // Real fullscreen only when the maximize click armed it (a maximize
    // restored from localStorage has no user activation to spend). Left
    // only if we entered it; the browser / Electron ending it (Esc) ends
    // immersive too — one Esc, one exit.
    let entered = false
    let done = false
    const root = document.documentElement
    if (takeFullscreenArm() && !document.fullscreenElement && root.requestFullscreen) {
      root.requestFullscreen().then(() => {
        entered = true
        if (done) void document.exitFullscreen().catch(() => { /* already left */ })
      }, () => { /* refused (no activation / policy): immersive without it */ })
    }
    // A user Esc fully exits every fullscreen level; when the viewer had its
    // own (an emulator — then our iframe is the parent's fullscreenElement)
    // that Esc was meant for the viewer, so immersive stays.
    let prevFs = document.fullscreenElement
    const onFullscreen = () => {
      const now = document.fullscreenElement
      const viewerHadIt = prevFs !== null && prevFs !== root
      prevFs = now
      if (!entered || now) return
      entered = false
      if (!viewerHadIt) exitImmersive()
    }
    // pointermove, mouse only: a touch tap's compat mousemove would pin the pill.
    const onMove = (e: PointerEvent) => { if (e.pointerType === 'mouse') pill.move(e.clientY) }
    const onLeave = () => pill.move(Infinity)
    const onDown = (e: PointerEvent) => { if (e.pointerType !== 'mouse') pill.tap(e.clientY) }
    document.addEventListener('fullscreenchange', onFullscreen)
    window.addEventListener('pointermove', onMove)
    root.addEventListener('mouseleave', onLeave)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      done = true
      document.removeEventListener('fullscreenchange', onFullscreen)
      window.removeEventListener('pointermove', onMove)
      root.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('pointerdown', onDown, true)
      pill.dispose()
      release()
      if (entered && document.fullscreenElement === root) void document.exitFullscreen().catch(() => { /* already left */ })
      // Keys keep going to the viewer, not to the vanished exit control.
      if (takeRefocus()) focusFrame()
    }
  }, [immersive, pill])

  // Same-origin iframe (allow-same-origin): its keys / pointer never reach
  // this window, so Esc and the top band are watched inside it, per document.
  useEffect(() => {
    if (!immersive || frameLoads === 0) return
    const frame = iframeRef.current
    const win = frame?.contentWindow
    if (!frame || !win) return
    const top = () => frame.getBoundingClientRect().top
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // The viewer's own fullscreen (e.g. an emulator) takes this Esc.
      if (win.document.fullscreenElement) return
      e.preventDefault()
      e.stopPropagation()
      exitImmersive()
    }
    const onMove = (e: PointerEvent) => { if (e.pointerType === 'mouse') pill.move(e.clientY + top()) }
    const onLeave = () => pill.move(Infinity)
    const onDown = (e: PointerEvent) => { if (e.pointerType !== 'mouse') pill.tap(e.clientY + top()) }
    let doc: Document | null = null
    try {
      doc = win.document
      win.addEventListener('keydown', onKey, true)
      win.addEventListener('pointermove', onMove)
      win.addEventListener('pointerdown', onDown, true)
      doc.documentElement.addEventListener('mouseleave', onLeave)
    } catch { /* cross-origin document (navigated away) — parent-side Esc / pill still work */ }
    focusFrame()
    return () => {
      try {
        win.removeEventListener('keydown', onKey, true)
        win.removeEventListener('pointermove', onMove)
        win.removeEventListener('pointerdown', onDown, true)
        doc?.documentElement.removeEventListener('mouseleave', onLeave)
      } catch { /* document already gone */ }
    }
  }, [immersive, frameLoads, pill])

  const canSave = info.capabilities.includes('save')
  const toolbar = canSave ? (
    <ToolbarButton onClick={requestSave} title={t('editor.extension.save')}>
      <span>{t('editor.extension.save')}</span>
    </ToolbarButton>
  ) : undefined

  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText} extraToolbar={toolbar} hideHeader={immersive}>
      <div data-immersive={immersive || undefined} className={cn('flex h-full flex-col', immersive && 'fixed inset-0 z-[70] bg-[var(--background)]')}>
        {uninstalled && <Banner>{t('editor.extension.uninstalled')}</Banner>}
        {upgradeNotice && (
          <Banner onClose={() => setUpgradeNotice(null)}>
            {upgradeNotice}
            <button onClick={reload} className="ml-2 text-[var(--primary)] hover:underline">{t('editor.extension.reload')}</button>
          </Banner>
        )}
        {message && phase !== 'failed' && <Banner onClose={() => setMessage(null)}>{message}</Banner>}
        {exported && (
          <Banner onClose={() => setExported(null)}>
            {t('editor.extension.exported', { path: exported.path })}
            <a href={exported.url} download className="ml-2 text-[var(--primary)] hover:underline">{t('editor.download')}</a>
          </Banner>
        )}
        {phase === 'failed' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm text-[var(--foreground)]">{t('editor.extension.unresponsive', { name: info.name })}</p>
            {message && <p className="text-xs text-[var(--muted-foreground)]">{message}</p>}
            <div className="flex items-center gap-2">
              <button
                onClick={reload}
                className="inline-flex items-center rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90"
              >
                {t('editor.extension.retry')}
              </button>
              {onOpenAsText && (
                <button
                  onClick={onOpenAsText}
                  className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--secondary)] px-4 py-2 text-xs font-medium text-[var(--foreground)] hover:opacity-90"
                >
                  {t('editor.openAsText')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            {src && (
              <iframe
                key={attempt}
                ref={iframeRef}
                src={src}
                sandbox="allow-scripts allow-same-origin"
                allow={info.capabilities.includes('media') ? MEDIA_ALLOW : ''}
                referrerPolicy="no-referrer"
                title={info.name}
                className="h-full w-full border-0 bg-[var(--background)]"
                onLoad={() => setFrameLoads((n) => n + 1)}
              />
            )}
            {phase !== 'ready' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 text-sm text-[var(--muted-foreground)]">
                Loading preview...
              </div>
            )}
          </div>
        )}
        {picking && projectId && (
          <FilePicker workspace={toSlash(projectId)} accept={picking.accept} start={picking.start} onDone={(f) => { void onPicked(f) }} />
        )}
        {immersive && (
          // Mouse: top-center, only while the pointer is near the top (no
          // hot-zone over the iframe — the band is watched by listeners).
          // Touch: always on screen, so it sits top-left — where viewers put
          // their title label (megadrive / arcade toolbars keep buttons
          // centre-right) — as a compact ×; a tap in the band widens it.
          <button
            type="button"
            onPointerDown={() => { pillPressRef.current = true }}
            onClick={(e) => {
              const pressed = pillPressRef.current
              pillPressRef.current = false
              if (pressed || e.detail === 0) exitImmersive() // detail 0 = keyboard activation
            }}
            // Appearing under the cursor fires the iframe document's mouseleave
            // (→ hide timer); being hovered pins it like the band does.
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') pill.move(0) }}
            aria-label={t('editor.immersive.exit')}
            className={cn(
              'absolute z-10 flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)]/90 text-xs text-[var(--foreground)] shadow-lg backdrop-blur transition-all duration-200',
              coarse ? 'left-2' : 'left-1/2 -translate-x-1/2',
              pillOpen
                ? 'top-2 h-7 gap-1 px-3 opacity-100'
                : coarse
                  ? 'top-1.5 h-7 w-7 opacity-60'
                  : 'pointer-events-none -top-2 h-7 px-3 opacity-0',
            )}
          >
            {pillOpen || !coarse ? t('editor.immersive.exit') : '×'}
          </button>
        )}
      </div>
    </PreviewShell>
  )
}

function Banner({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--foreground)]">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {onClose && (
        <button onClick={onClose} className="shrink-0 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" aria-label="Dismiss">×</button>
      )}
    </div>
  )
}

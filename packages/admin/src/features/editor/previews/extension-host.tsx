'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { api } from '@/shared/api-client'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { useTheme } from '@/shared/theme'
import { readHostTheme } from '@/shared/theme/palette'
import { useI18n } from '@/shared/i18n'
import { confirmAction } from '@/shared/utils'
import { PreviewShell, ToolbarButton } from './ui/preview-shell'
import { extensionEntryUrl, getExtensionToken } from './extension-token'
import { currentPlatform } from './registry'
import {
  createKeyedQueue, initialHostState, isClientFrame, onClientFrame, onConflictChoice, onFileChanged, onFsResult, onLoaded,
  onLangChange, onPutResult, onSaveRequest, onThemeChange, registerExtensionHost,
  type FsOutcome, type HostContext, type HostEffect, type HostState, type Step,
} from './extension-host-logic'
import type { PreviewProps } from './types'

const READY_TIMEOUT_MS = 10_000
const SAVE_TIMEOUT_MS = 5_000
/** `media` capability: mic + screen capture (+ copy). Everyone else gets nothing. */
const MEDIA_ALLOW = 'microphone; display-capture; clipboard-write'

async function httpFailure(res: Response): Promise<FsOutcome> {
  const body = await res.json().catch(() => ({})) as { error?: string }
  return { ok: false, status: res.status, message: body.error ?? res.statusText }
}

/** Run one validated bundle `fs` request (protocol §3) against the files API;
 *  `eff.path` is bundle-relative, '' = the bundle root (list only). */
async function execBundleFs(projectId: string, bundlePath: string, eff: Extract<HostEffect, { type: 'fs' }>): Promise<FsOutcome> {
  const full = eff.path ? `${bundlePath}/${eff.path}` : bundlePath
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
  const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null)
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
        const exec = () => execBundleFs(projectId, path, eff)
        const pending = eff.op === 'write' || eff.op === 'append'
          ? fsQueueRef.current.run(eff.path, exec)
          : exec()
        void pending.then((outcome) => {
          if (attemptRef.current !== issuedFor) return
          run(onFsResult(stateRef.current, eff.id, outcome))
        })
        return
      }
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

  const canSave = info.capabilities.includes('save')
  const toolbar = canSave ? (
    <ToolbarButton onClick={requestSave} title={t('editor.extension.save')}>
      <span>{t('editor.extension.save')}</span>
    </ToolbarButton>
  ) : undefined

  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText} extraToolbar={toolbar}>
      <div className="flex h-full flex-col">
        {uninstalled && <Banner>{t('editor.extension.uninstalled')}</Banner>}
        {upgradeNotice && (
          <Banner onClose={() => setUpgradeNotice(null)}>
            {upgradeNotice}
            <button onClick={reload} className="ml-2 text-[var(--primary)] hover:underline">{t('editor.extension.reload')}</button>
          </Banner>
        )}
        {message && phase !== 'failed' && <Banner onClose={() => setMessage(null)}>{message}</Banner>}
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
              />
            )}
            {phase !== 'ready' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 text-sm text-[var(--muted-foreground)]">
                Loading preview...
              </div>
            )}
          </div>
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

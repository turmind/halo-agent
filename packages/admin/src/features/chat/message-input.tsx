'use client'

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { Send, Paperclip, X, FileIcon, Square, MonitorUp, Camera, Sparkles } from 'lucide-react'
import { cn, getLanguageFromPath } from '@/shared/utils'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { useChatStore } from '@/features/chat/chat-store'
import { postToFace } from '@/features/editor/face-bridge'
import { matchCommands, matchVerbs, getCommands, type SlashCommand } from './slash-commands'
import { CommandPalette } from './command-palette'
import { FileMentionPicker } from './file-mention-picker'
import { useT } from '@/shared/i18n'

/** Read a File to a base64 string (no data URL prefix), verbatim. */
function rawFileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Long-edge cap for outgoing images. Claude's vision pipeline downsamples
// anything larger anyway, so sending a 4000px phone photo just wastes upload
// bandwidth and tokens. 1568 is Anthropic's documented max useful edge.
const IMG_MAX_EDGE = 1568
const IMG_JPEG_QUALITY = 0.85

/**
 * Convert an image File to a compressed base64 JPEG (no data URL prefix):
 * decode → downscale so the long edge ≤ IMG_MAX_EDGE → re-encode as JPEG 0.85.
 * This is the single choke point for every attachment path (file picker, drag,
 * paste), matching the camera/screenshot compression. Falls back to the raw
 * bytes if the browser can't decode it (non-raster, decode error) so we never
 * silently drop an attachment. Returns { base64, mimeType }.
 */
async function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  if (!file.type.startsWith('image/')) {
    return { base64: await rawFileToBase64(file), mimeType: file.type || 'application/octet-stream' }
  }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, IMG_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const dataUrl = canvas.toDataURL('image/jpeg', IMG_JPEG_QUALITY)
    const base64 = dataUrl.split(',')[1]
    if (!base64) throw new Error('encode failed')
    return { base64, mimeType: 'image/jpeg' }
  } catch {
    // Decode/encode failed — send the original rather than lose the image.
    return { base64: await rawFileToBase64(file), mimeType: file.type || 'image/png' }
  }
}

/** Desktop-shell capture bridge (preload injects it). Undefined in a browser. */
interface CaptureSrc { id: string; name: string; thumb: string | null; blank: boolean; icon: string | null }
interface HaloCapture {
  list: () => Promise<CaptureSrc[]>
  grab: (id: string) => Promise<string | null>
  permission: () => Promise<'granted' | 'denied' | 'not-determined' | 'restricted'>
  openSettings: () => void
}
function getHaloCapture(): HaloCapture | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { haloCapture?: HaloCapture }).haloCapture
}

/** Desktop-shell webcam bridge (preload injects it). Undefined in a browser.
 *  Counterpart to HaloCapture for the camera — `snap` grabs a still JPEG. */
interface HaloCamera {
  has: () => Promise<boolean>
  snap: (deviceId?: string) => Promise<string | null>
  list: () => Promise<Array<{ deviceId: string; label: string }>>
  requestPermission: () => Promise<boolean>
  openSettings: () => void
}
function getHaloCamera(): HaloCamera | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { haloCamera?: HaloCamera }).haloCamera
}

/** Process-local cache of which model ids support image input, built from the
 *  models registry (`/agent-configs/models`). The registry is effectively
 *  static for a session, so we fetch it once. */
let imageModelCache: Record<string, boolean> | null = null
let imageModelCachePromise: Promise<Record<string, boolean>> | null = null
function loadImageModelMap(): Promise<Record<string, boolean>> {
  if (imageModelCache) return Promise.resolve(imageModelCache)
  if (!imageModelCachePromise) {
    imageModelCachePromise = api.agentConfigs.models()
      .then((res) => {
        const map: Record<string, boolean> = {}
        for (const p of res.providers) {
          for (const m of p.models) map[m.id] = !!m.capabilities?.image
        }
        imageModelCache = map
        return map
      })
      .catch(() => ({}))
  }
  return imageModelCachePromise
}

/**
 * Whether the currently-selected agent's model accepts image input. Capture is
 * pointless (the frame can't be sent) on a text-only model, so the control
 * hides itself. Resolves the agent → its modelId (agent-configs list) → the
 * registry's `capabilities.image`. Defaults to `true` until both loads resolve
 * so the button doesn't flicker out on a vision model. Unknown / custom model
 * ids (not in the registry) also default to allowed — we don't want to hide a
 * working capability over a registry gap.
 */
function useCurrentModelSupportsImage(): boolean {
  const selectedAgentId = useChatStore((s) => s.selectedAgentId)
  const activeProjectPath = useProjectStore((s) => s.activeProject?.path)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    if (!activeProjectPath) return
    let cancelled = false
    Promise.all([
      api.agentConfigs.list(activeProjectPath),
      loadImageModelMap(),
    ]).then(([cfg, imageMap]) => {
      if (cancelled) return
      const agent = cfg.agents.find((a) => a.id === selectedAgentId) ?? cfg.agents[0]
      const modelId = agent?.model
      // No model id, or a model the registry doesn't list → assume capable
      // (don't hide a real capability over missing registry data).
      if (!modelId || !(modelId in imageMap)) { setSupported(true); return }
      setSupported(imageMap[modelId])
    }).catch(() => { if (!cancelled) setSupported(true) })
    return () => { cancelled = true }
  }, [selectedAgentId, activeProjectPath])

  return supported
}

const FACE_PATH = '.halo/canvas/self.html'

/**
 * Face control — opens the assistant's living self-portrait (`self.html`) in the
 * editor preview. The face is seeded into every workspace (server init) and is
 * pure HTML/canvas, so unlike CaptureControl this is NOT gated on any desktop
 * bridge — it works in a plain browser too. Opening it switches to the Explorer
 * activity tab and opens the file; render mode defaults to on, so it lands on
 * the live face. If a preview is already mounted, re-fire the intro so there's
 * always a greeting when a human turns to look.
 */
function FaceControl() {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)
  if (!activeProject) return null

  const openFace = async () => {
    const projectId = activeProject.id
    try {
      const data = await api.files.read(FACE_PATH, projectId)
      window.dispatchEvent(new CustomEvent('halo:navigate', { detail: { tab: 'explorer' } }))
      useEditorStore.getState().openFile(
        FACE_PATH, data.content, getLanguageFromPath(FACE_PATH), data.modifiedAt,
        { size: data.size, createdAt: data.createdAt },
      )
      // Greet whoever just turned to look — the moment of being seen is the
      // whole point. A tick after open so the iframe has mounted + registered.
      setTimeout(() => postToFace('self.intro()'), 400)
    } catch {
      // First-open race (seeded on workspace open, but be defensive) — no-op.
    }
  }

  return (
    <button
      onClick={openFace}
      title={t('face.button')}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
    >
      <Sparkles className="h-4 w-4" />
    </button>
  )
}

/**
 * Camera picker with a live preview. Shown when there's more than one webcam so
 * the user can see each one before binding — handy for aiming an external cam
 * (e.g. pointing it at a desk to photograph homework). Owns the preview
 * getUserMedia stream and tears it down on device-switch / close / unmount so
 * the camera light doesn't stay on. The preview runs in the renderer directly
 * (Electron has getUserMedia); the actual capture still goes through
 * haloCamera.snap with the chosen deviceId.
 */
function CameraPicker({ cameras, activeId, onPick, onTurnOff, onClose }: {
  cameras: Array<{ deviceId: string; label: string }>
  activeId: string | null
  onPick: (c: { deviceId: string; label: string }) => void
  onTurnOff?: () => void
  onClose: () => void
}) {
  const t = useT()
  // Which device is being previewed (defaults to the active/remembered one, else first).
  const [previewId, setPreviewId] = useState<string>(activeId || cameras[0]?.deviceId || '')
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  // (Re)open the preview stream whenever the previewed device changes; always
  // stop the previous stream first. Cleanup on unmount stops the camera.
  useEffect(() => {
    let cancelled = false
    const stop = () => {
      if (streamRef.current) {
        for (const tr of streamRef.current.getTracks()) tr.stop()
        streamRef.current = null
      }
    }
    stop()
    navigator.mediaDevices.getUserMedia({
      video: previewId ? { deviceId: { exact: previewId } } : true,
      audio: false,
    }).then((s) => {
      if (cancelled) { for (const tr of s.getTracks()) tr.stop(); return }
      streamRef.current = s
      if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}) }
    }).catch(() => { /* device busy / denied — preview just stays blank */ })
    return () => { cancelled = true; stop() }
  }, [previewId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3" onClick={onClose}>
      <div className="flex w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <span className="text-sm font-medium text-[var(--foreground)]">{t('capture.cameraPick')}</span>
          <button onClick={onClose} className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Live preview */}
        <video ref={videoRef} muted playsInline className="aspect-video w-full bg-black object-contain" />
        {/* Device list */}
        <div className="flex flex-col gap-1 p-2">
          {cameras.map((c) => (
            <button
              key={c.deviceId}
              onClick={() => setPreviewId(c.deviceId)}
              title={c.label}
              className={cn(
                'flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--secondary)]',
                previewId === c.deviceId ? 'text-[var(--primary)]' : 'text-[var(--foreground)]',
              )}
            >
              <Camera className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {activeId === c.deviceId && <span className="shrink-0 text-[10px]">{t('capture.cameraCurrent')}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3">
          {onTurnOff ? (
            <button onClick={onTurnOff} className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              {t('capture.cameraBound')}
            </button>
          ) : <span />}
          <button
            onClick={() => { const c = cameras.find((x) => x.deviceId === previewId); if (c) onPick(c) }}
            className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            {t('capture.cameraUse')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Capture control — lets the user share something for the LLM to look at on
 * demand (via the <<<CAPTURE>>> marker, see use-chat / chat-handlers). Two
 * sources, mutually exclusive (only one bound at a time, like a meeting app's
 * "share screen OR camera"):
 *   • screen/window — picked from a grid, grabbed via desktopCapturer (main).
 *   • webcam — a one-click toggle, grabbed via getUserMedia (renderer).
 * Desktop-only: renders nothing in a plain browser (no window.haloCapture).
 * Bound state lives in chat-store so use-chat (prompt injection) and
 * chat-handlers (frame grab) can read it.
 */
function CaptureControl() {
  const t = useT()
  const captureSource = useChatStore((s) => s.captureSource)
  const setCaptureSource = useChatStore((s) => s.setCaptureSource)
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<CaptureSrc[]>([])
  const [denied, setDenied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [cameraAvailable, setCameraAvailable] = useState(false)
  const [cameraDenied, setCameraDenied] = useState(false)
  // Multi-camera: list of webcams + a small picker. Empty/single → no picker,
  // the toggle binds directly. The chosen deviceId is remembered across opens.
  const [cameraList, setCameraList] = useState<Array<{ deviceId: string; label: string }>>([])
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const cap = getHaloCapture()
  const camera = getHaloCamera()
  const modelSupportsImage = useCurrentModelSupportsImage()

  // If the user switches to a text-only model while a source is bound, drop the
  // binding — the frame could no longer be sent, and the control is about to
  // hide.
  useEffect(() => {
    if (!modelSupportsImage && captureSource) setCaptureSource(null)
  }, [modelSupportsImage, captureSource, setCaptureSource])

  // Is there a webcam on this machine? ("先判断有没有摄像头") — hide the camera
  // button entirely when none is present. Only meaningful on a vision model in
  // the desktop shell.
  useEffect(() => {
    if (!camera || !modelSupportsImage) { setCameraAvailable(false); return }
    let cancelled = false
    camera.has().then((ok) => { if (!cancelled) setCameraAvailable(ok) }).catch(() => {})
    return () => { cancelled = true }
  }, [camera, modelSupportsImage])

  useEffect(() => {
    if (!open && !cameraMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setCameraMenuOpen(false) }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setCameraMenuOpen(false) }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, cameraMenuOpen])

  // Desktop shell only — a browser has no capture bridge. Also hidden when the
  // selected agent's model can't accept images (capture would be unsendable).
  if ((!cap && !camera) || !modelSupportsImage) return null

  const openPicker = async () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    setLoading(true)
    try {
      const list = await cap!.list()
      setSources(list)
      // Permission check: the ONLY honest signal is a blank SCREEN thumbnail —
      // if Screen Recording is granted, the whole-screen source always renders.
      // getMediaAccessStatus('screen') is unreliable on macOS (returns non-
      // 'granted' even when authorized), so relying on it made the amber hint
      // pop up spuriously every time — drop it. A blank *window* is not a
      // permission signal either (just off-screen/minimized/another Space).
      const screens = list.filter((s) => s.id.startsWith('screen:'))
      setDenied(screens.length > 0 && screens.every((s) => s.blank))
    } catch {
      setSources([])
    } finally {
      setLoading(false)
    }
  }

  // Bind a specific camera. id '' = browser default (single-camera / unknown).
  // Persist the choice so the next session reuses the same physical camera.
  const bindCamera = (deviceId: string, label?: string) => {
    setCameraDenied(false)
    setCameraMenuOpen(false)
    if (deviceId) { try { localStorage.setItem('halo.cameraId', deviceId) } catch { /* ignore */ } }
    setCaptureSource({ id: deviceId, name: label || t('capture.cameraName'), thumb: '', kind: 'camera' })
  }

  // Camera toggle: bound→reopen the picker (to re-aim, switch device, or turn
  // off); otherwise request the camera permission (prompts on first use) and
  // open the picker. The picker always shows a live preview — even with a
  // single camera — so the user can frame the shot (e.g. aim a desk cam at
  // homework) before binding. labels populate only after the grant, so list()
  // runs after requestPermission.
  const toggleCamera = async () => {
    if (captureSource?.kind === 'camera') { setCameraMenuOpen((v) => !v); return }
    const granted = await camera!.requestPermission()
    if (!granted) { setCameraDenied(true); return }
    const list = await camera!.list()
    if (list.length === 0) { bindCamera('', undefined); return } // no enumerable device — bind default
    setCameraList(list)
    setCameraMenuOpen(true)
  }

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      {cap && (
        <button
          onClick={openPicker}
          title={captureSource?.kind === 'screen' ? t('capture.bound', { name: captureSource.name }) : t('capture.button')}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--secondary)]',
            captureSource?.kind === 'screen' ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
          )}
        >
          <MonitorUp className="h-4 w-4" />
        </button>
      )}
      {camera && cameraAvailable && (
        <button
          onClick={toggleCamera}
          title={captureSource?.kind === 'camera' ? t('capture.cameraBound') : t('capture.cameraButton')}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--secondary)]',
            captureSource?.kind === 'camera' ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
          )}
        >
          <Camera className="h-4 w-4" />
        </button>
      )}
      {captureSource && (
        <div className="flex items-center gap-1 rounded-full border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-1.5 py-0.5 text-[10px] text-[var(--primary)]">
          {captureSource.kind === 'camera' ? (
            <Camera className="h-3.5 w-3.5" />
          ) : captureSource.thumb ? (
            <img src={captureSource.thumb} alt="" className="h-3.5 w-3.5 rounded-sm object-cover" />
          ) : (
            <MonitorUp className="h-3.5 w-3.5" />
          )}
          <span className="max-w-24 truncate">{captureSource.name}</span>
          <button onClick={() => setCaptureSource(null)} title={t('capture.unbind')}
            className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--primary)]/20">
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      )}
      {cameraDenied && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-md border border-amber-500/30 bg-[var(--background)] p-2.5 text-xs text-amber-300 shadow-lg">
          <div>{t('capture.cameraPermissionHint')}</div>
          <div className="mt-1.5 flex items-center gap-3">
            <button onClick={() => camera!.openSettings()} className="underline hover:text-amber-200">
              {t('capture.openSettings')}
            </button>
            <button onClick={() => setCameraDenied(false)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              {t('capture.dismiss')}
            </button>
          </div>
        </div>
      )}
      {cameraMenuOpen && cameraList.length >= 1 && (
        <CameraPicker
          cameras={cameraList}
          activeId={captureSource?.kind === 'camera' ? captureSource.id : null}
          onPick={(c) => bindCamera(c.deviceId, c.label)}
          onTurnOff={captureSource?.kind === 'camera' ? () => { setCaptureSource(null); setCameraMenuOpen(false) } : undefined}
          onClose={() => setCameraMenuOpen(false)}
        />
      )}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex h-[92vh] w-[96vw] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <span className="text-sm font-medium text-[var(--foreground)]">{t('capture.pickTitle')}</span>
              <button onClick={() => setOpen(false)} className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {denied && (
                <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  <div>{t('capture.permissionHint')}</div>
                  <button onClick={() => cap!.openSettings()} className="mt-1.5 underline hover:text-amber-200">
                    {t('capture.openSettings')}
                  </button>
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-xs text-[var(--muted-foreground)]">{t('capture.loading')}</div>
              ) : sources.length === 0 ? (
                <div className="py-8 text-center text-xs text-[var(--muted-foreground)]">{t('capture.empty')}</div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {sources.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { setCaptureSource({ id: s.id, name: s.name, thumb: s.thumb ?? '', kind: 'screen' }); setOpen(false) }}
                      title={s.name}
                      className="flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-lg border border-[var(--border)] p-2 text-left transition-colors hover:border-[var(--primary)] hover:bg-[var(--secondary)]"
                    >
                      {s.thumb ? (
                        <img src={s.thumb} alt={s.name} className="aspect-video w-full rounded object-cover bg-black/20" />
                      ) : (
                        <div className="flex aspect-video w-full items-center justify-center rounded bg-black/20 text-[10px] text-[var(--muted-foreground)]">
                          {t('capture.noPreview')}
                        </div>
                      )}
                      <div className="flex min-w-0 items-center gap-1.5">
                        {s.icon && <img src={s.icon} alt="" className="h-4 w-4 shrink-0" />}
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">{s.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface MessageInputProps {
  onSend: (text: string, images?: Array<{ data: string; mimeType: string }>, mentionedFiles?: string[]) => void
  disabled?: boolean
  isStreaming?: boolean
  onStop?: () => void
  /** esc while streaming: interrupt the in-flight turn (queued messages then
   *  run as one follow-up). Distinct from onStop. */
  onInterrupt?: () => void
  pendingMessages?: string[]
  onRemovePending?: (index: number) => void
  onCommand?: (cmd: SlashCommand, args: string) => void
  onCompact?: () => void
  renderLeftControls?: () => React.ReactNode
}

interface PendingFile {
  file: File
  preview?: string // data URL for images
}

/** Small ring showing context window usage — click to compact when usage is high */
function TokenRing({ onCompact }: { onCompact?: () => void }) {
  const messages = useChatStore((s) => s.messages)
  const serverContextTokens = useChatStore((s) => s.contextTokens)
  const maxTokens = useChatStore((s) => s.maxContextTokens)
  const isCompacting = useChatStore((s) => s.isCompacting)
  const isStreaming = useChatStore((s) => s.isStreaming)

  // Prefer server-reported value. If server has reported 0 (e.g. right after a
  // compact), treat it as truth and hide the ring until the next usage event
  // re-populates it. Only fall back to a client estimate when the server has
  // never spoken (no messages yet vs. an active session with just-compacted state).
  const estimated = useMemo(() => {
    if (serverContextTokens > 0) return serverContextTokens
    // No context left and no in-flight generation — hide entirely
    return 0
  }, [serverContextTokens])

  // Hide until we know maxTokens. Default is 0 in the store; a real value
  // arrives via `state:snapshot` once the WS subscribe completes. Without
  // this guard the ring would briefly render against the placeholder limit
  // (e.g. show 2.5% full for an agent actually capped at 20K).
  if (estimated === 0 || messages.length === 0 || maxTokens === 0) return null
  const pct = Math.min((estimated / maxTokens) * 100, 100)
  const kTokens = (estimated / 1000).toFixed(2)
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (pct / 100) * circumference
  const color = isCompacting ? '#3b82f6' : pct < 50 ? '#22c55e' : pct < 70 ? '#eab308' : pct < 85 ? '#f97316' : '#ef4444'
  const canCompact = messages.length > 5 && onCompact && !isCompacting && !isStreaming

  return (
    <div
      className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', canCompact && 'cursor-pointer hover:bg-[var(--secondary)]')}
      title={isCompacting ? 'Compacting...' : `~${kTokens}K / ${maxTokens / 1000}K tokens (${Math.round(pct)}%)${canCompact ? '\nClick to compact context' : ''}`}
      onClick={canCompact ? onCompact : undefined}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" className={cn('transform -rotate-90', isCompacting && 'animate-pulse')}>
        <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--muted-foreground)" strokeWidth="2.5" opacity="0.3" />
        <circle cx="11" cy="11" r={radius} fill="none" stroke={color} strokeWidth="2.5"
          strokeDasharray={circumference} strokeDashoffset={dashOffset} strokeLinecap="round"
          className="transition-all duration-300" />
      </svg>
    </div>
  )
}

export function MessageInput({ onSend, disabled, isStreaming, onStop, onInterrupt, pendingMessages, onRemovePending, onCommand, onCompact, renderLeftControls }: MessageInputProps) {
  const selectedText = useEditorStore((s) => s.selectedText)
  const selectedRange = useEditorStore((s) => s.selectedRange)
  const activeTab = useEditorStore((s) => s.activeTab)
  const contextEnabled = useEditorStore((s) => s.contextEnabled)
  const setContextEnabled = useEditorStore((s) => s.setContextEnabled)
  const [text, setText] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [mentionedFiles, setMentionedFiles] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [cursorPos, setCursorPos] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeProject = useProjectStore((s) => s.activeProject)
  // -1 = not yet loaded (treat as allow). 0 = every agent disabled → block
  // sending, since no agent can pick up the message.
  const usableAgentCount = useChatStore((s) => s.usableAgentCount)
  const noUsableAgent = usableAgentCount === 0

  // Show context chip: prefer selection if available, otherwise show active file
  const contextLabel = useMemo(() => {
    if (selectedText && activeTab) {
      const file = activeTab.split('/').pop() ?? activeTab
      const range = selectedRange ? `:${selectedRange.startLine}-${selectedRange.endLine}` : ''
      return `${file}${range} (${selectedText.length} chars)`
    }
    if (activeTab) {
      return activeTab.split('/').pop() ?? activeTab
    }
    return null
  }, [selectedText, selectedRange, activeTab])

  const matchedCmds = useMemo(() => {
    // Command palette only while typing the command word itself. Once a space
    // is present the user is in verb/args territory — re-showing the command's
    // own row there (e.g. right after picking a verb: `/session list `) is
    // noise. Sending still works: handleSend resolves the command by exact
    // first-word lookup, independent of this palette list.
    if (!text.startsWith('/') || /\s/.test(text)) return []
    return matchCommands(text)
  }, [text])

  // Second-stage completion: `/agent ` typed in full → suggest its verbs.
  const matchedVerbs = useMemo(() => matchVerbs(text), [text])
  const [verbIndex, setVerbIndex] = useState(0)
  useEffect(() => { setVerbIndex(0) }, [matchedVerbs.length])
  const selectVerb = useCallback((v: { cmd: SlashCommand; verb: { name: string } }) => {
    setText(`${v.cmd.name} ${v.verb.name} `)
    textareaRef.current?.focus()
  }, [])

  // Detect @scope trigger first — `@scope <dir>` is a literal marker the server
  // expands (directory-scoped INSTRUCTIONS.md for the turn), so unlike @mention
  // it must stay in the text. Matches the explicit `@scope ` prefix; a bare `@`
  // still falls through to the file-mention picker below.
  const atScope = useMemo((): { startIdx: number; query: string } | null => {
    const before = text.slice(0, cursorPos)
    const match = before.match(/(^|\s)@scope\s+(\S*)$/)
    if (!match) return null
    const startIdx = match.index! + match[1].length
    return { startIdx, query: match[2] }
  }, [text, cursorPos])

  // Detect @mention trigger: @ preceded by start-of-string or whitespace, followed by non-whitespace
  const atMention = useMemo((): { startIdx: number; query: string } | null => {
    if (atScope) return null  // @scope owns the input — don't also fire the file picker
    const before = text.slice(0, cursorPos)
    const match = before.match(/(^|\s)@(\S*)$/)
    if (!match) return null
    const startIdx = match.index! + match[1].length
    return { startIdx, query: match[2] }
  }, [text, cursorPos, atScope])

  // Search files via backend when @mention active (debounced)
  const [mentionMatches, setMentionMatches] = useState<string[]>([])
  useEffect(() => {
    if (!atMention || mentionDismissed || !activeProject) {
      setMentionMatches([])
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      api.files
        .search(activeProject.id, atMention.query, 15)
        .then((res) => { if (!cancelled) setMentionMatches(res.matches.map((m) => m.path)) })
        .catch(() => { if (!cancelled) setMentionMatches([]) })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [atMention, mentionDismissed, activeProject])

  const selectMention = useCallback((filePath: string) => {
    if (!atMention) return
    const before = text.slice(0, atMention.startIdx)
    const after = text.slice(atMention.startIdx + 1 + atMention.query.length)
    const newText = before + after
    setText(newText)
    setMentionedFiles((prev) => prev.includes(filePath) ? prev : [...prev, filePath])
    setMentionIndex(0)
    setMentionDismissed(false)
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = before.length
        textareaRef.current.selectionStart = pos
        textareaRef.current.selectionEnd = pos
        textareaRef.current.focus()
        setCursorPos(pos)
      }
    })
  }, [text, atMention])

  // Search directories for @scope completion (debounced). dirsOnly so we only
  // ever suggest directories — @scope targets a dir, not a file.
  const [scopeMatches, setScopeMatches] = useState<string[]>([])
  const [scopeIndex, setScopeIndex] = useState(0)
  useEffect(() => {
    if (!atScope || !activeProject) { setScopeMatches([]); return }
    let cancelled = false
    const handle = setTimeout(() => {
      api.files
        .search(activeProject.id, atScope.query, 15, true)
        .then((res) => { if (!cancelled) setScopeMatches(res.matches.map((m) => m.path)) })
        .catch(() => { if (!cancelled) setScopeMatches([]) })
    }, 120)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [atScope, activeProject])

  // Replace the in-flight `@scope <query>` with `@scope <dir> ` — kept as
  // literal text (with a trailing space) so the server expands it on send.
  // The marker spans startIdx..cursorPos (the regex anchors at the caret), so
  // slicing at cursorPos is robust to any spacing between `@scope` and the query.
  const selectScope = useCallback((dirPath: string) => {
    if (!atScope) return
    const before = text.slice(0, atScope.startIdx)
    const after = text.slice(cursorPos)
    const insert = `@scope ${dirPath} `
    const newText = before + insert + after
    setText(newText)
    setScopeIndex(0)
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = before.length + insert.length
        textareaRef.current.selectionStart = pos
        textareaRef.current.selectionEnd = pos
        textareaRef.current.focus()
        setCursorPos(pos)
      }
    })
  }, [text, atScope, cursorPos])

  const removeMention = useCallback((filePath: string) => {
    setMentionedFiles((prev) => prev.filter((p) => p !== filePath))
  }, [])

  const selectCommand = useCallback((cmd: SlashCommand) => {
    const parts = text.split(/\s+/)
    const typed = parts[0] ?? ''
    const args = parts.slice(1).join(' ')
    // Commands that take arguments (argHint set — e.g. `/agent <verb>`,
    // `/switch <n>`): selecting from a PARTIAL prefix (`/ag`) completes the
    // name and waits for the argument. If the full name is already typed
    // (`/agent` + Enter again), send it as-is — a bare object command returns
    // its action list server-side, so this never loops.
    if (cmd.argHint && !args && typed !== cmd.name) {
      setText(cmd.name + ' ')
      setCmdIndex(0)
      textareaRef.current?.focus()
      return
    }
    onCommand?.(cmd, args)
    setText('')
    setCmdIndex(0)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [text, onCommand])

  const addFiles = useCallback((fileList: FileList | File[]) => {
    // Chat attachments are images only — they go to the model as vision input.
    // Real file uploads have their own entry points (file explorer / editor),
    // so drag/paste of non-images here is dropped rather than silently dumped
    // into the workspace root.
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'))
    const newPending: PendingFile[] = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }))
    setPendingFiles((prev) => [...prev, ...newPending])
  }, [])

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const removed = prev[index]
      if (removed?.preview) URL.revokeObjectURL(removed.preview)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && pendingFiles.length === 0) return
    // Every agent is disabled — nothing can answer, so don't let the message go.
    if (noUsableAgent) return

    // A verb candidate is highlighted (e.g. `/skill dis` → disable): Enter
    // completes it instead of sending the partial verb as an argument.
    if (matchedVerbs.length > 0) {
      const v = matchedVerbs[verbIndex] ?? matchedVerbs[0]
      selectVerb(v)
      return
    }
    if (trimmed.startsWith('/')) {
      // Palette open (typing the command word): Enter picks the highlighted
      // candidate (completes if it needs args, fires if it doesn't).
      if (matchedCmds.length > 0) {
        selectCommand(matchedCmds[cmdIndex] ?? matchedCmds[0])
        return
      }
      // No palette (args already typed, e.g. `/session list`): resolve the
      // command by exact first-word match and fire it with the args.
      const exact = getCommands().find((c) => c.name === trimmed.split(/\s+/)[0]?.toLowerCase())
      if (exact) {
        selectCommand(exact)
        return
      }
      // Unknown /word → fall through and send as a chat message.
    }

    // Attachments are images only (addFiles filters non-images out). Convert
    // them to base64 for vision input.
    const imageDataList: Array<{ data: string; mimeType: string }> = []
    for (const pf of pendingFiles) {
      try {
        const { base64, mimeType } = await fileToBase64(pf.file)
        imageDataList.push({ data: base64, mimeType })
      } catch (err) {
        console.error('[MessageInput] Image conversion failed:', err)
      }
    }

    if (trimmed || imageDataList.length > 0) {
      onSend(
        trimmed || '(image)',
        imageDataList.length > 0 ? imageDataList : undefined,
        mentionedFiles.length > 0 ? mentionedFiles : undefined,
      )
    }

    pendingFiles.forEach((p) => { if (p.preview) URL.revokeObjectURL(p.preview) })
    setPendingFiles([])
    setMentionedFiles([])
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [text, pendingFiles, onSend, matchedCmds, cmdIndex, selectCommand, mentionedFiles, matchedVerbs, verbIndex, selectVerb, noUsableAgent])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // @scope directory picker navigation (checked before @mention — they're
      // mutually exclusive, atScope suppresses atMention).
      if (scopeMatches.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setScopeIndex((i) => Math.min(i + 1, scopeMatches.length - 1)); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setScopeIndex((i) => Math.max(i - 1, 0)); return }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
          e.preventDefault()
          const match = scopeMatches[scopeIndex]
          if (match) selectScope(match)
          return
        }
        if (e.key === 'Escape') { e.preventDefault(); setScopeMatches([]); return }
      }
      // @ mention picker navigation
      if (mentionMatches.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionMatches.length - 1)); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
          e.preventDefault()
          const match = mentionMatches[mentionIndex]
          if (match) selectMention(match)
          return
        }
        if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return }
      }
      // Command palette navigation
      // Verb stage first (it only matches when the command itself is complete,
      // so the two stages never overlap).
      if (matchedVerbs.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setVerbIndex((i) => Math.min(i + 1, matchedVerbs.length - 1)); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setVerbIndex((i) => Math.max(i - 1, 0)); return }
        if (e.key === 'Tab') { e.preventDefault(); const v = matchedVerbs[verbIndex]; if (v) selectVerb(v); return }
        if (e.key === 'Escape') { e.preventDefault(); setVerbIndex(0); return }
      }
      if (matchedCmds.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => Math.min(i + 1, matchedCmds.length - 1)); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => Math.max(i - 1, 0)); return }
        if (e.key === 'Escape') { e.preventDefault(); setText(''); setCmdIndex(0); return }
        if (e.key === 'Tab') { e.preventDefault(); const cmd = matchedCmds[cmdIndex]; if (cmd) setText(cmd.name + ' '); return }
      }
      // esc with no popup open + a turn running + empty composer → interrupt
      // the in-flight turn. Empty-composer guard so esc still clears a draft.
      if (e.key === 'Escape' && isStreaming && !text.trim() && onInterrupt) {
        e.preventDefault(); onInterrupt(); return
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleSend() }
    },
    [handleSend, matchedCmds, cmdIndex, matchedVerbs, verbIndex, selectVerb, mentionMatches, mentionIndex, selectMention, scopeMatches, scopeIndex, selectScope, isStreaming, text, onInterrupt],
  )

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    setCursorPos(e.target.selectionStart)
    setCmdIndex(0)
    setMentionDismissed(false)
    setMentionIndex(0)
    setScopeIndex(0)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true) }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false) }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false)
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
  }, [addFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const files: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file) }
    }
    if (files.length > 0) {
      e.preventDefault() // Prevent filename text from being pasted
      addFiles(files)
    }
  }, [addFiles])

  return (
    <div
      className={cn('relative px-3 pb-3 pt-1 transition-colors', isDragging && 'bg-[var(--accent)]')}
      onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
    >
      <CommandPalette commands={matchedCmds} selectedIndex={cmdIndex} onSelect={selectCommand} />
      <CommandPalette
        commands={matchedVerbs.map((v) => ({ name: `${v.cmd.name} ${v.verb.name}`, description: v.verb.desc ?? '', type: 'server' as const }))}
        selectedIndex={verbIndex}
        onSelect={(c) => { setText(c.name + ' '); textareaRef.current?.focus() }}
      />
      <FileMentionPicker matches={mentionMatches} selectedIndex={mentionIndex} onSelect={selectMention} />
      <FileMentionPicker matches={scopeMatches} selectedIndex={scopeIndex} onSelect={selectScope} dirs />

      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[var(--accent)]/80 border-2 border-dashed border-[var(--primary)]">
          <p className="text-sm text-[var(--primary)]">Drop images here</p>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />

      {/* Unified input container */}
      <div className={cn(
        'rounded-2xl border border-[var(--border)] bg-[var(--secondary)] transition-colors',
        'focus-within:border-[var(--primary)] focus-within:ring-1 focus-within:ring-[var(--primary)]',
      )}>
        {/* Textarea */}
        <textarea
          ref={textareaRef} value={text} onChange={handleInput} onKeyDown={handleKeyDown} onPaste={handlePaste}
          onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
          placeholder={noUsableAgent ? 'All agents are disabled — enable one in the Agents tab to chat' : isStreaming ? 'Send to interrupt current response...' : 'Type @ to reference files...'}
          rows={1}
          className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none max-h-[200px]"
        />

        {/* Bottom toolbar + chips in one row */}
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <button onClick={() => fileInputRef.current?.click()} disabled={disabled} title="Attach images"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
            <Paperclip className="h-4 w-4" />
          </button>
          <CaptureControl />
          <FaceControl />
          <TokenRing onCompact={onCompact} />
          {renderLeftControls?.()}

          {/* Inline chips */}
          {pendingMessages?.map((msg, i) => (
            <div key={`q-${i}`} className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
              <span className="max-w-32 truncate">{msg}</span>
              <button onClick={() => onRemovePending?.(i)} className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--accent)] hover:text-[var(--foreground)]">
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          {contextLabel && (
            <button
              onClick={() => setContextEnabled(!contextEnabled)}
              title={contextEnabled ? 'Click to exclude context' : 'Click to include context'}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                contextEnabled
                  ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                  : 'bg-[var(--background)] border-[var(--border)] text-[var(--muted-foreground)] line-through opacity-60',
              )}
            >
              <span className="max-w-36 truncate">{contextLabel}</span>
            </button>
          )}
          {mentionedFiles.map((filePath) => (
            <div key={`@${filePath}`} className="flex items-center gap-1 rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[10px] text-green-400">
              <span className="max-w-32 truncate">@{filePath.split('/').pop()}</span>
              <button onClick={() => removeMention(filePath)} className="ml-0.5 rounded-full p-0.5 hover:bg-green-500/20 hover:text-green-300">
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          {pendingFiles.map((pf, i) => (
            <div key={`f-${i}`} className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-0.5">
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} className="h-5 w-5 rounded object-cover" />
              ) : (
                <FileIcon className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              )}
              <span className="max-w-20 truncate text-[10px] text-[var(--muted-foreground)]">{pf.file.name}</span>
              <button onClick={() => removeFile(i)} className="ml-0.5 rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]">
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}

          <div className="flex-1" />

          {isStreaming && !text.trim() && pendingFiles.length === 0 ? (
            <button onClick={onStop} title="Stop generation"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-600 text-white transition-colors hover:bg-red-700">
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button onClick={handleSend} disabled={noUsableAgent || (!text.trim() && pendingFiles.length === 0)}
              title={noUsableAgent ? 'All agents are disabled — enable one to chat' : isStreaming && text.trim() ? 'Send (interrupts current response)' : 'Send (Enter)'}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                !noUsableAgent && (text.trim() || pendingFiles.length > 0)
                  ? isStreaming ? 'bg-orange-600 text-white hover:bg-orange-700' : 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-blue-600'
                  : 'text-[var(--muted-foreground)] cursor-not-allowed',
              )}>
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

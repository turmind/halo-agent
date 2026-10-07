import { useChatStore, type CaptureSource } from './chat-store'

/**
 * Live-capture bridges for the chat toolbar's Share-screen / Camera buttons.
 * The desktop shell injects its own (`window.haloCapture` / `window.haloCamera`,
 * see packages/desktop preload) and those always win; a plain browser gets the
 * getDisplayMedia / getUserMedia implementations below. Same "bind once, the
 * LLM snaps on demand via <<<CAPTURE>>>" model either way (use-chat injects the
 * prompt, chat-handlers grabs the frame).
 *
 * Unlike the desktop shell — which can grab any window at any time — a browser
 * only sees what the user granted, and only while the stream is open. So both
 * web bridges keep their stream alive while their source is bound (a hidden,
 * playing <video> each, for instant frames) and release it on unbind:
 * `syncWebCapture` makes the open streams follow `screenSource` / `cameraSource`
 * — independently, both may be live at once. The camera is held open rather
 * than opened per snap because browsers may re-prompt or defer getUserMedia
 * while the page has no focus — and the AI's request usually lands while the
 * user is looking elsewhere.
 */

/** A screen/window source the desktop shell lists. */
export interface CaptureSrc { id: string; name: string; thumb: string | null; blank: boolean; icon: string | null }

/** Desktop-shell capture bridge (preload injects it). Undefined in a browser. */
export interface HaloCapture {
  list: () => Promise<CaptureSrc[]>
  grab: (id: string) => Promise<string | null>
  permission: () => Promise<'granted' | 'denied' | 'not-determined' | 'restricted'>
  openSettings: () => void
  /** One-shot still of the display the Halo window is on (Screenshot button):
   *  base64 JPEG, `{ error: 'permission' }` without macOS Screen Recording, null
   *  when unsupported. Absent on shells older than the Screenshot button. */
  screenshot?: () => Promise<string | { error: 'permission' } | null>
}

/** Desktop-shell webcam bridge (preload injects it). Undefined in a browser.
 *  Counterpart to HaloCapture for the camera — `snap` grabs a still JPEG. */
export interface HaloCamera {
  has: () => Promise<boolean>
  snap: (deviceId?: string) => Promise<string | null>
  list: () => Promise<Array<{ deviceId: string; label: string }>>
  requestPermission: () => Promise<boolean>
  openSettings: () => void
}

/** i18n key of a web screen share's chip name, from the granted surface. */
export type WebSurfaceKey = 'capture.webSurfaceScreen' | 'capture.webSurfaceWindow' | 'capture.webSurfaceTab'

/** Browser screen share (getDisplayMedia). The browser's own picker is the
 *  source chooser, so there is no list — `start` opens it. */
export interface WebScreen {
  readonly web: true
  /** Open the browser picker (call straight from the click — it needs the user
   *  gesture). Resolves to the chip name's i18n key once granted, null when the
   *  user cancelled (any current share is kept). */
  start: () => Promise<WebSurfaceKey | null>
  /** Current frame of the live share as base64 JPEG; null when sharing stopped
   *  or the frame stays near-black. The id is ignored (one share at a time). */
  grab: (_id?: string) => Promise<string | null>
}

/** Browser camera — HaloCamera's shape minus openSettings (a page can't open
 *  the browser's site settings). */
export type WebCamera = Omit<HaloCamera, 'openSettings'> & { readonly web: true }

export type ScreenBridge = (HaloCapture & { web?: undefined }) | WebScreen
export type CameraBridge = (HaloCamera & { web?: undefined }) | WebCamera

/** The marker the LLM emits to request a live frame (prompt injected by
 *  use-chat): bare `<<<CAPTURE>>>` = every bound source, `<<<CAPTURE:screen>>>`
 *  / `<<<CAPTURE:camera>>>` = just that one. Global — a reply may carry several.
 *  chat-handlers acts on it, message-list strips it at render; one regex so the
 *  two never disagree. Use with matchAll / replace only (`g` + test() is stateful). */
export const CAPTURE_MARKER = /<<<CAPTURE(?::(screen|camera))?>>>/g

/** `screenSource.id` of a web screen share (desktop ids are `screen:…` / `window:…`). */
export const WEB_SCREEN_ID = 'web:screen'

const FRAME_MAX_WIDTH = 1920
const JPEG_QUALITY = 0.85
/** A cold-started webcam needs a beat for auto-exposure (preload's snap). */
const CAMERA_SETTLE_MS = 500
const SCREEN_RETRY_MS = 300
/** Cap on reopening a dead camera stream — getUserMedia may stall while the
 *  page has no focus. */
const CAMERA_REOPEN_TIMEOUT_MS = 5000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function stopTracks(stream: MediaStream | null): void {
  if (stream) for (const track of stream.getTracks()) track.stop()
}

function isLive(stream: MediaStream | null): boolean {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live')
}

/** A muted, playing <video> kept in the DOM offscreen so frames are always
 *  ready to draw. */
function attachVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.setAttribute('aria-hidden', 'true')
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:160px;height:90px;opacity:0;pointer-events:none'
  video.srcObject = stream
  document.body.appendChild(video)
  video.play().catch(() => { /* retried in videoReady before each grab */ })
  return video
}

function releaseMedia(stream: MediaStream | null, video: HTMLVideoElement | null): void {
  stopTracks(stream)
  if (video) { video.srcObject = null; video.remove() }
}

/** Make sure the video is playing and has dimensions (≤1s wait for metadata). */
async function videoReady(video: HTMLVideoElement): Promise<void> {
  if (video.paused) await video.play().catch(() => { /* drawing the last frame is still better than nothing */ })
  if (video.videoWidth) return
  await new Promise<void>((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true })
    setTimeout(resolve, 1000)
  })
}

/** Draw the video's current frame, capped at `maxWidth` wide (aspect kept;
 *  Infinity = original resolution). Null when there is no frame yet. */
function drawFrame(video: HTMLVideoElement, maxWidth = FRAME_MAX_WIDTH): HTMLCanvasElement | null {
  const vw = video.videoWidth, vh = video.videoHeight
  if (!vw || !vh) return null
  const scale = Math.min(1, maxWidth / vw)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(vw * scale))
  canvas.height = Math.max(1, Math.round(vh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Near-black frame guard (sparse RGBA sample, like the desktop shell's
 *  isMostlyBlack / cameraFrameIsBlack): almost every sample ≤ `max` per channel. */
function frameIsBlack(canvas: HTMLCanvasElement, max: number): boolean {
  const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  if (d.length < 4) return true
  const step = Math.max(1, Math.floor(d.length / 4 / 1000)) * 4
  let sampled = 0
  let dark = 0
  for (let i = 0; i + 2 < d.length; i += step) {
    sampled++
    if (d[i] <= max && d[i + 1] <= max && d[i + 2] <= max) dark++
  }
  return sampled > 0 && dark / sampled > 0.99
}

function toJpeg(canvas: HTMLCanvasElement): string | null {
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1] || null
}

function surfaceKey(surface: string | undefined): WebSurfaceKey {
  if (surface === 'window') return 'capture.webSurfaceWindow'
  if (surface === 'browser') return 'capture.webSurfaceTab'
  return 'capture.webSurfaceScreen'
}

function isWebScreenSource(source: CaptureSource | null): boolean {
  return source?.id === WEB_SCREEN_ID
}

// ── Screen ──

let share: { stream: MediaStream; video: HTMLVideoElement } | null = null

function stopScreen(): void {
  if (!share) return
  releaseMedia(share.stream, share.video)
  share = null
}

const webScreen: WebScreen = {
  web: true,
  start: async () => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    } catch {
      // Cancelled (NotAllowedError / AbortError) or refused — whatever is
      // bound stays bound; a cancelled first pick just binds nothing.
      return null
    }
    const track = stream.getVideoTracks()[0]
    if (!track) { stopTracks(stream); return null }
    // Replace the old share only now that the new one is granted.
    stopScreen()
    const next = { stream, video: attachVideo(stream) }
    share = next
    // The browser's own "Stop sharing" bar ends the track → unbind the screen
    // (the camera is untouched), unless this share was already
    // replaced/released or the screen binding moved on.
    track.addEventListener('ended', () => {
      if (share !== next) return
      stopScreen()
      const store = useChatStore.getState()
      if (isWebScreenSource(store.screenSource)) store.setScreenSource(null)
    })
    return surfaceKey(track.getSettings().displaySurface)
  },
  grab: async () => {
    // A just-restored window can hand back black frames for a moment —
    // probe a few times, like the desktop grab.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(SCREEN_RETRY_MS)
      const cur = share
      if (!cur || !isLive(cur.stream)) return null
      await videoReady(cur.video)
      const canvas = drawFrame(cur.video)
      if (canvas && !frameIsBlack(canvas, 8)) return toJpeg(canvas)
    }
    return null
  },
}

// ── Screenshot (one-shot) ──

/** `CaptureController` (Chrome 109+) — not in TS's lib.dom yet. */
interface FocusController { setFocusBehavior: (behavior: 'focus-captured-surface' | 'no-focus-change') => void }

/** A screenshot frame for the crop layer: an image URL (blob: or data:), the
 *  desktop shell's "no Screen Recording permission", or null (cancelled /
 *  nothing captured). */
export type ScreenshotFrame = string | { error: 'permission' } | null

/** Browser one-shot for the Screenshot button: its own picker (call straight
 *  from the click), the first non-black frame at the source's full resolution
 *  (the crop needs the original pixels — no FRAME_MAX_WIDTH), then the stream
 *  stops. Separate from the bound share — never reuses or touches it. Resolves
 *  to a PNG blob URL (the caller revokes it), null when the picker was
 *  cancelled. */
async function grabWebScreenshot(): Promise<string | null> {
  const Controller = (window as unknown as { CaptureController?: new () => FocusController }).CaptureController
  const controller = Controller ? new Controller() : undefined
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, ...(controller ? { controller } : {}) } as DisplayMediaStreamOptions)
  } catch {
    return null // cancelled / refused
  }
  // Keep focus on Halo when another tab / window was picked, so the crop layer
  // stays in view. Must run synchronously right after the promise resolves (no
  // await in between); throws for a whole screen, which has no focus to move.
  try { controller?.setFocusBehavior('no-focus-change') } catch { /* monitor surface */ }
  const video = attachVideo(stream)
  let canvas: HTMLCanvasElement | null = null
  try {
    // The first frames of a fresh capture can come back black — probe a few
    // times; a frame that stays black is still what's on screen, so keep it.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(SCREEN_RETRY_MS)
      await videoReady(video)
      canvas = drawFrame(video, Infinity) ?? canvas
      if (canvas && !frameIsBlack(canvas, 8)) break
    }
  } finally {
    releaseMedia(stream, video)
  }
  if (!canvas) return null
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return blob ? URL.createObjectURL(blob) : null
}

/** The Screenshot button's frame source: the desktop shell's `screenshot` (the
 *  display Halo is on, no picker) when the shell has it, else the browser's
 *  picker one-shot, else undefined (no button — e.g. mobile). */
export function getScreenshotBridge(): (() => Promise<ScreenshotFrame>) | undefined {
  if (typeof window === 'undefined') return undefined
  const shot = (window as unknown as { haloCapture?: HaloCapture }).haloCapture?.screenshot
  if (typeof shot === 'function') {
    return async () => {
      const r = await shot()
      return typeof r === 'string' ? `data:image/jpeg;base64,${r}` : r
    }
  }
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? grabWebScreenshot : undefined
}

// ── Camera ──

interface CameraHold {
  /** Bound device ('' = browser default). */
  deviceId: string
  stream: MediaStream | null
  video: HTMLVideoElement | null
  opening: Promise<boolean> | null
  openedAt: number
}

let cam: CameraHold | null = null

function cameraConstraints(deviceId: string): MediaTrackConstraints {
  // `exact` so a multi-camera machine never silently falls back to the default.
  return deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 } }
}

/** (Re)open the hold's stream; one attempt in flight at a time. A stream that
 *  arrives after the hold was released is stopped straight away. */
function openCamera(hold: CameraHold): Promise<boolean> {
  if (hold.opening) return hold.opening
  releaseMedia(hold.stream, hold.video)
  hold.stream = null
  hold.video = null
  const opening = navigator.mediaDevices.getUserMedia({ video: cameraConstraints(hold.deviceId), audio: false })
    .then((stream) => {
      if (cam !== hold) { stopTracks(stream); return false }
      hold.stream = stream
      hold.video = attachVideo(stream)
      hold.openedAt = Date.now()
      return true
    }, () => false)
    .finally(() => { hold.opening = null })
  hold.opening = opening
  return opening
}

function stopCamera(): void {
  if (!cam) return
  releaseMedia(cam.stream, cam.video)
  cam = null
}

function within(p: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([p, sleep(ms).then(() => false)])
}

const webCamera: WebCamera = {
  web: true,
  // videoinput devices enumerate before the grant (blank labels) when present.
  has: async () => {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'videoinput')
    } catch {
      return false
    }
  },
  list: async () => {
    try {
      return (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))
    } catch {
      return []
    }
  },
  // One getUserMedia prompts on first use (and unlocks device labels), then
  // the camera is released right away — the bound stream opens at bind time.
  requestPermission: async () => {
    try {
      stopTracks(await navigator.mediaDevices.getUserMedia({ video: true }))
      return true
    } catch {
      return false
    }
  },
  snap: async (deviceId) => {
    const hold = cam
    // Only the bound camera is held open (syncWebCapture owns the stream).
    if (!hold || hold.deviceId !== (deviceId ?? '')) return null
    // Not live → wait for the bind-time open still in flight, or (stream died:
    // unplugged / permission revoked / open failed) reopen once.
    if (!isLive(hold.stream) && !(await within(openCamera(hold), CAMERA_REOPEN_TIMEOUT_MS))) return null
    const video = hold.video
    if (cam !== hold || !video) return null
    try {
      await videoReady(video)
      // Settle only a freshly-opened stream; a warm one is ready now.
      const settle = hold.openedAt + CAMERA_SETTLE_MS - Date.now()
      if (settle > 0) await sleep(settle)
      let canvas = drawFrame(video)
      if (!canvas || frameIsBlack(canvas, 10)) {
        await sleep(CAMERA_SETTLE_MS)
        canvas = drawFrame(video)
      }
      return canvas ? toJpeg(canvas) : null
    } catch {
      return null
    }
  },
}

// ── Resolution + lifecycle ──

/** The screen bridge in effect: the desktop shell's when injected, else the
 *  browser's when it has getDisplayMedia (mobile browsers don't). */
export function getScreenBridge(): ScreenBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const desktop = (window as unknown as { haloCapture?: HaloCapture }).haloCapture
  if (desktop) return desktop
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? webScreen : undefined
}

/** The camera bridge in effect: the desktop shell's when injected, else the
 *  browser's when it has getUserMedia (absent outside a secure context). */
export function getCameraBridge(): CameraBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const desktop = (window as unknown as { haloCamera?: HaloCamera }).haloCamera
  if (desktop) return desktop
  return typeof navigator.mediaDevices?.getUserMedia === 'function' ? webCamera : undefined
}

/**
 * Make the browser streams follow the bound sources. Idempotent — call it on
 * every `screenSource` / `cameraSource` change (from any number of mounted
 * controls): stops a web screen share `screen` no longer points at, releases
 * the camera when `camera` is unbound or another device is bound, and opens the
 * bound camera's stream (web camera bridge only — the desktop shell snaps on
 * its own). Each stream follows only its own source.
 */
export function syncWebCapture(screen: CaptureSource | null, camera: CaptureSource | null): void {
  if (!isWebScreenSource(screen)) stopScreen()
  const deviceId = camera && getCameraBridge()?.web ? camera.id : null
  if (cam && cam.deviceId === deviceId) return
  stopCamera()
  if (deviceId === null) return
  cam = { deviceId, stream: null, video: null, opening: null, openedAt: 0 }
  void openCamera(cam)
}

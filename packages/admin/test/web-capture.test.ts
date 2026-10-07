import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getScreenBridge, getCameraBridge, syncWebCapture, WEB_SCREEN_ID, type WebScreen } from '../src/features/chat/web-capture'
import { useChatStore } from '../src/features/chat/chat-store'

/**
 * Contract: in a plain browser (no desktop-shell `window.haloCapture` /
 * `window.haloCamera`) the chat toolbar's capture buttons run on
 * getDisplayMedia / getUserMedia. The streams follow the bound
 * `captureSource` — open while bound, released on unbind / switch — and the
 * browser's own "Stop sharing" ends the binding. Streams and tracks are plain
 * fakes; jsdom has no media pipeline, so <video>.play / videoWidth and the 2d
 * canvas are stubbed on the prototypes.
 */

interface FakeTrack {
  readyState: 'live' | 'ended'
  stop: ReturnType<typeof vi.fn>
  getSettings: () => { displaySurface?: string }
  addEventListener: (type: string, fn: () => void) => void
  /** What the browser does when the user clicks its "Stop sharing" bar. */
  end: () => void
}

function fakeTrack(displaySurface?: string): FakeTrack {
  const listeners: Array<() => void> = []
  const track: FakeTrack = {
    readyState: 'live',
    // A real track.stop() does not fire `ended`.
    stop: vi.fn(() => { track.readyState = 'ended' }),
    getSettings: () => ({ displaySurface }),
    addEventListener: (type, fn) => { if (type === 'ended') listeners.push(fn) },
    end: () => { track.readyState = 'ended'; listeners.forEach((fn) => fn()) },
  }
  return track
}

function fakeStream(track: FakeTrack): MediaStream {
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
}

const getDisplayMedia = vi.fn()
const getUserMedia = vi.fn()
const enumerateDevices = vi.fn(async () => [{ kind: 'videoinput', deviceId: 'cam1', label: 'Front' }])

function setMediaDevices(devices: Record<string, unknown> | undefined): void {
  Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true })
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const source = () => useChatStore.getState().captureSource
const bindWebScreen = () => useChatStore.getState().setCaptureSource({ id: WEB_SCREEN_ID, name: 'Entire screen', thumb: '', kind: 'screen' })
const bindCamera = (id: string) => useChatStore.getState().setCaptureSource({ id, name: 'Front', thumb: '', kind: 'camera' })
/** What CaptureControl's effect does on every captureSource change. */
const sync = () => syncWebCapture(source())

let pixel: number[]

beforeEach(() => {
  getDisplayMedia.mockReset()
  getUserMedia.mockReset()
  setMediaDevices({ getDisplayMedia, getUserMedia, enumerateDevices })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720)
  pixel = [200, 200, 200, 255]
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(pixel) }),
  }) as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,IMG')
})

afterEach(() => {
  useChatStore.getState().setCaptureSource(null)
  syncWebCapture(null)
  delete (window as unknown as { haloCapture?: unknown }).haloCapture
  delete (window as unknown as { haloCamera?: unknown }).haloCamera
  setMediaDevices(undefined)
  vi.restoreAllMocks()
})

describe('bridge resolution', () => {
  it('the desktop shell bridges win over the browser ones', () => {
    const haloCapture = { grab: vi.fn() }
    const haloCamera = { snap: vi.fn() }
    Object.assign(window, { haloCapture, haloCamera })
    expect(getScreenBridge()).toBe(haloCapture)
    expect(getCameraBridge()).toBe(haloCamera)
    expect(getScreenBridge()?.web).toBeUndefined()
  })

  it('a browser without the desktop bridges gets the web ones', () => {
    expect(getScreenBridge()?.web).toBe(true)
    expect(getCameraBridge()?.web).toBe(true)
  })

  it('no getDisplayMedia (mobile) → no screen bridge, camera still available', () => {
    setMediaDevices({ getUserMedia, enumerateDevices })
    expect(getScreenBridge()).toBeUndefined()
    expect(getCameraBridge()?.web).toBe(true)
  })
})

describe('web screen share', () => {
  const screen = () => getScreenBridge() as WebScreen

  it('names the chip from the granted surface and grabs the live frame as JPEG', async () => {
    getDisplayMedia.mockResolvedValueOnce(fakeStream(fakeTrack('window')))
    expect(await screen().start()).toBe('capture.webSurfaceWindow')
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false })
    expect(await screen().grab()).toBe('IMG')
  })

  it('the browser\'s "Stop sharing" ends the share and unbinds it', async () => {
    const track = fakeTrack('monitor')
    getDisplayMedia.mockResolvedValueOnce(fakeStream(track))
    expect(await screen().start()).toBe('capture.webSurfaceScreen')
    bindWebScreen()
    sync()

    track.end()
    expect(source()).toBeNull()
    expect(await screen().grab()).toBeNull()
  })

  it('a stale "ended" does not unbind a camera bound since', async () => {
    const track = fakeTrack('monitor')
    getDisplayMedia.mockResolvedValueOnce(fakeStream(track))
    await screen().start()
    bindWebScreen()
    sync()
    getUserMedia.mockResolvedValue(fakeStream(fakeTrack()))
    bindCamera('cam1')
    sync()

    track.end()
    expect(source()?.kind).toBe('camera')
  })

  it('a cancelled re-pick keeps the current share', async () => {
    const track = fakeTrack('browser')
    getDisplayMedia.mockResolvedValueOnce(fakeStream(track))
    await screen().start()
    bindWebScreen()
    sync()

    getDisplayMedia.mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'))
    expect(await screen().start()).toBeNull()
    expect(track.stop).not.toHaveBeenCalled()
    expect(source()?.id).toBe(WEB_SCREEN_ID)
    expect(await screen().grab()).toBe('IMG')
  })

  it('a granted re-pick replaces the old share, whose late "ended" is ignored', async () => {
    const first = fakeTrack('monitor')
    getDisplayMedia.mockResolvedValueOnce(fakeStream(first))
    await screen().start()
    bindWebScreen()
    const second = fakeTrack('window')
    getDisplayMedia.mockResolvedValueOnce(fakeStream(second))
    expect(await screen().start()).toBe('capture.webSurfaceWindow')

    expect(first.stop).toHaveBeenCalled()
    first.end()
    expect(source()?.id).toBe(WEB_SCREEN_ID)
    expect(second.stop).not.toHaveBeenCalled()
  })

  it('a near-black frame is retried, then given up on', async () => {
    getDisplayMedia.mockResolvedValueOnce(fakeStream(fakeTrack('window')))
    await screen().start()
    pixel = [0, 0, 0, 255]
    expect(await screen().grab()).toBeNull()
  })
})

describe('syncWebCapture follows captureSource', () => {
  it('stops the screen share on unbind', async () => {
    const track = fakeTrack('monitor')
    getDisplayMedia.mockResolvedValueOnce(fakeStream(track))
    await (getScreenBridge() as WebScreen).start()
    bindWebScreen()
    sync()
    sync() // idempotent: a second mounted control changes nothing
    expect(track.stop).not.toHaveBeenCalled()

    useChatStore.getState().setCaptureSource(null)
    sync()
    expect(track.stop).toHaveBeenCalled()
  })

  it('switching to the camera stops the share and opens the bound camera once', async () => {
    const screenTrack = fakeTrack('monitor')
    getDisplayMedia.mockResolvedValueOnce(fakeStream(screenTrack))
    await (getScreenBridge() as WebScreen).start()
    bindWebScreen()
    sync()

    const camTrack = fakeTrack()
    getUserMedia.mockResolvedValue(fakeStream(camTrack))
    bindCamera('cam1')
    sync()
    sync()
    expect(screenTrack.stop).toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ video: { deviceId: { exact: 'cam1' } }, audio: false })
  })

  it('releases the camera on unbind and when another device is bound', async () => {
    const first = fakeTrack()
    const second = fakeTrack()
    getUserMedia.mockResolvedValueOnce(fakeStream(first)).mockResolvedValueOnce(fakeStream(second))
    bindCamera('cam1')
    sync()
    await flush()

    bindCamera('cam2')
    sync()
    await flush()
    expect(first.stop).toHaveBeenCalled()
    expect(second.stop).not.toHaveBeenCalled()

    useChatStore.getState().setCaptureSource(null)
    sync()
    expect(second.stop).toHaveBeenCalled()
  })

  it('a camera stream granted after unbind is stopped straight away', async () => {
    let grant!: (s: MediaStream) => void
    getUserMedia.mockReturnValueOnce(new Promise((r) => { grant = r }))
    bindCamera('cam1')
    sync()
    useChatStore.getState().setCaptureSource(null)
    sync()

    const late = fakeTrack()
    grant(fakeStream(late))
    await flush()
    expect(late.stop).toHaveBeenCalled()
  })

  it('does not hold a desktop-shell camera open (the shell snaps on its own)', () => {
    Object.assign(window, { haloCamera: { snap: vi.fn() } })
    bindCamera('cam1')
    sync()
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})

describe('web camera', () => {
  it('requestPermission opens one stream, releases it, and reports the grant', async () => {
    const track = fakeTrack()
    getUserMedia.mockResolvedValueOnce(fakeStream(track))
    expect(await getCameraBridge()!.requestPermission()).toBe(true)
    expect(track.stop).toHaveBeenCalled()

    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    expect(await getCameraBridge()!.requestPermission()).toBe(false)
  })

  it('snaps from the held stream, reopening it once when it died', async () => {
    const dead = fakeTrack()
    const fresh = fakeTrack()
    getUserMedia.mockResolvedValueOnce(fakeStream(dead)).mockResolvedValueOnce(fakeStream(fresh))
    bindCamera('cam1')
    sync()
    await flush()
    dead.readyState = 'ended' // unplugged / revoked while bound

    expect(await getCameraBridge()!.snap('cam1')).toBe('IMG')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    // A device that isn't the bound one is never opened ad hoc.
    expect(await getCameraBridge()!.snap('other')).toBeNull()
  })
})

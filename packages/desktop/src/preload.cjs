// Electron BrowserWindow silently swallows window.alert/confirm/prompt by
// default. Admin UI uses alert() to surface validation errors (e.g.
// "Workspace not found") — without this shim those errors are invisible
// and the user thinks the action did nothing. Replace them with versions
// that route through the renderer console + a synchronous-feeling fallback.
//
// We can't call native dialog from the renderer without IPC — that would
// require contextBridge plumbing. For now: keep alert/confirm visible by
// turning them into a window-level toast-ish overlay. This is enough to
// remove the "no feedback" failure mode; native dialogs can come later.

// Simplified from packages/admin/src/app/icon.svg so the overlay needs no
// network/file access. Keep in sync if the brand icon changes — this is a
// glow-free variant of the brand mark (pulse rings + core) because the real
// icon's feGaussianBlur would smear at 36px and its gradient/filter ids could
// collide with page SVGs. Unique id suffix `_bvo` avoids any clash.
const HALO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 1024 1024"><defs><radialGradient id="core_bvo" cx="42%" cy="38%" r="68%"><stop offset="0" stop-color="#d8e6ff"/><stop offset="0.35" stop-color="#8aa6ff"/><stop offset="1" stop-color="#9b6bff"/></radialGradient><linearGradient id="ring_bvo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6f9bff"/><stop offset="1" stop-color="#a06bff"/></linearGradient><linearGradient id="bg_bvo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0e1430"/><stop offset="1" stop-color="#070a16"/></linearGradient><clipPath id="sq_bvo"><rect x="104" y="104" width="816" height="816" rx="182"/></clipPath></defs><g clip-path="url(#sq_bvo)"><rect x="104" y="104" width="816" height="816" fill="url(#bg_bvo)"/><circle cx="512" cy="512" r="118" fill="none" stroke="url(#ring_bvo)" stroke-width="15" opacity="0.34"/><circle cx="512" cy="512" r="176" fill="none" stroke="url(#ring_bvo)" stroke-width="12" opacity="0.20"/><circle cx="512" cy="512" r="62" fill="url(#core_bvo)"/></g></svg>`

function showOverlay(message, kind /* 'alert' | 'confirm' */, onConfirm) {
  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    font: 14px -apple-system, BlinkMacSystemFont, sans-serif;
  `
  // Dark card to match admin UI theme (--background: #0a0a0a in globals.css).
  const card = document.createElement('div')
  card.style.cssText = `
    min-width: 320px; max-width: 480px; background: #18181b; color: #ededed;
    border: 1px solid #2a2a2a;
    border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.5); padding: 16px 20px;
  `
  const header = document.createElement('div')
  header.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 10px;'
  const iconWrap = document.createElement('div')
  iconWrap.style.cssText = 'flex: none; width: 36px; height: 36px;'
  iconWrap.innerHTML = HALO_ICON_SVG.replace('width="32" height="32"', 'width="36" height="36"')
  header.appendChild(iconWrap)
  const title = document.createElement('div')
  title.textContent = 'Halo'
  title.style.cssText = 'font-weight: 600;'
  header.appendChild(title)

  const text = document.createElement('div')
  text.style.cssText = 'white-space: pre-wrap; margin-bottom: 12px;'
  text.textContent = String(message ?? '')
  const actions = document.createElement('div')
  actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;'

  const okBtn = document.createElement('button')
  okBtn.textContent = 'OK'
  okBtn.style.cssText = 'padding: 4px 14px; border-radius: 4px; border: 1px solid transparent; background: #0a84ff; color: #fff; cursor: pointer;'
  okBtn.onclick = () => { document.body.removeChild(overlay); onConfirm(true) }

  if (kind === 'confirm') {
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.cssText = 'padding: 4px 14px; border-radius: 4px; border: 1px solid #2a2a2a; background: #27272a; color: #ededed; cursor: pointer;'
    cancelBtn.onclick = () => { document.body.removeChild(overlay); onConfirm(false) }
    actions.appendChild(cancelBtn)
  }
  actions.appendChild(okBtn)
  card.appendChild(header)
  card.appendChild(text)
  card.appendChild(actions)
  overlay.appendChild(card)
  document.body.appendChild(overlay)
  okBtn.focus()
}

// Async prompt overlay. Electron disables the native (synchronous)
// window.prompt outright, so callers that need text input (new file /
// folder / agent / skill) use this Promise-returning variant instead. The
// admin-side `promptInput()` helper prefers this when present and falls back
// to the native prompt in a plain browser. Resolves to the entered string,
// or null on cancel / empty.
window.haloPrompt = function (message, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      font: 14px -apple-system, BlinkMacSystemFont, sans-serif;
    `
    const card = document.createElement('div')
    card.style.cssText = `
      min-width: 360px; max-width: 520px; background: #18181b; color: #ededed;
      border: 1px solid #2a2a2a;
      border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.5); padding: 16px 20px;
    `
    const header = document.createElement('div')
    header.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 10px;'
    const iconWrap = document.createElement('div')
    iconWrap.style.cssText = 'flex: none; width: 36px; height: 36px;'
    iconWrap.innerHTML = HALO_ICON_SVG.replace('width="32" height="32"', 'width="36" height="36"')
    header.appendChild(iconWrap)
    const title = document.createElement('div')
    title.textContent = 'Halo'
    title.style.cssText = 'font-weight: 600;'
    header.appendChild(title)

    const text = document.createElement('div')
    text.style.cssText = 'white-space: pre-wrap; margin-bottom: 10px;'
    text.textContent = String(message ?? '')

    const input = document.createElement('input')
    input.type = 'text'
    input.value = defaultValue == null ? '' : String(defaultValue)
    input.style.cssText = `
      width: 100%; box-sizing: border-box; margin-bottom: 12px; padding: 6px 10px;
      background: #0a0a0a; color: #ededed; border: 1px solid #2a2a2a; border-radius: 4px;
      font: inherit; outline: none;
    `

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;'

    const finish = (value) => { if (overlay.parentNode) document.body.removeChild(overlay); resolve(value) }

    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.cssText = 'padding: 4px 14px; border-radius: 4px; border: 1px solid #2a2a2a; background: #27272a; color: #ededed; cursor: pointer;'
    cancelBtn.onclick = () => finish(null)

    const okBtn = document.createElement('button')
    okBtn.textContent = 'OK'
    okBtn.style.cssText = 'padding: 4px 14px; border-radius: 4px; border: 1px solid transparent; background: #0a84ff; color: #fff; cursor: pointer;'
    okBtn.onclick = () => finish(input.value)

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(null) }
    })

    actions.appendChild(cancelBtn)
    actions.appendChild(okBtn)
    card.appendChild(header)
    card.appendChild(text)
    card.appendChild(input)
    card.appendChild(actions)
    overlay.appendChild(card)
    document.body.appendChild(overlay)
    input.focus()
  })
}

window.alert = function (message) {
  showOverlay(message, 'alert', () => {})
}

// Async confirm overlay — the Promise-returning counterpart to haloPrompt.
// Native window.confirm is synchronous, which Electron can't honor from the
// renderer (see below), so confirm-to-delete flows must await this instead.
// Resolves true on OK, false on Cancel. The admin-side `confirmAction()`
// helper prefers this when present and falls back to native confirm in a
// plain browser.
window.haloConfirm = function (message) {
  return new Promise((resolve) => { showOverlay(message, 'confirm', resolve) })
}

// confirm is sync in spec; Electron's renderer can't block on a native
// dialog, so this shim shows the overlay but always returns false
// immediately. Callers that need the real answer must use haloConfirm /
// confirmAction (async). This sync shim only guarantees the message is
// visible, never that the action proceeds.
window.confirm = function (message) {
  showOverlay(message, 'confirm', () => {})
  return false
}

// Always-on-top bridge. setAlwaysOnTop is a main-process API; expose a tiny
// async surface the admin pin button calls. Only defined in the desktop shell
// — in a plain browser `window.haloPin` is undefined, so the button hides
// itself. Both methods resolve to the resulting pinned state (boolean).
const { ipcRenderer } = require('electron')
window.haloPin = {
  get: () => ipcRenderer.invoke('halo:pin-get'),
  toggle: () => ipcRenderer.invoke('halo:pin-toggle'),
}

// Screen/window capture bridge for the "let the AI see an app" feature. Only
// defined in the desktop shell — in a plain browser `window.haloCapture` is
// undefined, so the chat UI hides the capture button and skips prompt
// injection. `list`/`grab` return [] / null when unsupported (non-mac/win).
window.haloCapture = {
  list: () => ipcRenderer.invoke('halo:capture-list'),
  grab: (id) => ipcRenderer.invoke('halo:capture-grab', id),
  permission: () => ipcRenderer.invoke('halo:capture-permission'),
  openSettings: () => ipcRenderer.invoke('halo:capture-open-settings'),
}

// Webcam capture bridge — the camera counterpart to haloCapture. Same
// "bind once, the LLM snaps on demand" model as screen sharing, but the frame
// is grabbed entirely in the renderer via getUserMedia (no main-process
// desktopCapturer), since the camera is a media device, not a window. `has`
// and `snap` are pure renderer (the preload shares the page's DOM under
// contextIsolation:false); only the macOS TCC permission + Settings deep-link
// round-trip to main. Browser builds have no window.haloCamera, so the chat
// UI hides the camera button.

// A cold-started webcam needs a beat for auto-exposure — the first frames come
// back dark/near-black. Sample sparsely (RGBA; every ~Nth pixel is plenty) and
// treat "almost every sample near-black" as a not-ready-yet frame, mirroring
// the screen-capture isMostlyBlack guard in main.cjs.
function cameraFrameIsBlack(imageData) {
  const d = imageData.data // RGBA, 4 bytes/pixel
  if (d.length < 4) return true
  const step = Math.max(1, Math.floor(d.length / 4 / 1000)) * 4
  let sampled = 0
  let dark = 0
  for (let i = 0; i + 2 < d.length; i += step) {
    sampled++
    if (d[i] <= 10 && d[i + 1] <= 10 && d[i + 2] <= 10) dark++
  }
  return sampled > 0 && dark / sampled > 0.99
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

window.haloCamera = {
  // Is there a webcam at all? Gates the camera button so it never shows on a
  // machine with no camera. videoinput devices enumerate even before the
  // permission grant (with blank labels) when a device is physically present.
  has: async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.some((d) => d.kind === 'videoinput')
    } catch {
      return false
    }
  },
  // Trigger / read the macOS camera (TCC) permission. askForMediaAccess prompts
  // on first use and returns true once authorized; if the user previously
  // denied, macOS won't re-prompt and it returns false (→ UI points them at
  // Settings). Non-mac has no equivalent gate → always true.
  requestPermission: () => ipcRenderer.invoke('halo:camera-request'),
  openSettings: () => ipcRenderer.invoke('halo:camera-open-settings'),
  // Grab a single still frame as base64 JPEG. Spins up a short-lived
  // getUserMedia stream, draws one settled frame to a canvas, then stops the
  // track (releases the device + turns the camera light back off). Returns null
  // on any failure (permission denied, device busy, still black after waiting).
  snap: async () => {
    let stream = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
    } catch {
      return null // denied / no device / device in use by another app
    }
    try {
      const video = document.createElement('video')
      video.muted = true
      video.srcObject = stream
      await video.play().catch(() => {})
      if (!video.videoWidth) {
        await new Promise((resolve) => {
          video.addEventListener('loadedmetadata', resolve, { once: true })
          setTimeout(resolve, 1000) // don't hang if metadata never fires
        })
      }
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      const drawFrame = () => {
        canvas.width = video.videoWidth || 1280
        canvas.height = video.videoHeight || 720
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        return ctx.getImageData(0, 0, canvas.width, canvas.height)
      }
      // Let auto-exposure settle, then grab; if the frame is still black give it
      // one more beat (covers slower webcams without an unbounded wait).
      await sleep(500)
      let frame = drawFrame()
      if (cameraFrameIsBlack(frame)) {
        await sleep(500)
        frame = drawFrame()
      }
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      return dataUrl.split(',')[1] || null
    } catch {
      return null
    } finally {
      for (const track of stream.getTracks()) track.stop()
    }
  },
}

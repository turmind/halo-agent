// Entry: setup modal → world boot → input + poll wiring. Read-only client.
import { conn, probe, startPolling } from './api.js'
import { World } from './world.js'
import { showInspector, hideInspector, bindInspector } from './inspector.js'
import { bindTicker, renderTicker } from './ticker.js'
import { kfmt } from './util.js'
import { t, getLang, nextLang, setLang, applyStaticI18n, onLangChange } from './i18n.js'

const $ = (id) => document.getElementById(id)
const canvas = $('stage')
let world = null
let stopPoll = null

// ── setup modal ──
function showSetup(prefill = true) {
  $('setup').classList.remove('hidden')
  if (prefill) {
    $('in-api').value = conn.api || location.origin
    $('in-token').value = conn.token || ''
  }
  $('setup-err').textContent = ''
  setTimeout(() => ($('in-token').value ? $('btn-connect') : $('in-token')).focus(), 50)
}
const hideSetup = () => $('setup').classList.add('hidden')

async function tryConnect() {
  const api = $('in-api').value.trim() || location.origin
  const token = $('in-token').value.trim()
  const remember = $('in-remember').checked
  const btn = $('btn-connect'), err = $('setup-err')
  err.textContent = ''
  if (!token) { err.textContent = t('needToken'); return }
  btn.disabled = true; btn.textContent = t('connecting')
  try {
    const state = await probe(api, token)
    conn.api = api; conn.token = token
    if (remember) conn.save(); else conn.clear()
    hideSetup()
    boot(state)
  } catch (e) {
    err.textContent = e.message || t('connFail')
  } finally {
    btn.disabled = false; btn.textContent = t('connect')
  }
}

// ── boot ──
function boot(initialState) {
  $('hud').classList.remove('hidden')
  $('legend').classList.remove('hidden')
  $('ticker').classList.remove('hidden')
  $('zoombar').classList.remove('hidden')

  if (!world) {
    world = new World(canvas)
    window.__world = world
    const hp = new URLSearchParams(location.search).get('hour')
    if (hp != null && !isNaN(parseFloat(hp))) world._hourOverride = parseFloat(hp)
    world.onSelect = (vm) => showInspector(vm)
    bindInspector({ onPick: handlePick })
    bindTicker()
    bindInput()
    bindZoomBar()
    world.start()
    const tloop = () => { renderTicker(); syncZoomBar(); requestAnimationFrame(tloop) }
    requestAnimationFrame(tloop)
    startClock()
  }
  if (initialState) { world.ingest(initialState); hud(initialState) }

  applyStaticI18n()
  syncLangBtn()

  if (stopPoll) stopPoll()
  stopPoll = startPolling({
    onData: (s) => { world.ingest(s); hud(s); setConn('ok') },
    onStatus: (st, msg) => {
      if (st === 'live') setConn('live')
      else if (st === 'ok') setConn('ok')
      else { setConn('err', msg); toast(msg) }
    },
  })
}

// ── HUD ──
let lastState = null
function hud(state) {
  lastState = state
  let running = 0, idle = 0, stopped = 0, out = 0
  const n = (state.workspaces || []).length
  for (const ws of state.workspaces || []) {
    running += ws.counts.running; idle += ws.counts.idle; stopped += ws.counts.stopped
    for (const s of ws.sessions) out += s.outputTokens || 0
  }
  $('stats').innerHTML = `
    <span class="stat"><b>${n}</b><i>${t('statBuildings')}</i></span>
    <span class="stat sep s-run"><b>${running}</b><i>${t('statRunning')}</i></span>
    <span class="stat s-idle"><b>${idle}</b><i>${t('statIdle')}</i></span>
    <span class="stat s-stop"><b>${stopped}</b><i>${t('statStopped')}</i></span>
    <span class="stat sep"><b>${kfmt(out)}</b><i>${t('statOutTok')}</i></span>`
  if (state.uptime != null) {
    const up = state.uptime
    const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), m = Math.floor((up % 3600) / 60)
    $('uptime').textContent = t('uptime', d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`)
  }
}

let clockTimer = null
function startClock() {
  if (clockTimer) return
  const tick = () => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    $('clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  tick()
  clockTimer = setInterval(tick, 1000)
}

let connTimer = null
function setConn(state, msg) {
  const el = $('conn')
  el.className = 'conn ' + (state === 'err' ? 'err' : 'ok')
  el.querySelector('span').textContent = state === 'err' ? (msg || t('connDown')) : state === 'live' ? t('connRefreshing') : t('connOk')
  if (state === 'live') {
    clearTimeout(connTimer)
    connTimer = setTimeout(() => setConn('ok'), 1100)
  }
}

let toastTimer = null
function toast(msg) {
  let t = $('toast')
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t) }
  t.textContent = '⚠ ' + msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000)
}

// ── inspector cross-links ──
function handlePick(req) {
  if (!world) return
  if (req.type === 'agent') {
    if (world.citizens.has(req.id)) world.select({ type: 'agent', id: req.id })
  } else if (req.type === 'skill-by-id') {
    for (const key of world.city.order) {
      const b = world.city.get(key)
      if (b.stations.some((s) => s.skill.id === req.id)) {
        world.select({ type: 'skill', id: req.id, buildingKey: key })
        return
      }
    }
  }
}

// ── input ──
function bindInput() {
  let dragging = false, moved = false, lastX = 0, lastY = 0, downX = 0, downY = 0

  const down = (x, y) => { dragging = true; moved = false; lastX = downX = x; lastY = downY = y; canvas.classList.add('dragging') }
  const move = (x, y) => {
    if (!dragging) return
    world.cam.panBy(x - lastX, y - lastY)
    lastX = x; lastY = y
    if (Math.abs(x - downX) + Math.abs(y - downY) > 4) moved = true
  }
  const up = (x, y) => {
    canvas.classList.remove('dragging')
    if (!dragging) return
    dragging = false
    if (!moved) {
      const sel = world.pick(x, y)
      if (sel) world.select(sel)
      else { world.select(null); hideInspector() }
    }
  }

  canvas.addEventListener('mousedown', (e) => down(e.clientX, e.clientY))
  window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY))
  window.addEventListener('mouseup', (e) => up(e.clientX, e.clientY))
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; down(t.clientX, t.clientY) }, { passive: true })
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) { pinch(e); return }
    const t = e.touches[0]; move(t.clientX, t.clientY)
  }, { passive: true })
  canvas.addEventListener('touchend', (e) => { const t = e.changedTouches[0]; up(t.clientX, t.clientY); pinchD = 0 }, { passive: true })

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    world.cam.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1)
  }, { passive: false })

  // double-click to zoom into that spot (toggles back out if already close in)
  canvas.addEventListener('dblclick', (e) => {
    const w = world.cam.screenToWorld(e.clientX, e.clientY)
    const zoom = world.cam.tzoom >= 3 ? 1 : 3
    world.cam.focus(w.x, w.y, zoom)
  })

  let pinchD = 0
  function pinch(e) {
    const [a, b] = e.touches
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (pinchD) {
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2
      if (d / pinchD > 1.15) { world.cam.zoomAt(cx, cy, 1); pinchD = d }
      else if (d / pinchD < 0.87) { world.cam.zoomAt(cx, cy, -1); pinchD = d }
    } else pinchD = d
  }

  window.addEventListener('resize', () => world.resize())
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') { world.fitAll() }
    if (e.key === 'h' || e.key === 'H') { document.body.classList.toggle('zen') }
    if (e.key === 'Escape') {
      // layered: close an open selection/inspector first; if nothing's open,
      // Esc toggles zen mode (so it both enters and exits the hidden view)
      if (world.selection) { world.select(null); hideInspector() }
      else document.body.classList.toggle('zen')
    }
  })
}

// ── zoom bar (extra control; wheel/pinch/F keep working independently) ──
function bindZoomBar() {
  const track = $('zb-track')
  const fracFromEvent = (clientX) => {
    const rc = track.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rc.left) / rc.width))
  }
  let dragging = false
  const apply = (clientX) => world.cam.setZoomFrac(fracFromEvent(clientX))

  track.addEventListener('mousedown', (e) => { dragging = true; apply(e.clientX); e.preventDefault() })
  window.addEventListener('mousemove', (e) => { if (dragging) apply(e.clientX) })
  window.addEventListener('mouseup', () => { dragging = false })
  track.addEventListener('touchstart', (e) => { apply(e.touches[0].clientX) }, { passive: true })
  track.addEventListener('touchmove', (e) => { apply(e.touches[0].clientX) }, { passive: true })

  // +/− step one rung, zooming around the screen center
  $('zb-in').addEventListener('click', () => world.cam.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1))
  $('zb-out').addEventListener('click', () => world.cam.zoomAt(window.innerWidth / 2, window.innerHeight / 2, -1))
}

// Reflect the camera's live zoom into the bar each frame, so wheel / pinch /
// F-key zoom changes move the thumb too.
function syncZoomBar() {
  if (!world) return
  const frac = world.cam.zoomFrac()
  $('zb-fill').style.width = (frac * 100) + '%'
  $('zb-thumb').style.left = (frac * 100) + '%'
  $('zb-val').textContent = world.cam.zoomLabel()
}

// ── language switch ──
function syncLangBtn() {
  const b = $('btn-lang')
  if (b) b.textContent = t('langLabel')
}
// Re-fill static text + re-render the live HUD/inspector when language flips.
onLangChange(() => {
  applyStaticI18n()
  syncLangBtn()
  if (lastState) hud(lastState)
})

// ── static wiring ──
$('btn-connect').addEventListener('click', tryConnect)
$('in-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnect() })
$('in-api').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnect() })
$('btn-settings').addEventListener('click', () => { if (stopPoll) { stopPoll(); stopPoll = null } showSetup() })
$('btn-lang').addEventListener('click', () => setLang(nextLang()))
syncLangBtn()
applyStaticI18n()  // localize the setup modal before first connect

// zen mode: logo toggles HUD-less pixel view (H key mirrors it)
const toggleZen = () => document.body.classList.toggle('zen')
$('btn-zen').addEventListener('click', toggleZen)
$('btn-zen').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleZen() } })
$('insp-close').addEventListener('click', () => { world && world.select(null); hideInspector() })

// hash prefill (kiosk): #api=…&token=… — stripped immediately
const hash = new URLSearchParams(location.hash.slice(1))
if (hash.get('token')) {
  conn.api = hash.get('api') || location.origin
  conn.token = hash.get('token')
  history.replaceState(null, '', location.pathname + location.search)
}

conn.load()
// Auto-connect, same-origin first. A real deployment (e.g. halo-city-dev,
// which reverse-proxies /api to its halo server) should talk to its OWN
// origin, not whatever cross-origin address was last typed in — a cross-site
// fetch trips the target origin's Midway SSO, gets 307'd to a login page with
// no CORS header, and surfaces in the browser as a bogus CORS error.
// Same-origin sidesteps it entirely. We only fall back to a stored
// cross-origin api when same-origin can't answer (e.g. a local static server
// deliberately pointed at a remote halo).
;(async () => {
  if (!conn.token) { showSetup(); return }
  const tryList = (conn.api && conn.api !== location.origin)
    ? [location.origin, conn.api]
    : [conn.api || location.origin]
  for (const api of tryList) {
    try {
      const s = await probe(api, conn.token)
      conn.api = api
      hideSetup(); boot(s); return
    } catch { /* try next candidate */ }
  }
  showSetup()
})()

// Entry point. Owns the setup flow, input handling (pan/zoom/click), the poll
// loop → World ingestion, and the HUD/inspector wiring. Read-only and fully
// local: the only network call is GET /api/show/state every few seconds.

import { conn, probe, startPolling } from './api.js'
import { World } from './world.js'
import { showInspector, hideInspector, bindInspector } from './inspector.js'
import { fmtTokens } from './util.js'

const $ = (id) => document.getElementById(id)
const canvas = $('stage')
let world = null
let stopPoll = null

// ── Setup modal ────────────────────────────────────────────────────────
function showSetup(prefill = true) {
  $('setup').classList.remove('hidden')
  if (prefill) {
    $('in-api').value = conn.api || location.origin
    $('in-token').value = conn.token || ''
  }
  $('setup-err').textContent = ''
  setTimeout(() => ($('in-token').value ? $('btn-connect') : $('in-token')).focus(), 50)
}
function hideSetup() { $('setup').classList.add('hidden') }

async function tryConnect() {
  const api = $('in-api').value.trim() || location.origin
  const token = $('in-token').value.trim()
  const remember = $('in-remember').checked
  const btn = $('btn-connect')
  const err = $('setup-err')
  err.textContent = ''
  if (!token) { err.textContent = '请填写 Web Token'; return }
  btn.disabled = true; btn.textContent = '连接中…'
  try {
    const state = await probe(api, token)
    conn.api = api; conn.token = token
    if (remember) conn.save(); else conn.clear()
    hideSetup()
    boot(state)
  } catch (e) {
    err.textContent = e.message || '连接失败'
  } finally {
    btn.disabled = false; btn.textContent = '进入工坊 →'
  }
}

// ── Boot the world ──────────────────────────────────────────────────────
function boot(initialState) {
  $('hud').classList.remove('hidden')
  $('legend').classList.remove('hidden')

  if (!world) {
    world = new World(canvas)
    window.__world = world // dev introspection hook; harmless in prod
    world.onSelect = (vm) => showInspector(vm)
    bindInspector({ onPick: handlePick })
    bindInput()
    world.start()
  }
  if (initialState) {
    world.ingest(initialState)
    updateHud(initialState)
  }

  if (stopPoll) stopPoll()
  stopPoll = startPolling({
    onData: (state) => { world.ingest(state); updateHud(state); setConn('ok') },
    onStatus: (s, msg) => {
      if (s === 'live') setConn('live')
      else if (s === 'ok') setConn('ok')
      else if (s === 'err') { setConn('err', msg); toast(msg) }
    },
  })
}

// ── HUD ──────────────────────────────────────────────────────────────────
function updateHud(state) {
  let running = 0, idle = 0, stopped = 0, ctx = 0, out = 0, sess = 0
  for (const ws of state.workspaces || []) {
    running += ws.counts.running; idle += ws.counts.idle; stopped += ws.counts.stopped
    sess += ws.totalSessions
    for (const s of ws.sessions) { ctx += s.contextTokens || 0; out += s.outputTokens || 0 }
  }
  $('stats').innerHTML = `
    <span>🏠 <b>${(state.workspaces || []).length}</b> 房间</span>
    <span class="s-run">▶ <b>${running}</b> 干活</span>
    <span class="s-idle">● <b>${idle}</b> 摸鱼</span>
    <span>○ <b>${stopped}</b> 休息</span>
    <span>🔤 <b>${fmtTokens(out)}</b> 输出</span>
  `
}

let connTimer = null
function setConn(state, msg) {
  const el = $('conn')
  el.className = 'conn ' + (state === 'err' ? 'err' : state === 'live' ? 'live ok' : 'ok')
  const label = state === 'err' ? (msg || '连接断开') : state === 'live' ? '刷新中…' : '已连接'
  el.querySelector('span').textContent = label
  // After a live flash, settle to "已连接".
  if (state === 'live') {
    clearTimeout(connTimer)
    connTimer = setTimeout(() => { if ($('conn').classList.contains('live')) setConn('ok') }, 1200)
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

// ── Selection from inside the inspector (clicking a roster row / chip) ────
function handlePick(req) {
  if (!world) return
  if (req.type === 'agent') {
    if (world.chars.has(req.id)) world.select({ type: 'agent', id: req.id })
  } else if (req.type === 'skill-by-id') {
    // Find which room holds this skill station.
    for (const room of world.rooms.values()) {
      const st = room.stations.find((s) => s.skill.id === req.id)
      if (st) { world.select({ type: 'skill', id: req.id, roomKey: room.key, station: st }); return }
    }
  }
}

// ── Canvas input: pan / zoom / click-to-inspect ──────────────────────────
function bindInput() {
  let dragging = false, moved = false
  let lastX = 0, lastY = 0, downX = 0, downY = 0

  const onDown = (x, y) => { dragging = true; moved = false; lastX = downX = x; lastY = downY = y; canvas.classList.add('dragging') }
  const onMove = (x, y) => {
    if (!dragging) return
    const dx = x - lastX, dy = y - lastY
    lastX = x; lastY = y
    if (Math.abs(x - downX) + Math.abs(y - downY) > 4) moved = true
    world.cam.panBy(dx, dy)
  }
  const onUp = (x, y) => {
    canvas.classList.remove('dragging')
    if (!dragging) return
    dragging = false
    if (!moved) {
      const sel = world.pick(x, y)
      if (sel) world.select(sel)
      else { world.select(null); hideInspector() }
    }
  }

  canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY))
  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY))
  window.addEventListener('mouseup', (e) => onUp(e.clientX, e.clientY))

  // Touch
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; onDown(t.clientX, t.clientY) }, { passive: true })
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) { onPinch(e); return }
    const t = e.touches[0]; onMove(t.clientX, t.clientY)
  }, { passive: true })
  canvas.addEventListener('touchend', (e) => { const t = e.changedTouches[0]; onUp(t.clientX, t.clientY); pinchDist = 0 }, { passive: true })

  // Wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    world.cam.zoomAt(e.clientX, e.clientY, factor)
  }, { passive: false })

  // Pinch zoom
  let pinchDist = 0
  function onPinch(e) {
    const [a, b] = e.touches
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (pinchDist) {
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2
      world.cam.zoomAt(cx, cy, d / pinchDist)
    }
    pinchDist = d
  }

  window.addEventListener('resize', () => world.resize())

  // Keyboard: F to fit, Esc to close inspector.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') world.fitAll()
    if (e.key === 'Escape') { world.select(null); hideInspector() }
  })
}

// ── Wire static buttons ───────────────────────────────────────────────────
$('btn-connect').addEventListener('click', tryConnect)
$('in-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnect() })
$('in-api').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnect() })
$('btn-settings').addEventListener('click', () => { if (stopPoll) { stopPoll(); stopPoll = null } showSetup() })
$('insp-close').addEventListener('click', () => { world && world.select(null); hideInspector() })

// ── Auto-connect if we have saved creds ───────────────────────────────────
// `#api=<url>&token=<tok>` in the URL pre-fills + connects (handy for embeds
// and kiosk displays). Stripped from the bar immediately so the token isn't
// left sitting in history.
const hash = new URLSearchParams(location.hash.slice(1))
if (hash.get('token')) {
  conn.api = hash.get('api') || location.origin
  conn.token = hash.get('token')
  history.replaceState(null, '', location.pathname + location.search)
}

conn.load()
if (conn.token && conn.api) {
  probe(conn.api, conn.token)
    .then((state) => { hideSetup(); boot(state) })
    .catch(() => showSetup())
} else {
  showSetup()
}

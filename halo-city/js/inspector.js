// Inspector: the click-to-open side panel. v3's headline feature is the REAL
// session log — picking an agent fetches /api/show/session and renders the
// recent message stream (user / assistant / tool calls with durations), plus
// a context meter against the session's TRUE maxContextTokens. The panel
// re-fetches while open so it tracks a running session.
import { kfmt, ago, hhmm, toolCN, esc } from './util.js'
import { makeLook } from './people.js'
import { fetchSession } from './api.js'
import { t } from './i18n.js'

const swatch = (name) => makeLook(name).shirt

const STATUS_KEY = { running: 'stRunning', idle: 'stIdle', stopped: 'stStopped' }
const DOING_KEY = {
  walk: 'doWalk', stairs: 'doStairs', work: 'doWork', read: 'doRead',
  coffee: 'doCoffee', game: 'doGame', phone: 'doPhone', chat: 'doChat',
  water: 'doWater', stretch: 'doStretch', sleep: 'doSleep', idle_stand: 'doIdleStand',
  look: 'doLook', lean: 'doLean',
}
const statusText = (s) => (STATUS_KEY[s] ? t(STATUS_KEY[s]) : s)
const doingText = (a) => DOING_KEY[a.doing] ? t(DOING_KEY[a.doing]) : (STATUS_KEY[a.status] ? t(STATUS_KEY[a.status]) : '')

const el = document.getElementById('inspector')
const body = document.getElementById('insp-body')
let onPick = null
let logTimer = null
let logKey = ''            // wsPath|sessionId currently shown
let shownAgent = ''        // agent panel currently rendered (avoid rebuilds)

export function bindInspector(h) { onPick = h.onPick }

export function showInspector(vm) {
  if (!vm) { hideInspector(); return }
  el.classList.remove('hidden')
  if (vm.type === 'agent') {
    // Re-describes arrive on every poll; rebuilding the panel would wipe the
    // log box mid-read. Same agent → patch the live bits, keep the DOM.
    if (shownAgent === vm.id && document.getElementById('insp-log')) {
      patchAgent(vm)
      return
    }
    shownAgent = vm.id
    body.innerHTML = agentHtml(vm)
    wire()
    startLog(vm)
  } else {
    stopLog()
    shownAgent = ''
    body.innerHTML = vm.type === 'skill' ? skillHtml(vm)
      : vm.type === 'floor' ? floorHtml(vm)
      : buildingHtml(vm)
    wire()
  }
}

/** In-place update of the agent panel's volatile fields (status line, output
 *  counter, last-tool) without touching the log box. */
function patchAgent(a) {
  const st = document.getElementById('insp-status')
  if (st) {
    st.innerHTML = `${dot(a.status)} ${statusText(a.status)} · ${esc(doingText(a))}`
  }
  const out = document.getElementById('insp-out')
  if (out) out.textContent = `${kfmt(a.outputTokens)} tokens · ${t('msgCount', a.messageCount || '—')}`
  const lt = document.getElementById('insp-lasttool')
  if (lt && a.lastTool) lt.innerHTML = `${esc(toolCN(a.lastTool))} <span class="dim">(${esc(a.lastTool)})</span>`
}

export function hideInspector() {
  stopLog()
  shownAgent = ''
  el.classList.add('hidden')
  body.innerHTML = ''
}

function stopLog() { clearTimeout(logTimer); logTimer = null; logKey = '' }

// ── live session log ─────────────────────────────────────────────────────
function startLog(vm) {
  const key = `${vm.wsPath}|${vm.id}`
  if (logKey === key) return                  // already streaming this session
  stopLog()
  logKey = key
  const tick = async () => {
    if (logKey !== key) return
    const box = document.getElementById('insp-log')
    if (!box) return
    try {
      const d = await fetchSession(vm.wsPath, vm.id)
      if (logKey !== key) return
      renderLog(d)
    } catch (e) {
      if (logKey !== key) return
      box.innerHTML = `<div class="log-err">${t('logLoadFail', esc(e.message))}</div>`
    }
    logTimer = setTimeout(tick, 6000)
  }
  tick()
}

function renderLog(d) {
  const box = document.getElementById('insp-log')
  if (!box) return
  // true-cap context meter
  const meter = document.getElementById('insp-ctx')
  if (meter && d.maxContextTokens > 0) {
    const pct = Math.min(100, Math.round((d.contextTokens / d.maxContextTokens) * 100))
    const color = pct > 75 ? '#ff6b6b' : pct > 50 ? '#ffd166' : '#54e6a0'
    meter.innerHTML = `
      <div class="v">${kfmt(d.contextTokens)} <span class="cap">/ ${kfmt(d.maxContextTokens)} (${pct}%)</span></div>
      <div class="meter"><i style="width:${pct}%;background:${color}"></i></div>`
  }
  const stale = box.scrollHeight - box.scrollTop - box.clientHeight < 30
  const rows = (d.messages || []).map(logRow).join('')
  box.innerHTML = rows || `<div class="log-empty">${t('logEmpty')}</div>`
  const head = document.getElementById('insp-log-head')
  if (head) head.textContent = t('logHead', d.messages.length, d.totalMessages)
  if (stale) box.scrollTop = box.scrollHeight   // stick to bottom like a tail -f
}

function logRow(m) {
  const time = `<span class="lt">${hhmm(m.timestamp)}</span>`
  if (m.type === 'tool_call' || m.toolName) {
    const dur = m.durationMs != null ? `<span class="ld">${(m.durationMs / 1000).toFixed(1)}s</span>` : ''
    return `<div class="lr lr-tool">${time}<span class="li">⚙</span>
      <span class="lb"><b>${esc(toolCN(m.toolName))}</b><span class="lmono">${esc(trim(m.toolInput, 70))}</span></span>${dur}</div>`
  }
  if (m.role === 'user') {
    return `<div class="lr lr-user">${time}<span class="li">▸</span>
      <span class="lb">${esc(trim(m.content, 160))}</span></div>`
  }
  // assistant text (+ inline tool-call chips)
  const chips = (m.toolCalls || []).map((tc) => `<span class="chip-mini">${esc(toolCN(tc.name))}</span>`).join('')
  const text = trim(m.content, 200)
  if (!text && !chips) return ''
  return `<div class="lr lr-asst">${time}<span class="li">●</span>
    <span class="lb">${esc(text)}${chips ? `<span class="chips">${chips}</span>` : ''}</span></div>`
}

const trim = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// ── panels ───────────────────────────────────────────────────────────────
function dot(st) {
  const c = st === 'running' ? '#54e6a0' : st === 'idle' ? '#ffd166' : '#6b7299'
  return `<span class="dot" style="background:${c}"></span>`
}

function sessionRow(m, tag = '', indent = 0) {
  const pad = indent ? `style="margin-left:${indent * 13}px"` : ''
  const tok = (m.contextTokens || m.outputTokens) ? `<span class="meta mono">${kfmt(m.contextTokens || 0)}</span>` : ''
  const msgs = m.messageCount ? `<span class="meta">${t('msgCountShort', m.messageCount)}</span>` : ''
  return `<div class="insp-row" data-agent="${esc(m.id)}" ${pad}>
    <span class="av" style="background:${swatch(m.name)}"></span>
    <span class="nm">${tag}${esc(m.name)}</span>${msgs}${tok}<span class="meta">${dot(m.status)}</span>
  </div>`
}

function agentHtml(a) {
  const main = swatch(a.agentName)
  const tag = a.depth > 0 ? t('subAgent', a.depth) : 'AGENT'
  const doing = doingText(a)
  const tree = []
  if (a.parent) tree.push(sessionRow(a.parent, '↰ '))
  tree.push(`<div class="insp-row is-self"><span class="av" style="background:${main}"></span>
    <span class="nm"><b>${esc(a.agentName)}</b></span><span class="meta">${dot(a.status)}</span></div>`)
  for (const c of a.children || []) tree.push(sessionRow(c, '↳ ', 1))
  const treeHtml = (a.parent || (a.children || []).length)
    ? `<div class="insp-field"><div class="k">${t('delegationChain', tree.length)}</div><div class="insp-list">${tree.join('')}</div></div>` : ''
  return `
    <span class="insp-tag" style="background:${main}">${tag}</span>
    <div class="insp-h">${esc(a.agentName)}</div>
    <div class="insp-sub mono">${esc(a.id)}</div>
    <div class="insp-status" id="insp-status">${dot(a.status)} ${statusText(a.status)} · ${esc(doing)}</div>
    ${a.description ? `<div class="bubble">${esc(a.description)}</div>` : ''}
    ${a.activeSkill ? `<div class="insp-field"><div class="k">${t('usingSkill')}</div><div class="v"><span class="chip on">${esc(a.activeSkill)}</span></div></div>` : ''}
    ${a.lastTool ? `<div class="insp-field"><div class="k">${t('lastAction')}</div><div class="v mono" id="insp-lasttool">${esc(toolCN(a.lastTool))} <span class="dim">(${esc(a.lastTool)})</span></div></div>` : ''}
    <div class="insp-field"><div class="k">${t('contextTokens')}</div>
      <div id="insp-ctx"><div class="v">${kfmt(a.contextTokens)} <span class="cap">/ …</span></div>
      <div class="meter"><i style="width:0%"></i></div></div></div>
    <div class="insp-field"><div class="k">${t('totalOutput')}</div><div class="v" id="insp-out">${kfmt(a.outputTokens)} tokens · ${t('msgCount', a.messageCount || '—')}</div></div>
    ${treeHtml}
    <div class="insp-field"><div class="k" id="insp-log-head">${t('sessionLog')}</div>
      <div id="insp-log" class="insp-log"><div class="log-empty">${t('loading')}</div></div></div>
    <div class="insp-field"><div class="k">${t('inBuilding')}</div><div class="v">${esc(a.building)}</div></div>
    <div class="insp-field"><div class="k">${t('lastActive')}</div><div class="v">${ago(a.updatedAt)}</div></div>
  `
}

/** Floor panel: the session-relations view. Shows who is anchored to this
 *  floor and each one's delegation tree (indented, clickable). */
function floorHtml(f) {
  const kindCN = { work: t('floorWork'), commons: t('floorCommons'), lobby: t('floorLobby') }[f.kind] || t('floorGeneric')
  const floorNo = f.floor === -1 ? 'L' : `${f.floor + 1}F`
  const renderNode = (n) => sessionRow(n, n.indent ? '↳ ' : '', n.indent)
    + (n.children || []).map(renderNode).join('')
  const treesHtml = f.trees.length
    ? f.trees.map((tr) => `<div class="insp-list" style="margin-bottom:8px">${renderNode(tr)}</div>`).join('')
    : `<div class="v dim">${t('floorEmpty')}</div>`
  return `
    <span class="insp-tag ws">${floorNo} · ${kindCN}</span>
    <div class="insp-h">${esc(f.label)}</div>
    <div class="insp-sub">${t('clickRowHint')}</div>
    <div class="insp-field"><div class="k">${t('floorSessions', f.count)}</div>${treesHtml}</div>
  `
}

function skillHtml(s) {
  const users = s.users && s.users.length
    ? `<div class="insp-field"><div class="k">${t('skillUsing', s.users.length)}</div><div class="insp-list">${s.users.map((u) =>
        `<div class="insp-row" data-agent="${esc(u.id)}"><span class="av" style="background:${swatch(u.name)}"></span><span class="nm">${esc(u.name)}</span><span class="meta">▶</span></div>`).join('')}</div></div>`
    : `<div class="insp-field"><div class="v dim">${t('skillNobody')}</div></div>`
  return `
    <span class="insp-tag skill">SKILL</span>
    <div class="insp-h">${esc(s.name)}</div>
    <div class="insp-sub">${esc(s.id)}${s.command ? ' · /' + esc(s.command) : ''}</div>
    ${s.description ? `<div class="bubble">${esc(s.description)}</div>` : ''}
    <div class="insp-field"><div class="k">${t('inBuilding')}</div><div class="v">${esc(s.building)}</div></div>
    ${users}`
}

function buildingHtml(r) {
  const c = r.counts || { running: 0, idle: 0, stopped: 0 }
  const members = (r.members || []).slice().sort((a, b) => {
    const rank = { running: 0, idle: 1, stopped: 2 }
    return (rank[a.status] - rank[b.status]) || a.depth - b.depth
  })
  const totalCtx = members.reduce((s, m) => s + (m.contextTokens || 0), 0)
  const totalOut = members.reduce((s, m) => s + (m.outputTokens || 0), 0)
  const roster = members.length
    ? members.map((m) => sessionRow(m, m.depth > 0 ? '↳ ' : '')).join('')
    : `<div class="v dim">${t('buildingEmpty')}</div>`
  const chips = (r.skills || []).length
    ? `<div class="insp-field"><div class="k">${t('skills', r.skills.length)}</div><div class="chip-row">${r.skills.map((s) =>
        `<span class="chip" data-skill="${esc(s.id)}">${esc(s.name)}</span>`).join('')}</div></div>` : ''
  return `
    <span class="insp-tag ws">WORKSPACE</span>
    <div class="insp-h">${esc(r.label)}</div>
    <div class="insp-sub mono">${esc(r.path)}</div>
    <div class="insp-field"><div class="k">${t('population')}</div><div class="v">
      <span style="color:#54e6a0">${t('popRunning', c.running)}</span> ·
      <span style="color:#ffd166">${t('popIdle', c.idle)}</span> ·
      <span style="color:#6b7299">${t('popStopped', c.stopped)}</span>
      ${r.total > members.length ? ` · <span class="dim">${t('popTotal', r.total)}</span>` : ''}
    </div></div>
    <div class="insp-field"><div class="k">${t('tokensField')}</div>
      <div class="v">${kfmt(totalCtx)} / ${kfmt(totalOut)}</div></div>
    ${chips}
    <div class="insp-field"><div class="k">${t('sessionsField', members.length)}</div><div class="insp-list">${roster}</div></div>`
}

function wire() {
  body.querySelectorAll('[data-agent]').forEach((row) =>
    row.addEventListener('click', () => onPick && onPick({ type: 'agent', id: row.getAttribute('data-agent') })))
  body.querySelectorAll('[data-skill]').forEach((chip) =>
    chip.addEventListener('click', () => onPick && onPick({ type: 'skill-by-id', id: chip.getAttribute('data-skill') })))
}

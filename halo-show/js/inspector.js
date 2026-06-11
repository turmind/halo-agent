// Renders the slide-in detail panel for whatever the user clicked: an agent
// (its current activity, skill, tokens), a skill station (description + who's
// using it), or a room (occupancy + roster). Pure DOM — no canvas.

import { fmtTokens, relTime, toolLabel } from './util.js'
import { agentLook } from './palette.js'

const swatch = (id) => agentLook(id).shirt

const STATUS_LABEL = { running: '干活中', idle: '摸鱼中', stopped: '休息中' }
const DOING_LABEL = {
  walk: '正在走动', work: '伏案工作', coffee: '在喝咖啡', game: '打游戏摸鱼',
  sleep: '睡着了', idle_stand: '发呆中', wander: '溜达',
}

const el = document.getElementById('inspector')
const body = document.getElementById('insp-body')
let onPick = null // callback(sel) to re-select from inside the panel

export function bindInspector(handlers) { onPick = handlers.onPick }

export function showInspector(vm) {
  if (!vm) { hideInspector(); return }
  el.classList.remove('hidden')
  if (vm.type === 'agent') body.innerHTML = renderAgent(vm)
  else if (vm.type === 'skill') body.innerHTML = renderSkill(vm)
  else if (vm.type === 'room') body.innerHTML = renderRoom(vm)
  wireLinks()
}

export function hideInspector() {
  el.classList.add('hidden')
  body.innerHTML = ''
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function dot(status) {
  const c = status === 'running' ? '#54e6a0' : status === 'idle' ? '#ffd166' : '#6b7299'
  return `<span class="dot" style="background:${c}"></span>`
}

function renderAgent(a) {
  const pal = { main: swatch(a.id) }
  const tagText = a.depth > 0 ? `子代理 · L${a.depth}` : 'AGENT'
  const doing = DOING_LABEL[a.doing] || STATUS_LABEL[a.status] || ''
  const skillLine = a.activeSkill
    ? `<div class="insp-field"><div class="k">正在使用技能</div><div class="v"><span class="chip on">${esc(a.activeSkill)}</span></div></div>`
    : ''
  const toolLine = a.lastTool
    ? `<div class="insp-field"><div class="k">最近动作</div><div class="v mono">${esc(toolLabel(a.lastTool))} <span style="color:#5b628c">(${esc(a.lastTool)})</span></div></div>`
    : ''
  return `
    <span class="insp-tag" style="background:${pal.main}">${tagText}</span>
    <div class="insp-h">${esc(a.agentName)}</div>
    <div class="insp-sub">${esc(a.id)}</div>
    <div class="insp-status ${a.status}">${dot(a.status)} ${STATUS_LABEL[a.status] || a.status} · ${esc(doing)}</div>
    ${a.description ? `<div class="bubble">${esc(a.description)}</div>` : ''}
    ${skillLine}
    ${toolLine}
    <div class="insp-field"><div class="k">上下文 Tokens</div><div class="v">${fmtTokens(a.contextTokens)}</div></div>
    <div class="insp-field"><div class="k">累计输出 Tokens</div><div class="v">${fmtTokens(a.outputTokens)}</div></div>
    <div class="insp-field"><div class="k">所在房间</div><div class="v">${esc(a.room)}</div></div>
    <div class="insp-field"><div class="k">最近活动</div><div class="v">${relTime(a.updatedAt)}</div></div>
  `
}

function renderSkill(s) {
  const usersHtml = s.users && s.users.length
    ? `<div class="insp-field"><div class="k">正在使用 (${s.users.length})</div><div class="insp-list">${s.users.map((u) => `<div class="insp-row" data-agent="${esc(u.id)}"><span class="av" style="background:${swatch(u.id)}"></span><span class="nm">${esc(u.name)}</span><span class="meta">▶</span></div>`).join('')}</div></div>`
    : `<div class="insp-field"><div class="v" style="color:#5b628c">当前没人使用这个技能</div></div>`
  return `
    <span class="insp-tag skill">SKILL</span>
    <div class="insp-h">${esc(s.name)}</div>
    <div class="insp-sub">${esc(s.id)}${s.command ? ' · /' + esc(s.command) : ''}</div>
    ${s.description ? `<div class="bubble">${esc(s.description)}</div>` : '<div class="insp-sub" style="color:#5b628c">（无描述）</div>'}
    <div class="insp-field"><div class="k">所在房间</div><div class="v">${esc(s.room)}</div></div>
    ${usersHtml}
  `
}

function renderRoom(r) {
  const c = r.counts || { running: 0, idle: 0, stopped: 0 }
  const members = (r.members || []).slice().sort((a, b) => {
    const rank = { running: 0, idle: 1, stopped: 2 }
    return (rank[a.status] - rank[b.status]) || a.depth - b.depth
  })
  const roster = members.length
    ? members.map((m) => `<div class="insp-row" data-agent="${esc(m.id)}"><span class="av" style="background:${swatch(m.id)}"></span><span class="nm">${m.depth > 0 ? '↳ ' : ''}${esc(m.name)}</span><span class="meta">${dot(m.status)}</span></div>`).join('')
    : '<div class="v" style="color:#5b628c">空荡荡的房间</div>'
  const skillChips = (r.skills || []).length
    ? `<div class="insp-field"><div class="k">设施 / 技能 (${r.skills.length})</div><div class="chip-row">${r.skills.map((s) => `<span class="chip" data-skill="${esc(s.id)}" data-room="${esc(r.label)}">${esc(s.name)}</span>`).join('')}</div></div>`
    : ''
  return `
    <span class="insp-tag ws">WORKSPACE</span>
    <div class="insp-h">${esc(r.label)}</div>
    <div class="insp-sub">${esc(r.path)}</div>
    <div class="insp-field"><div class="k">人口</div><div class="v">
      <span style="color:#54e6a0">${c.running} 干活</span> ·
      <span style="color:#ffd166">${c.idle} 摸鱼</span> ·
      <span style="color:#6b7299">${c.stopped} 休息</span>
      ${r.total > members.length ? ` · <span style="color:#5b628c">共 ${r.total}</span>` : ''}
    </div></div>
    ${skillChips}
    <div class="insp-field"><div class="k">成员 (${members.length})</div><div class="insp-list">${roster}</div></div>
  `
}

function wireLinks() {
  body.querySelectorAll('[data-agent]').forEach((row) => {
    row.addEventListener('click', () => onPick && onPick({ type: 'agent', id: row.getAttribute('data-agent') }))
  })
  body.querySelectorAll('[data-skill]').forEach((chip) => {
    chip.addEventListener('click', () => onPick && onPick({ type: 'skill-by-id', id: chip.getAttribute('data-skill') }))
  })
}

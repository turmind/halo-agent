// Live activity feed (bottom-left): real events from snapshot diffs.
import { toolCN, esc } from './util.js'
import { makeLook } from './people.js'
import { t } from './i18n.js'

const MAX = 40
const feed = []
let dirty = false
let el = null
let countEl = null

export function bindTicker() {
  el = document.getElementById('ticker-feed')
  countEl = document.getElementById('ticker-count')
  const box = document.getElementById('ticker')
  const head = document.getElementById('ticker-head')
  head.addEventListener('click', () => { box.classList.toggle('collapsed'); dirty = true })
}

export function pushEvent(ev) {
  feed.unshift(ev)
  if (feed.length > MAX) feed.length = MAX
  dirty = true
}

const VERB = {
  tool: (e) => esc(e.tool ? toolCN(e.tool) : t('evTool')),
  skill: (e) => t('evSkill', esc(e.skill)),
  spawn: (e) => e.depth > 0 ? t('evSpawnSub', e.depth) : t('evSpawn'),
  wake: () => t('evWake'),
  rest: () => t('evRest'),
  leave: () => t('evLeave'),
}
const ICON = { tool: '▸', skill: '✦', spawn: '✚', wake: '▶', rest: '◾', leave: '▽' }

export function renderTicker() {
  if (!dirty || !el) return
  dirty = false
  if (countEl) countEl.textContent = feed.length ? t('tickerCount', feed.length) : ''
  el.innerHTML = feed.map((e) => {
    const color = makeLook(e.agentId || e.name).accent
    const bodyHtml = (VERB[e.kind] || (() => esc(e.kind)))(e)
    return `<div class="t-row t-${e.kind}">
      <span class="t-ico" style="color:${color}">${ICON[e.kind] || '·'}</span>
      <span class="t-name" style="color:${color}">${esc(e.name)}</span>
      <span class="t-body">${bodyHtml}</span>
      <span class="t-ws">${esc(e.ws)}</span>
    </div>`
  }).join('')
}

// Halo API client: snapshot polling + per-session detail fetch. Read-only.
import { t } from './i18n.js'
const KEY = 'halo-show-v3.conn'
export const POLL_MS = 7000

export const conn = {
  api: '', token: '',
  load() {
    // Fill from storage only what isn't already set (the URL-hash prefill in
    // main.js runs first and must win over stale stored values).
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || '{}')
      if (!this.api) this.api = o.api || ''
      if (!this.token) this.token = o.token || ''
    } catch { /* ignore */ }
    return this
  },
  save() { try { localStorage.setItem(KEY, JSON.stringify({ api: this.api, token: this.token })) } catch { /* ignore */ } },
  clear() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } },
}

const base = () => conn.api.replace(/\/+$/, '')

/** The halo server's SPA fallback answers unmatched GETs with 200 + HTML, so
 *  a wrong address yields HTML — catch it before json() throws gibberish. */
async function asJson(res) {
  if (res.status === 401) throw new Error(t('errToken'))
  if (res.status === 403) throw new Error(t('errForbidden'))
  if (res.status === 429) throw new Error(t('errRate'))
  if (!res.ok) throw new Error(t('errServer', res.status))
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json')) throw new Error(t('errNotApi'))
  return res.json()
}

export async function fetchState(signal) {
  return asJson(await fetch(`${base()}/api/show/state`, { headers: { 'x-token': conn.token }, signal }))
}

/** Per-session detail: trimmed message log + true token caps. */
export async function fetchSession(wsPath, sessionId, signal) {
  const q = `ws=${encodeURIComponent(wsPath)}&id=${encodeURIComponent(sessionId)}`
  return asJson(await fetch(`${base()}/api/show/session?${q}`, { headers: { 'x-token': conn.token }, signal }))
}

export async function probe(api, token) {
  const res = await fetch(`${api.replace(/\/+$/, '')}/api/show/state`, { headers: { 'x-token': token } })
  return asJson(res)
}

/** Poll driver with error backoff. Returns a stop(). */
export function startPolling({ onData, onStatus }) {
  let stopped = false, timer = null, ctrl = null, fails = 0
  async function tick() {
    if (stopped) return
    ctrl = new AbortController()
    onStatus('live')
    try {
      const s = await fetchState(ctrl.signal)
      fails = 0
      onStatus('ok'); onData(s)
    } catch (e) {
      if (stopped) return
      fails++
      onStatus('err', e.message || t('connFail'))
    } finally {
      if (!stopped) timer = setTimeout(tick, fails ? Math.min(POLL_MS * fails, 30000) : POLL_MS)
    }
  }
  tick()
  return () => { stopped = true; clearTimeout(timer); ctrl?.abort() }
}

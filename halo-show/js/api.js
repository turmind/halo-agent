// Talks to the halo server's token-authed snapshot endpoint and keeps a tiny
// connection state machine. Read-only: one GET every few seconds, nothing else.

const STORAGE_KEY = 'halo-show.conn'
const POLL_MS = 8000

export const conn = {
  api: '',
  token: '',
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const o = JSON.parse(raw)
        this.api = o.api || ''
        this.token = o.token || ''
      }
    } catch { /* ignore */ }
    return this
  },
  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ api: this.api, token: this.token })) } catch { /* ignore */ }
  },
  clear() { try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ } },
}

function base() { return conn.api.replace(/\/+$/, '') }

/** One-shot fetch of the world snapshot. Throws on HTTP/network error so the
 *  caller can show a precise message; returns parsed JSON on success. */
export async function fetchState(signal) {
  const res = await fetch(`${base()}/api/show/state`, {
    headers: { 'x-token': conn.token },
    signal,
  })
  if (res.status === 401) throw new Error('token 无效或已禁用')
  if (res.status === 429) throw new Error('请求过于频繁，请稍后再试')
  if (!res.ok) throw new Error(`服务器返回 ${res.status}`)
  return res.json()
}

/** Validate a connection by hitting the endpoint once. Used by the setup
 *  modal before committing the credentials. */
export async function probe(api, token) {
  const url = `${api.replace(/\/+$/, '')}/api/show/state`
  const res = await fetch(url, { headers: { 'x-token': token } })
  if (res.status === 401) throw new Error('token 无效或已禁用')
  if (!res.ok) throw new Error(`服务器返回 ${res.status}`)
  return res.json()
}

/**
 * Drives polling. Calls `onData(state)` on every successful poll and
 * `onStatus('live'|'ok'|'err', msg?)` on connection transitions. Backs off on
 * error but keeps trying — a transient server restart shouldn't kill the show.
 */
export function startPolling({ onData, onStatus }) {
  let stopped = false
  let controller = null
  let timer = null
  let failStreak = 0

  async function tick() {
    if (stopped) return
    controller = new AbortController()
    onStatus('live')
    try {
      const state = await fetchState(controller.signal)
      failStreak = 0
      onStatus('ok')
      onData(state)
    } catch (err) {
      if (stopped) return
      failStreak++
      onStatus('err', err.message || '连接失败')
    } finally {
      if (!stopped) {
        // Steady cadence on success; exponential-ish backoff while failing
        // (capped) so we recover quickly once the server is back.
        const delay = failStreak === 0 ? POLL_MS : Math.min(POLL_MS * failStreak, 30000)
        timer = setTimeout(tick, delay)
      }
    }
  }

  tick()
  return function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
    if (controller) controller.abort()
  }
}

export { POLL_MS }

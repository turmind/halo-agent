// Small classic helpers shared across the world. No dependencies, no LLM —
// just hashing, a seeded PRNG, easing, and color math.

/** FNV-1a — stable 32-bit hash. Used to map a session/agent id to a color and
 *  to seed per-character PRNGs so the same agent looks the same across polls. */
export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 — tiny deterministic PRNG. Seed from hash32(id) so a character's
 *  "personality" (gait, wander spots, fidget timing) is stable per session. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a, b, t) => a + (b - a) * t
/** Frame-rate-independent exponential smoothing toward target. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt))
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

/** Compact a token count: 12345 → "12.3k". */
export function fmtTokens(n) {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

/** "3分钟前" style relative time from an epoch-ms timestamp. */
export function relTime(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

/** Friendly label for a halo tool name shown in speech bubbles. */
export const TOOL_LABELS = {
  file_read: '读文件', file_write: '写文件', file_edit: '改代码',
  file_list: '翻目录', glob: '找文件', grep: '搜代码',
  shell_exec: '敲命令', web_fetch: '上网查', view_image: '看图片',
  draft: '打草稿', activate_skill: '翻技能书',
  start_session: '叫帮手', query_session: '问同事', session_list: '点名',
  interrupt_session: '喊停', stop_session: '收工', archive_session: '归档',
  get_session_output: '看进度', list_agents: '找人选', query_agent: '查档案',
}
export const toolLabel = (name) => TOOL_LABELS[name] || name || ''

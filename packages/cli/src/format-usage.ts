import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
}

function fmtK(n: number): string {
  return `${(n / 1000).toFixed(1)}K`
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function fmtTimestamp(d: Date): string {
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/**
 * Render a usage event as a single-line summary, mirroring the ws chat panel's
 * UsageLine badges:
 *   HH:MM:SS  in X.XK  out X.XK  ctx X.XK  [read X.XK]  [write X.XK]
 *   [cache XX%]  [ttft N]  [e2e N]  [think LEVEL]  [model]
 *
 * `ctx` is the true context size: inputTokens + cacheRead + cacheWrite + outputTokens.
 * (`inputTokens` alone is the *uncached* input — surfacing it next to a large
 * `cacheRead` looks misleading, so we always show the rolled-up `ctx`.)
 */
export function formatUsageLine(event: AgentSessionEvent): string {
  const inTok = event.inputTokens ?? 0
  const outTok = event.outputTokens ?? 0
  const cacheRead = event.cacheReadInputTokens ?? 0
  const cacheWrite = event.cacheWriteInputTokens ?? 0
  const totalInput = inTok + cacheRead + cacheWrite
  const ctxTok = totalInput + outTok
  const cachePct = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0

  const parts: string[] = []
  parts.push(`${ANSI.dim}${fmtTimestamp(new Date())}${ANSI.reset}`)
  parts.push(`${ANSI.dim}in${ANSI.reset} ${fmtK(inTok)}`)
  parts.push(`${ANSI.dim}out${ANSI.reset} ${fmtK(outTok)}`)
  parts.push(`${ANSI.dim}ctx${ANSI.reset} ${fmtK(ctxTok)}`)
  if (cacheRead > 0) parts.push(`${ANSI.green}read ${fmtK(cacheRead)}${ANSI.reset}`)
  if (cacheWrite > 0) parts.push(`${ANSI.yellow}write ${fmtK(cacheWrite)}${ANSI.reset}`)
  if (cachePct > 0) parts.push(`${ANSI.green}cache ${cachePct}%${ANSI.reset}`)
  if (event.ttftMs != null) parts.push(`${ANSI.dim}ttft${ANSI.reset} ${fmtMs(event.ttftMs)}`)
  if (event.e2eMs != null) parts.push(`${ANSI.dim}e2e${ANSI.reset} ${fmtMs(event.e2eMs)}`)
  if (event.thinkingEffort && event.thinkingEffort !== 'off') {
    parts.push(`${ANSI.magenta}think ${event.thinkingEffort}${ANSI.reset}`)
  } else if (event.thinkingEffort === 'off') {
    parts.push(`${ANSI.dim}think off${ANSI.reset}`)
  }
  if (event.modelId) {
    const shortModel = event.modelId.replace(/^global\.anthropic\./, '')
    parts.push(`${ANSI.blue}${shortModel}${ANSI.reset}`)
  }

  return `${ANSI.dim}[${ANSI.reset} ${parts.join('  ')} ${ANSI.dim}]${ANSI.reset}`
}

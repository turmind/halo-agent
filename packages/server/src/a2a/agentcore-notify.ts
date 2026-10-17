/**
 * The AgentCore notify hook (`HALO_AGENTCORE_NOTIFY`) and the worker → front
 * loopback calls of session-dirs mode (agentcore-front.ts). Node builtins
 * only: the front imports this and must stay free of config / dbs.
 */
import { spawn } from 'node:child_process'

const NOTIFY_TIMEOUT_MS = 300_000
const LOG_TAIL = 1000

/** Worker env (set by the front): its loopback base URL + per-boot token. */
export const FRONT_URL_ENV = 'HALO_AGENTCORE_FRONT_URL'
export const FRONT_TOKEN_ENV = 'HALO_AGENTCORE_FRONT_TOKEN'
export const FRONT_TOKEN_HEADER = 'x-halo-front-token'

let notifying = 0
/** A notify hook (or its hand-off to the front) is in flight — /ping stays
 *  HealthyBusy until it is done. */
export function notifyInFlight(): boolean { return notifying > 0 }

function tail(s: string): string {
  const t = s.trim()
  return t.length > LOG_TAIL ? `…${t.slice(-LOG_TAIL)}` : t
}

/** `sh -c <cmd>`, stdin = text, env = ours + `extra`. Its own process group,
 *  so the timeout kill reaches what the shell started too. Never throws; the
 *  outcome is logged `[AgentCore] notify …`. */
export function runNotify(cmd: string, text: string, extra: Record<string, string>, cwd: string): void {
  notifying++
  const started = Date.now()
  let out = ''
  let err = ''
  let done = false
  const finish = (what: string, warn: boolean): void => {
    if (done) return
    done = true
    notifying--
    clearTimeout(timer)
    const line = `[AgentCore] notify ${extra.HALO_SESSION_ID}: ${what} (${Date.now() - started} ms)${out.trim() ? ` stdout: ${tail(out)}` : ''}${err.trim() ? ` stderr: ${tail(err)}` : ''}`
    if (warn) console.warn(line)
    else console.log(line)
  }
  const child = spawn('sh', ['-c', cmd], { cwd, env: { ...process.env, ...extra }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const timer = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
    finish(`timed out after ${NOTIFY_TIMEOUT_MS / 1000} s, killed`, true)
  }, NOTIFY_TIMEOUT_MS)
  timer.unref()
  child.stdout.on('data', (b: Buffer) => { out = (out + b.toString()).slice(-4 * LOG_TAIL) })
  child.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-4 * LOG_TAIL) })
  child.on('error', (e) => finish(`failed to start: ${e.message}`, true))
  child.on('close', (code, signal) => finish(signal ? `killed by ${signal}` : `exit ${code}`, code !== 0))
  // A hook that never reads stdin closes the pipe early: EPIPE is not an error here.
  child.stdin.on('error', () => {})
  child.stdin.end(text)
}

/** Worker side: POST to the front's loopback endpoint. null = not a worker
 *  (single-process mode). Never throws; failures are logged. */
export async function postToFront(route: '/ready' | '/notify', body: unknown): Promise<boolean | null> {
  const url = process.env[FRONT_URL_ENV]
  if (!url) return null
  notifying++
  try {
    const res = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FRONT_TOKEN_HEADER]: process.env[FRONT_TOKEN_ENV] ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) console.warn(`[AgentCore] front ${route}: HTTP ${res.status}`)
    return res.ok
  } catch (err) {
    console.warn(`[AgentCore] front ${route} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    notifying--
  }
}

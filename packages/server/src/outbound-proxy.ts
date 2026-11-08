/**
 * Outbound proxy (Settings → General → `general.outbound_proxy.*`): one
 * resolution of the three global settings, shared by both egress paths —
 *   - spawned children get http(s)_proxy / HTTP(S)_PROXY / no_proxy /
 *     NO_PROXY from child-env.ts, the credential in the proxy URL's userinfo
 *     (percent-encoded) — the one form curl / git / pip all read;
 *   - in-process web_fetch and A2A get an undici ProxyAgent per request, the
 *     credential as Proxy-Authorization. Never setGlobalDispatcher: model
 *     provider calls share the global fetch and must not be rerouted.
 * Both send Basic auth of `user:password` (a bare token = user, empty password).
 *
 * Read off the mtime-cached global settings (one stat per call, the parse
 * cached on the settings object), so a save applies to the next spawn /
 * request without a restart. Only `url` (userinfo-free) may be logged.
 */
import type { Dispatcher } from 'undici'
import { getSettings } from './settings-file.js'

const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1', '::1']

export interface OutboundProxy {
  /** Proxy origin without userinfo — the only form safe to log. */
  url: string
  /** Proxy URL for a child's env: `url` plus the percent-encoded credential. */
  envUrl: string
  /** `Basic …` Proxy-Authorization value; '' without a token. */
  authorization: string
  /** no_proxy entries: the loopback defaults + the server's inherited NO_PROXY / no_proxy. */
  noProxy: string[]
  /** Forms of the credential a child's output can echo (raw, URL-encoded, base64), for output masking. */
  secrets: string[]
}

/** null = usable proxy URL, else why not. Never echoes the URL (it may carry credentials). */
export function checkProxyUrl(raw: string): string | null {
  let url: URL
  try { url = new URL(raw) } catch { return 'not a valid URL' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme must be http:// or https://'
  if (url.username || url.password) return 'credentials are not allowed in the URL — put them in Token (general.outbound_proxy.token)'
  return null
}

let _cache: { settings: Record<string, unknown>; proxy: OutboundProxy | null } | null = null

/** The proxy in effect, or null when off (disabled, empty url, unusable url). */
export function outboundProxy(): OutboundProxy | null {
  const settings = getSettings()
  if (_cache?.settings !== settings) _cache = { settings, proxy: resolve(settings) }
  return _cache.proxy
}

function resolve(settings: Record<string, unknown>): OutboundProxy | null {
  const general = settings.general as Record<string, unknown> | undefined
  const cfg = general?.outbound_proxy as Record<string, unknown> | undefined
  const enabled = ['true', '1'].includes(String(cfg?.enabled ?? '').trim().toLowerCase())
  const raw = typeof cfg?.url === 'string' ? cfg.url.trim() : ''
  if (!enabled || !raw) return null
  // PATCH / PUT refuse these; this catches a hand-edited settings.yaml.
  const bad = checkProxyUrl(raw)
  if (bad) {
    console.warn(`[OutboundProxy] general.outbound_proxy.url ignored (${bad}) — proxy off`)
    return null
  }
  const url = new URL(raw).origin
  const cred = cfg?.token == null ? '' : String(cfg.token).trim()
  const colon = cred.indexOf(':')
  const user = colon < 0 ? cred : cred.slice(0, colon)
  const pass = colon < 0 ? '' : cred.slice(colon + 1)
  const userinfo = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`
  const basic = Buffer.from(`${user}:${pass}`).toString('base64')
  const inherited = [process.env.NO_PROXY, process.env.no_proxy].flatMap((v) => (v ?? '').split(','))
  const noProxy = [...new Set([...DEFAULT_NO_PROXY, ...inherited.map((s) => s.trim()).filter(Boolean)])]
  console.log(`[OutboundProxy] on: ${url}${cred ? ' (with token)' : ''}`)
  return {
    url,
    envUrl: cred ? url.replace('://', `://${userinfo}@`) : url,
    authorization: cred ? `Basic ${basic}` : '',
    noProxy,
    secrets: cred ? [...new Set([cred, userinfo, basic])] : [],
  }
}

/** True when `hostname` matches a no_proxy entry: exact, or a subdomain of
 *  it (`example.com` / `.example.com` / `*.example.com`); `*` matches all. */
export function bypassesProxy(hostname: string, noProxy: string[]): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  return noProxy.some((raw) => {
    const entry = raw.toLowerCase().replace(/^\[|\]$/g, '').replace(/^\*?\./, '')
    return entry === '*' || host === entry || host.endsWith(`.${entry}`)
  })
}

let _agent: { key: string; agent: Dispatcher } | null = null

/** Dispatcher for one in-process request to `target`: the ProxyAgent while
 *  the proxy is on and `target` isn't in no_proxy, else undefined (direct).
 *  undici is imported on first use, so a proxy-less process never loads it. */
export async function proxyDispatcher(target: string | URL): Promise<Dispatcher | undefined> {
  const proxy = outboundProxy()
  if (!proxy) {
    if (_agent) { void _agent.agent.close().catch(() => {}); _agent = null }
    return undefined
  }
  let host: string
  try { host = new URL(target).hostname } catch { return undefined }
  if (bypassesProxy(host, proxy.noProxy)) return undefined
  const key = `${proxy.url}\0${proxy.authorization}`
  if (_agent?.key === key) return _agent.agent
  const { ProxyAgent } = await import('undici')
  if (_agent?.key !== key) {
    // close() lets requests already on the old agent finish.
    void _agent?.agent.close().catch(() => {})
    _agent = { key, agent: new ProxyAgent({ uri: proxy.url, ...(proxy.authorization ? { token: proxy.authorization } : {}) }) }
  }
  return _agent.agent
}

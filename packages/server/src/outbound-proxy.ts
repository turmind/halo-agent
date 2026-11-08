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
import { BlockList, isIP } from 'node:net'
import type { Dispatcher } from 'undici'
import { expandEnv, getSettings } from './settings-file.js'

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
  /** The credential's forms a child's output can echo, for maskProxyCredential
   *  (null without a token): `raw` as configured (`<<ENV>>` expanded), `plain`
   *  its `user:pass`, `userinfo` that percent-encoded (the env URLs carry
   *  `<userinfo>@`), `basic` the base64 in Proxy-Authorization. */
  credential: { raw: string; plain: string; userinfo: string; basic: string } | null
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
  // `<<ENV>>` expands like any secret; an unset variable stays literal.
  const cred = cfg?.token == null ? '' : expandEnv(String(cfg.token)).trim()
  const colon = cred.indexOf(':')
  const user = colon < 0 ? cred : cred.slice(0, colon)
  const pass = colon < 0 ? '' : cred.slice(colon + 1)
  const userinfo = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`
  const basic = Buffer.from(`${user}:${pass}`).toString('base64')
  const inherited = [process.env.NO_PROXY, process.env.no_proxy].flatMap((v) => (v ?? '').split(','))
  const merged = [...new Set([...DEFAULT_NO_PROXY, ...inherited.map((s) => s.trim()).filter(Boolean)])]
  // curl honours `*` only as the whole list, and ours always holds the
  // defaults — so an inherited `*` collapses it, for children and in-process alike.
  const noProxy = merged.includes('*') ? ['*'] : merged
  console.log(`[OutboundProxy] on: ${url}${cred ? ' (with token)' : ''}`)
  return {
    url,
    envUrl: cred ? url.replace('://', `://${userinfo}@`) : url,
    authorization: cred ? `Basic ${basic}` : '',
    noProxy,
    credential: cred ? { raw: cred, plain: `${user}:${pass}`, userinfo, basic } : null,
  }
}

/** Mask `proxy`'s credential in a child's output (shell_exec's result). Its URL
 *  forms — `<user:pass>@`, percent-encoded or not, which covers every proxy
 *  URL carrying it — and its base64 go whatever their length. The token / its
 *  encoded user-info on their own only from 4 chars, like maskSecrets:
 *  replacing a shorter string everywhere mangles ordinary output (token `ab`
 *  would eat every "ab"), and without the URL around it a 1–3 char string
 *  isn't recognisably the token. */
export function maskProxyCredential(text: string, proxy: OutboundProxy | null): string {
  const c = proxy?.credential
  if (!c) return text
  let out = text
  for (const form of new Set([`${c.userinfo}@`, `${c.plain}@`])) out = out.replaceAll(form, '***@')
  out = out.replaceAll(c.basic, '***')
  for (const form of new Set([c.raw, c.userinfo])) if (form.length >= 4) out = out.replaceAll(form, '***')
  return out
}

/** curl 8.x's no_proxy match (lib/noproxy.c), so in-process requests route
 *  the way a child's curl does:
 *  - a hostname matches an entry equal to it or to a parent domain of it,
 *    case-insensitive, one leading / trailing dot ignored
 *    (`corp.example` = `.corp.example`, matching `a.corp.example` too);
 *  - an IP literal matches an entry that is that address, or a CIDR holding
 *    it (`10.0.0.0/8`, `fd00::/8`);
 *  - `*` as the whole list matches everything;
 *  - nothing else is a pattern: `*.corp.example` is compared literally, and an
 *    entry with a `:port` never matches (ports play no part). */
export function bypassesProxy(hostname: string, noProxy: string[]): boolean {
  if (noProxy.length === 1 && noProxy[0].trim() === '*') return true
  const bare = hostname.replace(/^\[(.*)\]$/, '$1')
  const family = isIP(bare)
  const host = family ? bare : bare.replace(/\.$/, '').toLowerCase()
  return noProxy.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (family) return ipMatches(host, family, entry)
    const name = entry.replace(/\.$/, '').replace(/^\./, '')
    return name !== '' && (host === name || host.endsWith(`.${name}`))
  })
}

function ipMatches(ip: string, family: number, entry: string): boolean {
  const [net, prefix, extra] = entry.split('/')
  if (extra !== undefined || isIP(net) !== family) return false
  const type = family === 6 ? 'ipv6' : 'ipv4'
  const bits = prefix === undefined ? 0 : Number(prefix)
  if (!Number.isInteger(bits) || bits < 0 || bits > (family === 6 ? 128 : 32)) return false
  const list = new BlockList()
  // curl: no prefix (or /0) = that one address.
  if (bits === 0) list.addAddress(net, type)
  else list.addSubnet(net, bits, type)
  return list.check(ip, type)
}

/** The dispatchers for one proxy config, rebuilt when it changes. `router`
 *  is web_fetch's: it picks direct vs proxy per dispatch — every redirect hop
 *  is a dispatch to its own origin, so a hop into no_proxy goes direct and
 *  one out of it goes through the proxy. */
let _agents: { key: string; proxied: Dispatcher; direct: Dispatcher; router: Dispatcher } | null = null

/** undici is imported on first use, so a proxy-less process never loads it. */
async function agentsFor(proxy: OutboundProxy | null): Promise<typeof _agents> {
  const key = proxy ? `${proxy.url}\0${proxy.authorization}\0${proxy.noProxy.join(',')}` : null
  if (_agents?.key === key) return _agents
  const undici = proxy ? await import('undici') : null
  if (_agents?.key === key) return _agents
  // close() lets requests already on the old agents finish.
  if (_agents) for (const d of [_agents.proxied, _agents.direct]) void d.close().catch(() => {})
  _agents = null
  if (!proxy || !undici || key === null) return null
  const proxied = new undici.ProxyAgent({ uri: proxy.url, ...(proxy.authorization ? { token: proxy.authorization } : {}) })
  const direct = new undici.Agent()
  const noProxy = proxy.noProxy
  class Router extends undici.Dispatcher {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      const host = new URL(String(opts.origin)).hostname
      return (bypassesProxy(host, noProxy) ? direct : proxied).dispatch(opts, handler)
    }
  }
  _agents = { key, proxied, direct, router: new Router() }
  return _agents
}

/** A2A's dispatcher for one request to `target`: the ProxyAgent while the
 *  proxy is on and `target` isn't in no_proxy, else undefined (direct — A2A
 *  doesn't follow redirects, so the first URL decides). */
export async function proxyDispatcher(target: string | URL): Promise<Dispatcher | undefined> {
  const proxy = outboundProxy()
  const agents = await agentsFor(proxy)
  if (!agents || !proxy) return undefined
  let host: string
  try { host = new URL(target).hostname } catch { return undefined }
  return bypassesProxy(host, proxy.noProxy) ? undefined : agents.proxied
}

/** web_fetch's dispatcher under the `proxy` snapshot: the per-hop router
 *  while on, undefined (fetch's own default, direct) while off. */
export async function routedDispatcher(proxy: OutboundProxy | null): Promise<Dispatcher | undefined> {
  return (await agentsFor(proxy))?.router
}

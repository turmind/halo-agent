/**
 * A2A URL policy — which hosts a push webhook or an outbound card / RPC URL
 * may point at (docs/plans/a2a.md §8). Applied at push-config create, again at
 * send (inside the DNS lookup, so a rebinding resolver can't swap the address
 * after the check), and on every outbound request.
 *
 *   - http / https only, no userinfo
 *   - link-local (incl. the metadata IP), unspecified and multicast: refused
 *     always
 *   - every resolved IP must be public, or inside a listed CIDR — private /
 *     loopback / CGNAT ranges only when the operator listed them
 *   - plain http only when the host matches a listed host pattern or every
 *     resolved IP is inside a listed CIDR (tailnet / same-VPC traffic)
 *
 * The allowlist is `general.a2a.url_allowlist`, default loopback + tailnet.
 */
import { BlockList, isIP } from 'node:net'
import dns from 'node:dns'
import type { LookupFunction } from 'node:net'
import { config } from '../config.js'

/** Ranges that are never public — refused unless listed. */
const NON_PUBLIC = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['240.0.0.0', 4]] as const) {
  NON_PUBLIC.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['64:ff9b::', 96]] as const) NON_PUBLIC.addSubnet(net, bits, 'ipv6')

/** Refused even when listed: link-local (cloud metadata lives here), multicast, unspecified. */
const NEVER = new BlockList()
NEVER.addSubnet('169.254.0.0', 16, 'ipv4')
NEVER.addSubnet('224.0.0.0', 4, 'ipv4')
NEVER.addAddress('0.0.0.0', 'ipv4')
NEVER.addSubnet('fe80::', 10, 'ipv6')
NEVER.addSubnet('ff00::', 8, 'ipv6')
NEVER.addAddress('::', 'ipv6')

export interface Allowlist { cidrs: BlockList; hosts: string[] }

/** Parse a comma-separated allowlist: CIDRs / bare IPs and host patterns
 *  (`*.ts.net` = any subdomain, `host.example` = exact). Bad entries are
 *  skipped with a warning. */
export function parseAllowlist(raw: string): Allowlist {
  const cidrs = new BlockList()
  const hosts: string[] = []
  for (const entry of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [addr, bitsRaw] = entry.split('/')
    const fam = isIP(addr)
    if (fam) {
      const type = fam === 4 ? 'ipv4' : 'ipv6'
      const bits = bitsRaw === undefined ? (fam === 4 ? 32 : 128) : Number(bitsRaw)
      if (!Number.isInteger(bits) || bits < 0 || bits > (fam === 4 ? 32 : 128)) { console.warn(`[A2A] url_allowlist: bad entry ${entry}`); continue }
      cidrs.addSubnet(addr, bits, type)
    } else if (/^(\*\.)?[a-z0-9.-]+$/.test(entry)) {
      hosts.push(entry)
    } else {
      console.warn(`[A2A] url_allowlist: bad entry ${entry}`)
    }
  }
  return { cidrs, hosts }
}

let cached: { raw: string; list: Allowlist } | null = null
/** The configured allowlist (settings read is mtime-cached in config.ts; the
 *  parse is cached on the raw string). */
export function currentAllowlist(): Allowlist {
  const raw = config.a2a.urlAllowlist
  if (cached?.raw !== raw) cached = { raw, list: parseAllowlist(raw) }
  return cached.list
}

function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return patterns.some((p) => p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p)
}

function ipType(ip: string): 'ipv4' | 'ipv6' { return isIP(ip) === 6 ? 'ipv6' : 'ipv4' }

/** Verdict for ONE resolved address of `url`. null = allowed. */
export function checkAddress(ip: string, url: URL, list: Allowlist): string | null {
  const t = ipType(ip)
  if (NEVER.check(ip, t)) return `address ${ip} is link-local / multicast / unspecified`
  const listed = list.cidrs.check(ip, t)
  if (!listed && NON_PUBLIC.check(ip, t)) return `private address ${ip} is not in general.a2a.url_allowlist`
  if (url.protocol === 'http:' && !listed && !hostMatches(url.hostname, list.hosts)) {
    return `plain http to ${url.hostname} is only allowed for hosts / ranges in general.a2a.url_allowlist`
  }
  return null
}

/** Static checks (scheme, userinfo). null = ok. */
export function checkUrlShape(raw: string): { url: URL } | { error: string } {
  let url: URL
  try { url = new URL(raw) } catch { return { error: 'invalid url' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'only http / https urls are allowed' }
  if (url.username || url.password) return { error: 'urls with credentials are not allowed' }
  return { url }
}

/** Full check including DNS resolution — for create-time validation. */
export async function checkUrl(raw: string, list: Allowlist = currentAllowlist()): Promise<string | null> {
  const shape = checkUrlShape(raw)
  if ('error' in shape) return shape.error
  const host = shape.url.hostname.replace(/^\[|\]$/g, '')
  let addrs: string[]
  if (isIP(host)) addrs = [host]
  else {
    try { addrs = (await dns.promises.lookup(host, { all: true })).map((a) => a.address) }
    catch { return `cannot resolve ${host}` }
  }
  for (const ip of addrs) {
    const err = checkAddress(ip, shape.url, list)
    if (err) return err
  }
  return null
}

/** A `lookup` for node:http(s).request that refuses disallowed addresses at
 *  connect time — the check and the connection use the SAME resolution. */
export function guardedLookup(url: URL, list: Allowlist = currentAllowlist()): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      const list2 = addresses as dns.LookupAddress[]
      for (const a of list2) {
        const verdict = checkAddress(a.address, url, list)
        if (verdict) return callback(Object.assign(new Error(verdict), { code: 'A2A_URL_REFUSED' }), '', 0)
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list2)
      callback(null, list2[0].address, list2[0].family)
    })
  }
}

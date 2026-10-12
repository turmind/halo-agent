import { describe, it, expect } from 'vitest'
import { formatListenBanner } from '../src/listen-banner.js'

describe('formatListenBanner', () => {
  it('wildcard IPv6 (::) → all interfaces, local URL and the exposure line', () => {
    expect(formatListenBanner('::', 9527, '1.6.3')).toEqual([
      '[Server] Halo 1.6.3 listening on port 9527 on all network interfaces — local: http://localhost:9527',
      '[Server] Reachable from the network: allow the port only from trusted sources, or put a TLS reverse proxy in front',
    ])
  })

  it('wildcard IPv4 (0.0.0.0) is treated the same', () => {
    const lines = formatListenBanner('0.0.0.0', 8599, 'dev')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('[Server] Halo dev listening on port 8599 on all network interfaces — local: http://localhost:8599')
  })

  it('specific IPv4 address → one line with its URL', () => {
    expect(formatListenBanner('127.0.0.1', 9527, 'dev')).toEqual(['[Server] Halo dev listening on http://127.0.0.1:9527'])
  })

  it('specific IPv6 address is bracketed', () => {
    expect(formatListenBanner('::1', 9527, 'dev')).toEqual(['[Server] Halo dev listening on http://[::1]:9527'])
    expect(formatListenBanner('fe80::1', 80, 'x')).toEqual(['[Server] Halo x listening on http://[fe80::1]:80'])
  })
})

/** Startup banner for the HTTP listener: the real bound address, not an
 *  assumed localhost. With no hostname passed to `serve`, Node binds every
 *  interface (`::`, or `0.0.0.0` without IPv6), so the banner says so and adds
 *  the exposure advice. */
export function formatListenBanner(address: string, port: number, version: string): string[] {
  if (address === '::' || address === '0.0.0.0') {
    return [
      `[Server] Halo ${version} listening on port ${port} on all network interfaces — local: http://localhost:${port}`,
      '[Server] Reachable from the network: allow the port only from trusted sources, or put a TLS reverse proxy in front',
    ]
  }
  const host = address.includes(':') ? `[${address}]` : address
  return [`[Server] Halo ${version} listening on http://${host}:${port}`]
}

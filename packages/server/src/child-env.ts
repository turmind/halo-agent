/**
 * Env for spawned child processes (evo wrapper + its sub-clis, terminals, tools).
 * Children inherit everything (model API keys etc.) EXCEPT server-only auth
 * secrets — a child never needs to verify logins or mint JWTs, so don't hand
 * it the keys — and the OTEL_* keys in `settingsOtelEnvKeys`. Adds the
 * outbound proxy vars while that setting is on.
 */
import { outboundProxy, type OutboundProxy } from './outbound-proxy.js'

/** OTEL_* keys observability/otel.ts set from settings (unset before it ran).
 *  Stripped from children: inherited from boot they'd win the child's own
 *  `??=`, so a changed / cleared endpoint never reached evo runs until
 *  a server restart. Operator-exported OTEL_* keys aren't here and still pass. */
export const settingsOtelEnvKeys = new Set<string>()

/** `proxyEnv`: a caller's own outboundProxyEnv() snapshot (shell_exec masks
 *  output against the same one); default = read now. */
export function cleanChildEnv(proxyEnv: Record<string, string> = outboundProxyEnv()): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.HALO_PASSWORD
  delete env.HALO_JWT_SECRET
  // Linked machines: a `halo node`'s pairing token (its node_run commands spawn
  // through here too) — kept out of agent subprocess env. Not a boundary for
  // full-level commands: they run unsandboxed as the same user and can read
  // that user's processes and files anyway.
  delete env.HALO_NODE_TOKEN
  for (const key of settingsOtelEnvKeys) delete env[key]
  return Object.assign(env, proxyEnv)
}

/** Proxy vars for a spawned child while Settings → outbound proxy is on, {}
 *  while off — off never touches proxy vars a child inherits (the operator's
 *  own env). The one source for every spawn path: cleanChildEnv() above and
 *  the sandbox's own envs (bwrap --clearenv + --setenv, the Seatbelt allowlist). */
export function outboundProxyEnv(proxy: OutboundProxy | null = outboundProxy()): Record<string, string> {
  if (!proxy) return {}
  const noProxy = proxy.noProxy.join(',')
  return { http_proxy: proxy.envUrl, https_proxy: proxy.envUrl, HTTP_PROXY: proxy.envUrl, HTTPS_PROXY: proxy.envUrl, no_proxy: noProxy, NO_PROXY: noProxy }
}

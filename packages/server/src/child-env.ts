/**
 * Env for spawned child processes (cron cli runs, evo wrapper + its sub-clis).
 * Children inherit everything (model API keys etc.) EXCEPT server-only auth
 * secrets — a child never needs to verify logins or mint JWTs, so don't hand
 * it the keys — and the OTEL_* keys in `settingsOtelEnvKeys`.
 */

/** OTEL_* keys observability/otel.ts set from settings (unset before it ran).
 *  Stripped from children: inherited from boot they'd win the child's own
 *  `??=`, so a changed / cleared endpoint never reached cron / evo runs until
 *  a server restart. Operator-exported OTEL_* keys aren't here and still pass. */
export const settingsOtelEnvKeys = new Set<string>()

export function cleanChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.HALO_PASSWORD
  delete env.HALO_JWT_SECRET
  // Linked machines: the cron child's relay secret (cron/runner.ts adds it back
  // for that one child) and a `halo node`'s pairing token (its node_run commands
  // spawn through here too).
  delete env.HALO_NODE_RELAY_URL
  delete env.HALO_NODE_RELAY_TOKEN
  delete env.HALO_NODE_TOKEN
  for (const key of settingsOtelEnvKeys) delete env[key]
  return env
}

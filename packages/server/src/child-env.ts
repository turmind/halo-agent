/**
 * Env for spawned child processes (evo wrapper + its sub-clis, terminals, tools).
 * Children inherit everything (model API keys etc.) EXCEPT server-only auth
 * secrets — a child never needs to verify logins or mint JWTs, so don't hand
 * it the keys — and the OTEL_* keys in `settingsOtelEnvKeys`.
 */

/** OTEL_* keys observability/otel.ts set from settings (unset before it ran).
 *  Stripped from children: inherited from boot they'd win the child's own
 *  `??=`, so a changed / cleared endpoint never reached evo runs until
 *  a server restart. Operator-exported OTEL_* keys aren't here and still pass. */
export const settingsOtelEnvKeys = new Set<string>()

export function cleanChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.HALO_PASSWORD
  delete env.HALO_JWT_SECRET
  // Linked machines: a `halo node`'s pairing token (its node_run commands spawn
  // through here too) — kept out of agent subprocess env. Not a boundary for
  // full-level commands: they run unsandboxed as the same user and can read
  // that user's processes and files anyway.
  delete env.HALO_NODE_TOKEN
  for (const key of settingsOtelEnvKeys) delete env[key]
  return env
}

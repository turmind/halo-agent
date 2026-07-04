/**
 * Env for spawned child processes (cron cli runs, evo wrapper + its sub-clis).
 * Children inherit everything (model API keys etc.) EXCEPT server-only auth
 * secrets — a child never needs to verify logins or mint JWTs, so don't hand
 * it the keys.
 */
export function cleanChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.HALO_PASSWORD
  delete env.HALO_JWT_SECRET
  return env
}

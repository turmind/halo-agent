/**
 * `halo notify` — a local script wakes a server session. Shared by the server
 * (routes/notify.ts, local-notify.ts, the shell_exec env) and the CLI
 * (packages/cli/src/notify.ts).
 */

/** `{ url, token }` the server writes under `~/.halo/secrets/` (0600) once it listens. */
export const NOTIFY_TOKEN_FILE = 'notify.json'
export const NOTIFY_PATH = '/api/notify'
/** Set in a server session's shell_exec: who `halo notify` wakes by default. */
export const NOTIFY_WORKSPACE_ENV = 'HALO_WORKSPACE'
export const NOTIFY_SESSION_ENV = 'HALO_SESSION_ID'
/** Non-full sessions use a scoped credential instead of reading the boot token file. */
export const NOTIFY_URL_ENV = 'HALO_NOTIFY_URL'
export const NOTIFY_TOKEN_ENV = 'HALO_NOTIFY_TOKEN'
export const NOTIFY_SHELL_ENV = [NOTIFY_WORKSPACE_ENV, NOTIFY_SESSION_ENV, NOTIFY_URL_ENV, NOTIFY_TOKEN_ENV] as const
/** UTF-8 bytes of the notice text; longer is refused, not cut. */
export const NOTIFY_MAX_TEXT_BYTES = 8192
/** What the session sees (UI row and model text): `[Script notice] <text>`. */
export const NOTIFY_LABEL = '[Script notice]'

export interface NotifyRequest {
  workspace: string
  session: string
  text: string
  /** Original env target, HMAC-verified before distinguishing out-of-scope (403) from invalid (401). */
  source?: { workspace: string; session: string }
}

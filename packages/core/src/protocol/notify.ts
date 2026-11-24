/**
 * `halo notify` — a local script wakes a server session. Shared by the server
 * (routes/notify.ts, local-notify.ts, the shell_exec env) and the CLI
 * (packages/cli/src/notify.ts).
 */

/** `{ url, token }` the server writes under `~/.halo/secrets/` (0600) once it listens. */
export const NOTIFY_TOKEN_FILE = 'notify.json'
export const NOTIFY_PATH = '/api/notify'
/** Set in a full-access server session's shell_exec: who `halo notify` wakes by default. */
export const NOTIFY_WORKSPACE_ENV = 'HALO_WORKSPACE'
export const NOTIFY_SESSION_ENV = 'HALO_SESSION_ID'
/** UTF-8 bytes of the notice text; longer is refused, not cut. */
export const NOTIFY_MAX_TEXT_BYTES = 8192
/** What the session sees (UI row and model text): `[Script notice] <text>`. */
export const NOTIFY_LABEL = '[Script notice]'

export interface NotifyRequest {
  workspace: string
  session: string
  text: string
}

/**
 * `halo notify` — a local script wakes a session (routes/notify.ts).
 *
 * Auth is "same machine, same OS user": the server mints a random token at
 * boot and, once it listens, writes `{ url, token }` to
 * `~/.halo/secrets/notify.json` (0600); the CLI reads that file and calls
 * `POST /api/notify` on loopback. A new token every boot — nothing to revoke;
 * a stale file left by a dead server only meets a closed port or a 401.
 * Never the admin password; a non-loopback peer is refused by the route.
 *
 * Server only: CLI / TUI / AgentCore never call initLocalNotify, so their
 * sessions get neither the shell env nor the shell_exec hint — a message
 * posted to the server would race the local process writing that session.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { NOTIFY_TOKEN_FILE } from '@turmind/halo-core/protocol'
import { HALO_SECRETS_DIR } from './config.js'

let token: string | null = null

/** Boot (index.ts), before any session is built: the shell_exec env and
 *  hint key off it (session-agent-builder). */
export function initLocalNotify(): void {
  token ??= crypto.randomBytes(32).toString('base64url')
}

export function localNotifyToken(): string | null {
  return token
}

/** Once the server listens: where the CLI finds it. Written to a temp file
 *  and renamed, so a CLI reading meanwhile never sees half a file. */
export function writeNotifyTokenFile(url: string): void {
  if (!token) return
  fs.mkdirSync(HALO_SECRETS_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(HALO_SECRETS_DIR, NOTIFY_TOKEN_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ url, token }) + '\n', { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Test-only. */
export function _setLocalNotifyToken(t: string | null): void {
  token = t
}

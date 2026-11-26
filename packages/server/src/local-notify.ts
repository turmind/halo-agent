/**
 * `halo notify` — a local script wakes a session (routes/notify.ts).
 *
 * Auth is "same machine, same OS user": the server mints a random token at
 * boot and, once it listens, writes `{ url, token }` to
 * `~/.halo/secrets/notify.json` (0600); the CLI reads that file and calls
 * `POST /api/notify` on loopback. A new token every boot — nothing to revoke;
 * a stale file left by a dead server only meets a closed port or a 401.
 * Workspace/readonly shells receive an HMAC bound to their workspace
 * instead of the boot token. Never the admin password; non-loopback
 * peers are refused for both credentials.
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
let notifyUrl: string | null = null

export function localNotifyUrl(): string | null {
  return notifyUrl
}

/** Both issuance and target resolution use the workspace's real path. No token table. */
export function localNotifyWorkspaceToken(workspacePath: string): string | null {
  if (!token) return null
  return crypto.createHmac('sha256', token).update(fs.realpathSync(workspacePath)).digest('hex')
}

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
  notifyUrl = url
}

/** Test-only. */
export function _setLocalNotifyToken(t: string | null, url: string | null = null): void {
  token = t
  notifyUrl = url
}

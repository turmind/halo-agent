/**
 * Git HTTPS credential management for the Source Control panel.
 *
 * `~/.git-credentials` (0o600) is the single source of truth — it's the file
 * git's `store` credential helper actually reads, so `git push/pull` over
 * HTTPS use it directly. Multiple credentials are supported, one line per host
 * (`https://user:token@host`).
 *
 * Uses the process HOME, matching setup-config.ts — so the dev environment
 * (HOME=/home/ubuntu/halo-dev-home) is isolated automatically.
 *
 * The token is never logged and never returned to the frontend.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const GIT_CREDENTIALS_PATH = path.join(homedir(), '.git-credentials')

export interface GitCredentialInput {
  host: string
  username: string
  token: string
}

export interface GitCredential {
  host: string
  username: string
}

/** Upsert the `https://user:token@host` line for `host` in ~/.git-credentials. */
function writeGitCredentialsFile(host: string, username: string, token: string): void {
  const line = `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${host}`
  let lines: string[] = []
  if (fs.existsSync(GIT_CREDENTIALS_PATH)) {
    lines = fs.readFileSync(GIT_CREDENTIALS_PATH, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  }
  // Replace any existing entry for the same host (one credential per host).
  const kept = lines.filter((l) => {
    try {
      return new URL(l).host !== host
    } catch {
      return true
    }
  })
  kept.push(line)
  fs.writeFileSync(GIT_CREDENTIALS_PATH, kept.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(GIT_CREDENTIALS_PATH, 0o600) } catch { /* best-effort */ }
}

/** Persist a git credential to ~/.git-credentials. Throws on filesystem failure.
 *  GitManager passes `-c credential.helper=store` on every command, so no
 *  global / repo git config is touched to make git read this file. */
export function saveGitCredentials({ host, username, token }: GitCredentialInput): void {
  writeGitCredentialsFile(host, username, token)
  console.log(`[GitCredentials] saved for host ${host}`)
}

/** List configured credentials for the admin — host + username, never the token. */
export function listGitCredentials(): GitCredential[] {
  if (!fs.existsSync(GIT_CREDENTIALS_PATH)) return []
  const lines = fs.readFileSync(GIT_CREDENTIALS_PATH, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  const byHost = new Map<string, GitCredential>()
  for (const line of lines) {
    try {
      const u = new URL(line)
      // u.host keeps the port (github.enterprise.com:8443); u.hostname would drop it.
      if (!byHost.has(u.host)) {
        byHost.set(u.host, { host: u.host, username: decodeURIComponent(u.username) })
      }
    } catch {
      // Skip a malformed / non-URL line rather than letting it break the whole list.
    }
  }
  return [...byHost.values()]
}

/** Remove the credential line(s) for `host` from ~/.git-credentials. Idempotent:
 *  a no-op (file missing, or no matching line) neither errors nor churns the file. */
export function deleteGitCredential(host: string): void {
  if (!fs.existsSync(GIT_CREDENTIALS_PATH)) return
  const lines = fs.readFileSync(GIT_CREDENTIALS_PATH, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  const kept = lines.filter((l) => {
    try {
      return new URL(l).host !== host
    } catch {
      return true // keep malformed lines untouched
    }
  })
  if (kept.length === lines.length) return // nothing matched — idempotent no-op
  fs.writeFileSync(GIT_CREDENTIALS_PATH, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(GIT_CREDENTIALS_PATH, 0o600) } catch { /* best-effort */ }
  console.log(`[GitCredentials] removed for host ${host}`)
}

/**
 * `halo notify [--workspace <path>] [--session <id>] "<text>"` — wake a server
 * session from a script on this machine. Reads `{ url, token }` from
 * `~/.halo/secrets/notify.json` (the running server writes it at boot) and
 * calls `POST /api/notify` (server routes/notify.ts); non-full sessions use
 * env credentials instead. In server shell_exec the target defaults to `$HALO_WORKSPACE` /
 * `$HALO_SESSION_ID`. One attempt: nothing is stored or retried; exit 0 when
 * the server took it, else non-zero with one line why.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import {
  NOTIFY_MAX_TEXT_BYTES, NOTIFY_PATH, NOTIFY_SESSION_ENV, NOTIFY_TOKEN_FILE, NOTIFY_WORKSPACE_ENV, NOTIFY_TOKEN_ENV, NOTIFY_URL_ENV, type NotifyRequest,
} from '@turmind/halo-core/protocol'

export const HELP_NOTIFY = `Usage: halo notify [--workspace <path>] [--session <id>] "<text>"

Wake a session of the Halo server running on this machine: the text lands
in it as \`[Script notice] <text>\` — a new turn when the session is idle,
merged into the running turn when busy. A stopped sub-session is woken and
reports to its parent when done. For scripts an agent starts in the
background ("tell me when the build finishes").

  -w, --workspace <path>  Workspace (default: $${NOTIFY_WORKSPACE_ENV})
  -s, --session <id>      Session id; a sub-session as <root>><sub>
                          (default: $${NOTIFY_SESSION_ENV})
  -h, --help              Show this help

Inside a server session's shell_exec both variables are set, so
\`halo notify "build done"\` needs no flags. Text: up to ${NOTIFY_MAX_TEXT_BYTES} bytes (UTF-8).
Workspace/readonly sessions can only wake themselves, using $${NOTIFY_TOKEN_ENV}
and $${NOTIFY_URL_ENV}. Otherwise reads ~/.halo/secrets/${NOTIFY_TOKEN_FILE}
(the server running as this OS user writes it at boot); local calls only.

Exit codes: 0 = delivered, 1 = not delivered (the reason on stderr).
`

/** Returns the exit code; the reason for a non-zero one is already on stderr. */
export async function cmdNotify(argv: string[]): Promise<number> {
  const fail = (msg: string): number => { process.stderr.write(`halo notify: ${msg}\n`); return 1 }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workspace: { type: 'string', short: 'w' },
      session: { type: 'string', short: 's' },
    },
  })
  const text = positionals.join(' ')
  if (!text.trim()) return fail('no text — usage: halo notify [--workspace <path>] [--session <id>] "<text>"')
  const workspace = values.workspace ?? process.env[NOTIFY_WORKSPACE_ENV]
  const session = values.session ?? process.env[NOTIFY_SESSION_ENV]
  if (!workspace) return fail(`no workspace — pass --workspace or set $${NOTIFY_WORKSPACE_ENV}`)
  if (!session) return fail(`no session — pass --session or set $${NOTIFY_SESSION_ENV}`)
  const bytes = Buffer.byteLength(text)
  if (bytes > NOTIFY_MAX_TEXT_BYTES) return fail(`text is ${bytes} bytes; the limit is ${NOTIFY_MAX_TEXT_BYTES}`)

  const tokenFile = path.join(homedir(), '.halo', 'secrets', NOTIFY_TOKEN_FILE)
  const envToken = process.env[NOTIFY_TOKEN_ENV]
  const envUrl = process.env[NOTIFY_URL_ENV]
  const fromEnv = !!(envToken && envUrl)
  let server: { url: string; token: string }
  if (envToken && envUrl) {
    server = { url: envUrl, token: envToken }
  } else {
    try {
      server = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail(`no Halo server found (${tokenFile} missing) — start it with \`halo server start\``)
      return fail(`cannot read ${tokenFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof server?.url !== 'string' || typeof server.token !== 'string') return fail(`${tokenFile} is malformed — restart the server to rewrite it`)
  }

  const body: NotifyRequest = { workspace: path.resolve(workspace), session, text }
  // A bare HMAC has no identity: carry its original target so the server can
  // authenticate it before returning 403 for explicit -w/-s overrides.
  if (fromEnv && process.env[NOTIFY_WORKSPACE_ENV] && process.env[NOTIFY_SESSION_ENV]) {
    body.source = { workspace: path.resolve(process.env[NOTIFY_WORKSPACE_ENV]!), session: process.env[NOTIFY_SESSION_ENV]! }
  }
  let res: Response
  try {
    res = await fetch(`${server.url}${NOTIFY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code
    if (cause === 'ECONNREFUSED') return fail(`Halo server not running (nothing listening at ${server.url})`)
    return fail(`cannot reach the Halo server at ${server.url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.ok) return 0
  const reason = await (res.json() as Promise<{ error?: unknown } | null>).then((j) => typeof j?.error === 'string' ? j.error : '', () => '')
  if (res.status === 401) return fail(`authentication failed — ${fromEnv ? '$HALO_NOTIFY_TOKEN' : tokenFile} does not match the server at ${server.url} (restarted meanwhile? try again)`)
  return fail(reason || `server answered ${res.status}`)
}

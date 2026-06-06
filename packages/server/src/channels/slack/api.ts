/**
 * Slack Web API client. Thin wrapper over `fetch` — Slack's surface is
 * simple enough that the official `@slack/web-api` package would only
 * add weight (auth boilerplate + types we re-derive locally anyway).
 *
 * Every call goes through `slackPost` which:
 *   - sets `Authorization: Bearer <botToken>`
 *   - parses the JSON body and throws on `ok === false` so failures
 *     don't silently turn into "I sent it but the user didn't see it"
 *     (mirrors the wechat sendMessage hardening).
 *
 * Inbound events arrive over Socket Mode (see openSocketModeConnection
 * + handler.ts:runSocket); we never accept HTTP webhooks so there's
 * no signing-secret verification path to maintain.
 */

const SLACK_API = 'https://slack.com/api'

interface SlackApiError extends Error {
  slackError?: string
}

async function slackPost<T = Record<string, unknown>>(
  endpoint: string,
  token: string,
  body: Record<string, unknown> | FormData,
): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(`${SLACK_API}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(isForm ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    },
    body: isForm ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: { ok?: boolean; error?: string } & T
  try { parsed = JSON.parse(text) }
  catch { throw new Error(`[slack:${endpoint}] non-JSON response: ${text.slice(0, 200)}`) }
  if (parsed.ok === false) {
    const err: SlackApiError = new Error(`[slack:${endpoint}] ${parsed.error ?? 'unknown'}`)
    err.slackError = parsed.error
    throw err
  }
  return parsed
}

export async function authTest(botToken: string): Promise<{
  ok: boolean
  user_id: string
  team_id: string
  team: string
  user: string
  bot_id?: string
}> {
  return slackPost('auth.test', botToken, {})
}

/**
 * Upload a local file to a channel/thread. Slack's "v2" upload flow:
 *
 *   1. POST files.getUploadURLExternal?filename=&length=
 *      → { upload_url, file_id }
 *   2. POST <upload_url>  (raw bytes; no auth header needed — the URL
 *      is signed and single-use)
 *   3. POST files.completeUploadExternal { files:[{id,title}],
 *      channel_id, thread_ts? }  — posts the file into the channel
 *
 * The earlier `files.upload` endpoint is deprecated but the new flow
 * does the same thing in three calls. We swallow the `file_id`/`title`
 * round trip and present a single async function to the caller.
 */
export async function uploadFile(args: {
  botToken: string
  channel: string
  threadTs?: string
  filePath: string
  filename?: string
  title?: string
}): Promise<void> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const filename = args.filename ?? path.basename(args.filePath)
  const stat = fs.statSync(args.filePath)
  if (!stat.isFile()) throw new Error(`[slack:uploadFile] not a regular file: ${args.filePath}`)
  const length = stat.size

  // Step 1: get the signed upload URL.
  const step1 = await fetch(`${SLACK_API}/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${length}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.botToken}` },
  })
  const step1Text = await step1.text()
  let step1Parsed: { ok?: boolean; error?: string; upload_url?: string; file_id?: string }
  try { step1Parsed = JSON.parse(step1Text) }
  catch { throw new Error(`[slack:files.getUploadURLExternal] non-JSON: ${step1Text.slice(0, 200)}`) }
  if (step1Parsed.ok === false || !step1Parsed.upload_url || !step1Parsed.file_id) {
    throw new Error(`[slack:files.getUploadURLExternal] ${step1Parsed.error ?? 'unknown'}`)
  }

  // Step 2: PUT the bytes to the signed URL. No auth header required —
  // the URL itself is single-use and signed by Slack.
  const buf = fs.readFileSync(args.filePath)
  const step2 = await fetch(step1Parsed.upload_url, {
    method: 'POST',
    body: buf,
  })
  if (!step2.ok) {
    throw new Error(`[slack:upload_url] PUT failed ${step2.status} ${step2.statusText}`)
  }

  // Step 3: tell Slack we finished and where to post.
  const completeBody: Record<string, unknown> = {
    files: [{ id: step1Parsed.file_id, title: args.title ?? filename }],
    channel_id: args.channel,
  }
  if (args.threadTs) completeBody.thread_ts = args.threadTs
  await slackPost('files.completeUploadExternal', args.botToken, completeBody)
}

/**
 * Search workspace targets (users + channels) by name. Backs the cron
 * form's target picker so admins can type "@alice" / "#general"
 * instead of looking up `D…` / `C…` ids by hand.
 *
 * Implementation walks two endpoints once each (cap 1000 entries total)
 * and filters in memory. Slack has no server-side search-by-name, but
 * a workspace's user/channel directory is small enough that a single
 * `users.list` + `users.conversations` round-trip is fine for an
 * admin-only feature.
 *
 * Returns up to `limit` matches sorted by relevance (exact prefix on
 * `name` first, then substring). For users we also do a single
 * `conversations.open` lookup so the returned `chatId` is the `D…`
 * channel id ready to paste — the cron dispatcher needs that, not
 * the `U…` user id.
 *
 * Required scopes:
 *   - `users:read`            (search users)
 *   - `channels:read`         (public channels)
 *   - `groups:read`           (private channels — optional)
 *   - `mpim:read` / `im:read` (group DMs / DMs — optional)
 *   - `im:write`              (open DM to resolve user → D channel id)
 */
export interface SlackSearchHit {
  kind: 'user' | 'channel' | 'group' | 'mpim' | 'im'
  id: string          // U… (user) / C… / G… / D…
  name: string        // display name or channel name
  realName?: string   // for users
  email?: string      // for users (if visible)
  /** Ready-to-use chatId for cron pushes — `D…` for users (after
   *  conversations.open), `C…`/`G…` for channels. */
  chatId: string
}

export async function searchSlackTargets(args: {
  botToken: string
  q: string
  limit?: number
}): Promise<SlackSearchHit[]> {
  const limit = args.limit ?? 20
  const q = args.q.trim().toLowerCase()
  if (!q) return []
  const stripPrefix = q.replace(/^[@#]/, '')

  // ── Channels (public + private + DMs the bot is in) ─────────────
  // `users.conversations` returns the conversations the bot can post
  // to — bounded and exactly what we want. types= covers public,
  // private, group DMs, and 1-on-1 DMs.
  const convoTypes = 'public_channel,private_channel,mpim,im'
  const convRes = await fetch(`${SLACK_API}/users.conversations?types=${convoTypes}&limit=1000&exclude_archived=true`, {
    headers: { Authorization: `Bearer ${args.botToken}` },
  })
  const convText = await convRes.text()
  let convs: Array<{ id: string; name?: string; is_im?: boolean; is_channel?: boolean; is_private?: boolean; is_mpim?: boolean; user?: string }> = []
  try {
    const parsed = JSON.parse(convText) as { ok?: boolean; channels?: typeof convs }
    if (parsed.ok && Array.isArray(parsed.channels)) convs = parsed.channels
  } catch { /* ignore — return what we have */ }

  // ── Users (for searching by display name → DM resolution) ───────
  let users: Array<{ id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string; email?: string }; is_bot?: boolean; deleted?: boolean }> = []
  try {
    const userRes = await fetch(`${SLACK_API}/users.list?limit=1000`, {
      headers: { Authorization: `Bearer ${args.botToken}` },
    })
    const parsed = JSON.parse(await userRes.text()) as { ok?: boolean; members?: typeof users }
    if (parsed.ok && Array.isArray(parsed.members)) {
      users = parsed.members.filter((u) => !u.deleted && !u.is_bot)
    }
  } catch { /* users:read might be absent — skip */ }

  // ── Score + collect ─────────────────────────────────────────────
  const hits: SlackSearchHit[] = []

  // Channels: match by name (already prefixed `#` stripped by user input).
  for (const c of convs) {
    if (c.is_im) continue  // DMs are listed via the user search path
    const name = c.name ?? ''
    if (!name) continue
    if (!name.toLowerCase().includes(stripPrefix)) continue
    hits.push({
      kind: c.is_mpim ? 'mpim' : c.is_private ? 'group' : 'channel',
      id: c.id, name, chatId: c.id,
    })
  }

  // Users: match by name / display_name / real_name. For each match
  // resolve the D… channel id via conversations.open (needed for the
  // bot to send a DM). open is idempotent — repeated calls return the
  // same channel id, so this doesn't spam new windows.
  // Cap user matches before opening DMs so we don't hammer the API.
  const userMatches = users.filter((u) => {
    const handle = (u.name ?? '').toLowerCase()
    const display = (u.profile?.display_name ?? '').toLowerCase()
    const real = (u.real_name ?? u.profile?.real_name ?? '').toLowerCase()
    const email = (u.profile?.email ?? '').toLowerCase()
    return handle.includes(stripPrefix)
      || display.includes(stripPrefix)
      || real.includes(stripPrefix)
      || email.includes(stripPrefix)
  }).slice(0, Math.max(0, limit - hits.length))

  for (const u of userMatches) {
    try {
      const openRes = await fetch(`${SLACK_API}/conversations.open`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ users: u.id, return_im: true }),
      })
      const parsed = JSON.parse(await openRes.text()) as { ok?: boolean; channel?: { id?: string } }
      if (!parsed.ok || !parsed.channel?.id) continue
      hits.push({
        kind: 'user',
        id: u.id,
        name: u.profile?.display_name || u.real_name || u.name || u.id,
        realName: u.real_name ?? u.profile?.real_name,
        email: u.profile?.email,
        chatId: parsed.channel.id,
      })
    } catch { /* skip on open failure (insufficient scope, etc.) */ }
  }

  // Sort by exact prefix > substring; stable within each bucket.
  hits.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(stripPrefix) ? 0 : 1
    const bp = b.name.toLowerCase().startsWith(stripPrefix) ? 0 : 1
    return ap - bp
  })
  return hits.slice(0, limit)
}

/**
 * Open a Socket Mode connection. Returns a wss:// URL good for ~30
 * minutes; Slack will start sending us a `disconnect` envelope shortly
 * before the URL expires, at which point we just call this again to
 * get a fresh URL.
 *
 * Authenticated with the app-level token (xapp-…), not the bot token.
 */
export async function openSocketModeConnection(appToken: string): Promise<{ url: string }> {
  const res = await fetch(`${SLACK_API}/apps.connections.open`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })
  const text = await res.text()
  let parsed: { ok?: boolean; error?: string; url?: string }
  try { parsed = JSON.parse(text) }
  catch { throw new Error(`[slack:apps.connections.open] non-JSON: ${text.slice(0, 200)}`) }
  if (!parsed.ok || !parsed.url) {
    throw new Error(`[slack:apps.connections.open] ${parsed.error ?? 'unknown'}`)
  }
  return { url: parsed.url }
}

/** Post a text message. Pass `thread_ts` to reply in a thread (or to
 *  open one on top of a parent message — Slack treats them the same). */
export async function postMessage(args: {
  botToken: string
  channel: string
  text: string
  threadTs?: string
}): Promise<{ ok: boolean; ts: string; channel: string }> {
  const body: Record<string, unknown> = {
    channel: args.channel,
    text: args.text,
  }
  if (args.threadTs) body.thread_ts = args.threadTs
  return slackPost('chat.postMessage', args.botToken, body)
}

/** Download a private file using the bot token. Slack's file URLs require
 *  the same `Authorization: Bearer …` header as the API. */
export async function downloadFile(botToken: string, urlPrivate: string): Promise<Buffer> {
  const res = await fetch(urlPrivate, {
    headers: { Authorization: `Bearer ${botToken}` },
  })
  if (!res.ok) throw new Error(`[slack:downloadFile] ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}


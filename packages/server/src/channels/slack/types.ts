/**
 * Slack channel — payload + account types.
 *
 * Auth model (Socket Mode, no public webhook):
 *   - `botToken` (xoxb-…) — used for outbound calls (chat.postMessage,
 *     conversations.replies, files.upload, …).
 *   - `appToken` (xapp-…) — Socket Mode app-level token. We POST to
 *     `apps.connections.open` with this to get a wss:// URL, then keep
 *     a long-lived websocket open to receive events. No HTTP webhook
 *     means no signing-secret verification — Slack authenticates the
 *     wss connection itself with the app token.
 *
 * `botUserId` is the bot's own user id (e.g. `U0BOT123`); fetched once
 * at install via `auth.test` so we can detect mentions
 * (`<@U0BOT123>`) without an extra round-trip per inbound.
 *
 * `teamId` is the workspace id — preserved for symmetry / analytics
 * even though Socket Mode events route by app instance, not team.
 */
export interface SlackAccount {
  accountId: string
  botToken: string
  appToken: string
  botUserId: string
  teamId: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: 'full' | 'workspace' | 'readonly'
  language: string
  createdAt: number
  updatedAt: number
}

/**
 * Subset of Slack's Socket Mode envelope we actually use. Slack wraps
 * every Events API event in this shape when delivering over wss://:
 *
 *   {
 *     "envelope_id": "abc-...",
 *     "type": "events_api" | "interactive" | "slash_commands" | "hello" | "disconnect",
 *     "payload": { ... the original Events API envelope ... },
 *     "accepts_response_payload": false
 *   }
 *
 * We only handle `events_api`. The other types (interactive, slash
 * commands) are out of scope until we add blocks/cards.
 */
export interface SlackSocketEnvelope {
  envelope_id?: string
  type: 'events_api' | 'interactive' | 'slash_commands' | 'hello' | 'disconnect' | string
  payload?: SlackEventEnvelope
  accepts_response_payload?: boolean
  reason?: string  // for `disconnect` type
}

/** The inner Events API envelope — same shape Slack would have POSTed
 *  to a webhook. Carries `team_id` and the actual event. */
export interface SlackEventEnvelope {
  type: 'event_callback' | 'url_verification' | string
  team_id?: string
  api_app_id?: string
  challenge?: string
  event_id?: string
  event_time?: number
  event?: SlackMessageEvent | SlackAppMentionEvent | { type: string }
  authorizations?: Array<{ user_id?: string; team_id?: string }>
}

/** Common subset of `message` / `app_mention` events. */
export interface SlackMessageEvent {
  type: 'message'
  subtype?: string
  channel: string
  channel_type?: 'channel' | 'group' | 'im' | 'mpim'
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  bot_id?: string
  files?: Array<SlackFile>
}

export interface SlackAppMentionEvent {
  type: 'app_mention'
  channel: string
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  files?: Array<SlackFile>
}

export interface SlackFile {
  id: string
  name?: string
  mimetype?: string
  filetype?: string
  url_private?: string
  url_private_download?: string
  size?: number
}

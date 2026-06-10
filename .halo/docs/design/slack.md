# Slack Channel — Design

Let the user talk to Halo from Slack, sharing the same workspace + sessions as the web and other channels.

## Architecture

```
                       ┌── ws/ (web channel)             ─┐
                       ├── channels/telegram/             │
Halo server (9527) ──┤── channels/wechat/              ├── SessionManager
                       └── channels/slack/ (Socket Mode)  ─┘    (per workspace, via Registry)
                               ↕ wss:// long-connect
                           Slack API
```

All channels are peers — each one is a subscriber + caller against SessionManager. Slack uses Socket Mode (long-lived wss:// connection, no public webhook) instead of HTTP polling or webhooks.

## Data model

### Workspace ↔ Bot mapping

One bot (= one Slack app install) is bound to one workspace. A workspace can bind multiple bots.

### Session strategy

- **DMs: one Slack user → one ongoing session** (keyed by DM channel id, preserved across messages)
- **Channels/groups: each thread → one session** (thread root message or explicit thread_ts anchors the session)
- Session ID format: `slack:<channelId>:<rootTs>:<createdAtBase36>` (e.g. `slack:C0123:1700.0:m1abc`)
- Sessions live under the bot's bound workspace and use the `default` agent
- The web side sees these sessions in the session list (labelled `Slack: <channelId>/<threadTs>`)
- Access level inherited from the bot account

### Access level

Each account carries `accessLevel: 'full' | 'workspace' | 'readonly'` (default `readonly`). Same semantics as WeChat / Telegram — `readonly` runs tools in a read-only bwrap sandbox, `workspace` runs tools in a read-write sandbox confined to the workspace, `full` is unrestricted.

### Storage

Slack bot accounts are stored in the unified channel DB: `~/.halo/secrets/channels/channels.db`, table `channel_accounts` with `channel_type = 'slack'`. See [storage.md](storage.md#channel_accounts) for the full schema.

Slack-specific config JSON fields: `botToken`, `appToken`, `botUserId`, `teamId`, `lastActiveChatId`.

- `botToken` (xoxb-…) — used for outbound API calls (chat.postMessage, files.upload, etc.)
- `appToken` (xapp-…) — app-level token for Socket Mode; traded once for a wss:// URL
- `botUserId` — the bot's own user id; fetched via `auth.test` at install to detect @-mentions
- `teamId` — workspace id (preserved for analytics / symmetry)
- `lastActiveChatId` — runtime cache of the most recent inbound thread (format: `<channelId>:<threadTs>` or just `<channelId>` for DMs), written by `rememberLastActiveChat()` in `channels/shared/accounts.ts` with a per-process hash so unchanged values never touch the db. Used by cron-dispatcher as fallback when no explicit target is set.

### Proactive sending (cron)

The slack cron-dispatcher (`channels/slack/cron-dispatcher.ts`) registers itself with `cron/dispatcher.ts`'s registry at boot. On a fire it requires an explicit `chatId` (format: `D0123` for a DM, `C0123` for a channel, `C0123:1700.0` for a thread):

1. **Explicit `chatId` on the target** — set when the cron was created from inside a Slack chat. Sends only to that chat/thread.
2. **`lastActiveChatId` fallback** — used when no explicit target is set; matches the most recent inbound the bot received.
3. **Error if neither** — Slack has no "fan out to whitelist" model; every push needs an explicit destination or a fallback history.

## Modules

Files: `packages/server/src/channels/slack/`

- `types.ts` — SlackAccount, SlackSocketEnvelope, SlackMessageEvent interfaces
- `accounts.ts` — DAL (thin wrapper over `channels/shared/accounts.ts` for Slack-specific mappings)
- `handler.ts` — Socket Mode connection + event routing, mention filtering, session resolution, per-thread event listener bookkeeping
- `event-adapter.ts` — AgentSessionEvent → Slack messages (buffer + flush; split at 35k chars)
- `api.ts` — HTTP client (auth.test / openSocketModeConnection / chat.postMessage / files.upload / files.download / searchSlackTargets)
- `cron-dispatcher.ts` — CronDispatcher registration; maps Slack targets to `lastActiveChatId` or explicit chatId

Routes: `packages/server/src/routes/slack.ts`

- `POST /api/slack/accounts` — register a bot (validates token via `auth.test`)
- `GET /api/slack/accounts` — list bots
- `PATCH /api/slack/accounts/:id` — update config (enable/disable, label, access level)
- `DELETE /api/slack/accounts/:id` — remove + stop Socket Mode

## Connection model (Socket Mode)

1. User registers a bot via the API (provides botToken + appToken + workspace)
2. Server calls `auth.test` to validate; stores account; starts the Socket Mode runner
3. Socket Mode runner opens a wss:// connection by POSTing to `apps.connections.open` with the appToken
4. Slack returns a wss:// URL (valid for ~30 minutes); server opens a WebSocket to it
5. Slack begins sending event envelopes over the socket
6. On `disconnect` envelope or connection close, server reconnects with exponential backoff (capped at 30s)
7. On graceful shutdown, all sockets are closed

Unlike Telegram (grammy polling) or WeChat (HTTP long-poll), Socket Mode eliminates polling entirely — Slack pushes events to us over a persistent wss:// connection.

## Event flow

### Inbound (socket envelopes)

1. Socket receives a `SlackSocketEnvelope` (wrapper around the actual Events API event)
2. Handler acks the envelope_id within ~3s (Slack requires this)
3. Handler checks envelope type:
   - `hello` — reset reconnect backoff
   - `disconnect` — Slack rotating the URL, close and reconnect
   - `events_api` — dispatch the wrapped event
4. Extract the event payload (must be `event_callback` with `type: 'message'` or `app_mention'`)
5. Replay check: if `event_id` already processed, skip (bounded 2k-entry LRU)
6. Mention filter: decide if we should respond
   - DMs → always respond
   - Channels/groups → require explicit `<@botUserId>` mention every time (thread context preserves state, so mentioning 6 chars per turn is acceptable; prevents bystander spam)
   - Drop if subtype is bot_message / message_changed / message_deleted
7. Strip the `<@botUserId>` mention prefix from the text
8. (DMs only) Check if text is a slash command (starts with `/` or `!`); if so, dispatch via `channels/shared/commands.ts` and return early
9. Download and ingest any attached files (save images + files to workspace media store; images base64'd for vision)
10. Resolve or create the session for this {channel, thread}
11. Register a `SlackResponder` event listener (once per session, torn down on stopAccount)
12. Queue the user message with SessionManager

### Outbound (SlackResponder)

1. SessionManager emits AgentSessionEvent stream chunks
2. SlackResponder buffers chunks until `complete` event
3. On `complete` or when buffer hits 35k chars:
   - Split at paragraph boundary if needed (Slack hard-caps messages at ~40k)
   - Extract `MEDIA: <path>` markers (sent as native file uploads)
   - Convert CommonMark → Slack's mrkdwn format
   - Post as a single message (or series of messages if split)
4. Errors and system notices flush immediately (don't wait for complete)
5. Sub-agent events (taskId set) are dropped (visible in web UI only)

## Account binding & session keying

### DM sessions

DM channels have a stable channel_id (`D…`). A message in a DM stays in the same session regardless of turn count. Session key: `slack:${channelId}:dm`.

### Channel / group / thread sessions

A mention on a top-level message starts a thread and creates a session keyed by that message's `ts`. Replies inside that thread reuse the same `thread_ts`, so they map to the same session and preserve context. Session key: `slack:${channelId}:${rootTs}`.

### Session resolution

The `getOrCreateSessionForThread()` helper:
1. Build session prefix: `slack:${channelId}:${rootTs}:`
2. Check per-user activeOverrides (set by `/session switch` command in DMs)
3. Look for an existing session matching the prefix + userId
4. If none found, create a new session with ID `${prefix}${Date.now().toString(36)}`
5. Store in activeOverrides for future messages from this user

## Cron-dispatcher role

Slack cron-dispatcher plugs into the unified cron/dispatcher.ts registry. At fire time:

1. Retrieve the Slack account (must be enabled)
2. Parse the target's `chatId` (format: `D…`, `C…`, or `C…:thread_ts`)
3. Call `postMessage()` with the chatId (and threadTs if present)
4. Return dispatch result (ok / error)

If no explicit chatId is provided and no lastActiveChatId is cached, dispatch fails with a clear message. This prevents silent failures in a shared-bot scenario where the "last messager" might be unrelated to whoever set up the cron.

## SessionManager integration

Slack channel is a peer with all other channels. The handler:

1. Calls `registry.getOrCreate(workspacePath)` to get the SessionManager for the bound workspace
2. Registers a `SlackResponder` listener on the session via `sm.registerEventListener(sessionId, listener)`
3. Calls `sm.sendUserMessage(sessionId, agentInput, images?, accessLevel)` to queue inbound messages
4. Calls `sm.isSessionCompacting(sessionId)` / `sm.isSessionRunning(sessionId)` to report status

The registry caches SessionManager instances by workspace path, so multiple bots in the same workspace share the same SessionManager and can coexist in the same sessions (each runs their own responder listener).

## Slash commands (DMs only)

Slack's native client intercepts any message starting with `/`, never delivering it to the bot. Halo works around this by accepting `!cmd` as an alias on the way in and rewriting `!cmd` back to `/cmd` in help text on the way out (via `slashToBang()`).

Only available in DMs (to avoid noise in channels where threads are already bounded sessions):

| Command | Purpose |
|---|---|
| `!session new` | Create a new session; old ones accessible via `!session list` + `!session switch` |
| `!session list` | List recent sessions (newest first, up to 20) |
| `!session switch <index>` | Switch active session |
| `!session stop` | Abort running task |
| `!session compact` | Compress context |
| `!ws info` | Show workspace; `!ws switch <path>` changes it (full access only) |
| `!help` | List commands |

Channels/groups have no slash commands — a thread's context is already preserved, so creating a new session per thread is the design.

## Media support

### Inbound

Text, images (base64 attached to agent input for vision), files. All files are downloaded via the bot token and saved to the workspace media store.

### Outbound

The agent runtime produces `MEDIA: <path>` markers. SlackResponder:
- Intercepts the markers and calls `uploadFile()` for each one
- Blocks sandbox violation (files must be under workspace or /tmp)
- Falls back to error text if upload fails

Outbound media uses Slack's v2 upload flow (getUploadURLExternal → signed PUT → completeUploadExternal).

## Scope and out-of-scope

Supported: DMs + channels + private channels + group DMs; text + images + files; threads; per-session access level; slash commands in DMs; media ingest + send; Socket Mode.

Not supported: interactive messages (blocks/buttons/callbacks), slash commands in channels (existing thread-per-topic design suffices), rich formatting beyond mrkdwn.

## References

Slack-specific paths:

- `packages/server/src/channels/slack/handler.ts:245` — `connect()` Socket Mode setup
- `packages/server/src/channels/slack/handler.ts:384` — `handleInbound()` event dispatch
- `packages/server/src/channels/slack/handler.ts:537` — `getOrCreateSessionForThread()` session keying
- `packages/server/src/channels/slack/api.ts:265` — `openSocketModeConnection()` fetch wss:// URL
- `packages/server/src/channels/slack/cron-dispatcher.ts:46` — `dispatch()` cron push logic
- `packages/server/src/channels/slack/event-adapter.ts:90` — `dispatchChunk()` buffer flush + media extraction

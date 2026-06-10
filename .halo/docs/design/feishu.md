# Feishu/Lark Channel — Design

Let the user talk to Halo from Feishu (Lark) on their phone, sharing the same workspace + sessions as the web side. All channels are peers — each one is a subscriber + caller against SessionManager.

## Architecture

```
                       ┌── ws/ (web channel)            ─┐
                       ├── channels/telegram/            │
Halo server (9527) ──┤├── channels/wechat/              ├── SessionManager
                       ├── channels/slack/               │    (per workspace, via Registry)
                       └── channels/feishu/ ←─ long-connect (wss) ─┘
                                    ↕ Lark.WSClient
                           https://open.feishu.cn
```

Feishu uses the official SDK's `Lark.WSClient` to maintain a persistent WebSocket connection for event delivery. Unlike Slack/Telegram (which use webhooks + polling respectively), Feishu's long-connect receives `im.message.receive_v1` events pushed by the server over wss.

## Data model

### Workspace ↔ Bot mapping

One Feishu app (= one appId + appSecret pair) is bound to one workspace. A workspace can bind multiple apps.

### Session strategy

- **One Feishu user → many sessions (one active at a time, per thread)**
- Session ID format: `feishu_<chatId>:<rootId>_<createdAtBase36>`
- In p2p (DM): rootId anchored to `dm` for a stable key across multiple messages
- In group: each thread is its own bounded session, keyed by the thread's root message id
- Sessions live under the bot's bound workspace and use the `default` agent
- Access level inherited from the account's `accessLevel` field (see below)

### Access level

Each account carries `accessLevel: 'full' | 'workspace' | 'readonly'` (default `readonly`):
- `full` — no restrictions (no sandbox)
- `workspace` — tool execution runs inside a bwrap sandbox with the workspace mounted read-write
- `readonly` — tool execution runs inside a bwrap sandbox with the workspace mounted read-only; readonly sessions only receive read-only tools

### Storage

Feishu bot accounts are stored in the unified channel DB: `~/.halo/secrets/channels/channels.db`, table `channel_accounts` with `channel_type = 'feishu'`. See [storage.md](storage.md#channel_accounts) for the full schema.

Feishu-specific config JSON fields: `appId`, `appSecret`, `verificationToken` (legacy), `encryptKey` (optional), `botOpenId`, `lastActiveChatId`.

- `lastActiveChatId` is a runtime cache of the most recent `<chatId>:<rootId>` pair. Written by `rememberLastActiveChat()` in `channels/shared/accounts.ts` on every inbound message (idempotent). Used as a fallback for cron sends in edge cases where no explicit target is available.

### Authentication model

- `appId` + `appSecret` are long-lived credentials from the Feishu open platform
- Used to mint short-lived `tenant_access_token` (~2 hour lifetime) for all API calls
- `verificationToken` and `encryptKey` handle webhook security (for legacy webhook setups; not used with long-connect)
- `botOpenId` is the bot's own open_id, used to detect mentions in group chats

Token caching is in-memory per-app in `api.ts:tokenCache`; refresh happens on-demand 60s before expiry.

### Proactive sending (cron)

The feishu cron-dispatcher (`channels/feishu/cron-dispatcher.ts`) requires an explicit `chatId` (no fallback to `lastActiveChatId` like Slack/WeChat). When a cron fires:

1. **Explicit `chatId` on the target** — set when the cron was created from inside a Feishu chat (e.g. cron created from a group thread auto-pins to that thread). Sends only to that chat (top-level message, not nested in the thread — Feishu's open API v1 doesn't support thread-targeting in sendMessage).
2. **Admin-UI cron without explicit target** — runs silently if no chatId is provided.

## Modules

Files: `packages/server/src/channels/feishu/`

- `types.ts` — FeishuAccount, FeishuEventEnvelope, FeishuMessageEvent interfaces
- `accounts.ts` — DAL (listAccounts / getAccount / insertAccount / updateAccount / deleteAccount / findAccountByAppId)
- `handler.ts` — Lark.WSClient setup, event dispatch, message handling, session routing, mention detection, media ingestion
- `event-adapter.ts` — AgentSessionEvent stream → coalesced Feishu message replies (buffer + flush at paragraph boundaries)
- `api.ts` — HTTP client (tenant token caching / getBotInfo / sendMessage / replyMessage / uploadImage / uploadFile / downloadResource / decryptWebhookBody / searchFeishuTargets / openLongConnection)
- `cron-dispatcher.ts` — registers the cron dispatcher, requires explicit chatId targets
- `descriptor.ts` — ServerChannelDescriptor entry point

Routes: `packages/server/src/routes/feishu.ts`

- `GET /api/feishu/accounts` — list bot accounts (admin)
- `POST /api/feishu/accounts` — register a bot (validates credentials via `getBotInfo`, auto-resolves botOpenId)
- `PATCH /api/feishu/accounts/:id` — update config / enable / disable
- `DELETE /api/feishu/accounts/:id` — remove + stop
- `GET /api/feishu/accounts/:id/search` — search chats by name (for cron target picker)

## Bot lifecycle

1. User registers a bot via the API (provides appId + appSecret + workspace)
2. Server calls `getBotInfo` to validate credentials and auto-resolve botOpenId; stores account; starts long-connect
3. Lark.WSClient handles the wss connection, ping/pong, URL rotation (~30 min), and automatic reconnection
4. On graceful shutdown, `wsClient.close()` is called for each active bot

## Long-connect frame protocol

On connect to `wss://…` (negotiated via `POST /callback/ws/endpoint`):

1. Client sends a `register` frame containing the `conn_id` received from the negotiation response
2. Server pushes event frames typed by `type`:
   - `1` = `frame` (event payload — `im.message.receive_v1` event data we care about)
   - `2` = `pong` (heartbeat reply)
   - `8` = `disconnect` (server is rotating the URL)
3. Client periodically sends `ping` (type=0) to keep the connection alive

The SDK wraps protobuf marshalling; we just register an `EventDispatcher` callback for `im.message.receive_v1` events.

## Message handling flow

`im.message.receive_v1` event:

1. Extract sender (open_id or user_id), message content, chat_type (p2p or group), mentions array
2. Check if bot was mentioned (p2p: always yes; group: check mentions array for bot's open_id)
3. Drop non-user senders (bots, apps)
4. Determine session key: p2p → `(chatId, 'dm')`; group → `(chatId, rootId ?? messageId)` to anchor each thread
5. Parse content (text / image / file / post) — images extracted as base64 for vision, files noted as `[文件: name]` markers
6. Download inbound images, save to workspace, generate base64 payloads
7. Strip mention markup from text (Feishu inserts `<at user_id="ou_xxx">@bot</at>` or `@_user_123` tokens)
8. Slash command dispatch (p2p only — group threads don't benefit from `/session new`, `/session list`, etc. since each thread is already its own session)
9. Create or retrieve active session for this thread (with inherited access level)
10. If session is compacting → reply "⏳ 正在整理上下文，请稍后再发消息（通常 30 秒内完成）" and skip queueing
11. If session is busy → reply "已收到，会在当前轮结束后处理。" and enqueue
12. Register a `FeishuResponder` event listener (once per session) that coalesces outbound text
13. `sm.sendUserMessage(sessionId, agentInput, images?)` with channel + user + thread context

## Slash commands (native Feishu /commands)

Implemented via `channels/shared/commands.ts` (shared across Telegram, WeChat, Slack, Feishu):

| Command | Purpose |
|---|---|
| `/start` | Welcome message (p2p only) |
| `/session new` | Create a new session (p2p only) |
| `/session list` | List recent sessions (p2p only) |
| `/session switch <index>` | Switch active session (p2p only) |
| `/session stop` | Abort running task |
| `/session compact` | Compress context |
| `/ws info` | Show workspace; `/ws switch <path>` changes it (full access only) |
| `/help` | List commands |

## Event coalescing (FeishuResponder)

Feishu's text message limit (~5000 chars), smaller than Slack. Strategy:

- Buffer streamed text until `complete` event
- If buffer exceeds 4500 chars, split at paragraph boundary (`\n\n`)
- Otherwise hard-cut at 4500 chars
- `system` and `error` events flush early so users always see something before the run ends
- Media markers (`MEDIA:<path>`) intercepted and sent via native media upload
- Sub-agent events dropped (visible in web UI only)

## Media support

**Inbound:** text, images (base64 attached to agent message), files (noted as `[文件: name]` markers), voice, video, rich posts.

**Outbound routing:**
- `.jpg/.png/.gif/.webp/.bmp` → `uploadImage` → `msg_type: 'image'`
- `.opus` → `uploadFile(fileType: 'opus')` → `msg_type: 'audio'` (non-opus voice files sent as generic files)
- `.mp4/.mov/.webm/.m4v/.avi` → `uploadFile(fileType: 'mp4')` → `msg_type: 'media'` (with optional cover frame)
- everything else → `uploadFile(fileType: 'stream')` → `msg_type: 'file'`

Inbound images are downloaded via `/im/v1/messages/{messageId}/resources/{imageKey}?type=image`, decrypted if needed, saved under `<workspace>/.halo/assets/feishu/inbound/<accountId>/<date>/`, and fed to vision.

## Message routing (thread vs p2p)

**p2p (DM):** Replies sent via `sendMessage` targeting the chat (Feishu p2p doesn't support threads).

**Group (chat):** Replies sent via `replyMessage` with `reply_in_thread: true` and the inbound message id. This auto-creates a thread rooted at the inbound message if it doesn't exist, or appends to the existing thread.

## Similarities vs Slack and Telegram

| Aspect | Feishu | Slack | Telegram |
|--------|--------|-------|----------|
| **Inbound delivery** | Long-connect (wss) | Webhook + slash commands | Long-polling |
| **Session model** | Per-thread in groups, p2p anchored | Per-thread + channels | Per-user (one active) |
| **Mention required** | Yes in groups, no in p2p | Yes in channels, no in DMs | No (all messages routed to agent) |
| **Cron fallback** | Explicit chatId only | Explicit channel | Fallback to lastActiveChatId or allowedUsers |
| **Media upload** | Separate image + file endpoints | Unified File upload API | Bot API sendPhoto / sendVideo / sendDocument |
| **Text limit** | ~5000 chars | ~4000 chars | ~4000 chars |
| **Thread support** | Native (root_id in messages) | Native (thread_ts replies) | N/A (group chats not supported) |

## Configuration

### Feishu app setup

1. Go to https://open.feishu.cn/
2. Create a new app (register as a custom app in your org, or create ISV app)
3. Under Settings → Permissions, enable:
   - `im:message:readonly` — receive message events
   - `im:message` — send messages
   - `im:resource` — upload images / files
   - `im:chat:readonly` — search chats (for cron target picker)
4. Under Settings → Bot, enable long-connect: "Get Card / Bot / Message Callbacks" → subscribe to `im.message.receive_v1`
5. Copy `App ID` and `App Secret` (displayed on the settings page, or regenerate if lost)

### Register to Halo

```bash
curl -X POST http://localhost:9527/api/feishu/accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "workspacePath": "/home/user/my-workspace",
    "accessLevel": "full",
    "label": "My Feishu Bot"
  }'
```

Server auto-resolves `botOpenId` from the credentials, validates them, and starts the long-connect immediately.

## Scope and out-of-scope

Supported: p2p text, group text with mention-required; threads; images (base64 attached to agent); audio, video, files (uploaded and referenced); slash commands (p2p only); per-session access level; media sending.

Not supported: group chat without mention (we require explicit @mention for groups to avoid noise); rich message composition in responses (text only, plus media as separate messages); reactions; bot callbacks for button clicks / form submissions.

## Key file references

- Long-connect: `packages/server/src/channels/feishu/handler.ts:connect()` (line 241)
- Token caching: `packages/server/src/channels/feishu/api.ts:getTenantAccessToken()` (line 39)
- Message parsing: `packages/server/src/channels/feishu/handler.ts:parseContent()` (line 135)
- Event dispatch: `packages/server/src/channels/feishu/handler.ts:handleInbound()` (line 301)
- Cron dispatch: `packages/server/src/channels/feishu/cron-dispatcher.ts:dispatch()` (line 27)
- Event coalescing: `packages/server/src/channels/feishu/event-adapter.ts:FeishuResponder` (line 24)
- REST routes: `packages/server/src/routes/feishu.ts` (all account CRUD + search)

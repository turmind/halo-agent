# Web Channel — Design

Browser-based access to Halo via token-authenticated HTTP API. Supports SSE streaming, slash commands, image/voice upload.

## Architecture

```
                       ┌── ws/ (admin channel)             ─┐
                       ├── channels/wechat/                 │
Halo server (9527) ──┤── channels/telegram/               ├── SessionManager
                       └── channels/web/                   ─┘    (per workspace, via Registry)
                               ↕ HTTP + SSE
                         web-demo (9528) ── browser
                         or any HTTP client
```

Common slash commands (`/help`, `/evo`, and the object commands `/session`, `/agent`, `/skill`, `/workspace`) live in `channels/shared/commands.ts`; each channel handler is a thin adapter.

Web channel is a public HTTP API on Halo. `packages/web-demo` is a standalone demo frontend that proxies requests through its own auth layer.

## Data model

### Account / Token

One token = one web access point, bound to one workspace.

Storage: `~/.halo/secrets/channels/channels.db`, table `channel_accounts` with `channel_type = 'web'`. See [storage.md](storage.md#channel_accounts) for the full schema.

Web-specific config JSON fields: `token` (auto-generated base64url, 24 bytes).

### Session strategy

- **One account → many sessions (one active at a time)**
- Session ID format: `web_<accountId>_<createdAtBase36>`
- Active session tracked in memory (`activeOverrides` Map); defaults to most recent
- Sessions live under the account's bound workspace using the highest-priority agent (falls back to `default` only when none exists)
- Admin panel and other channels see these sessions in their `/session list` (tagged `[web]`)
- Access level inherited from the account

### Commands

Slash commands are intercepted before reaching the agent:

| Command | Effect |
|---|---|
| `/help` | List available commands |
| `/session new` | Create a new session |
| `/session list` | List all sessions (show ownership tags) |
| `/session switch <n>` | Switch to session by number (readonly can only switch to own) |
| `/session stop` | Interrupt current running task |
| `/session compact` | Compress session context |
| `/workspace info` | Show current workspace |
| `/workspace switch <path>` | Switch workspace (full access only) |

### Media handling

- **Images** (jpeg/png/gif/webp): passed directly to LLM via multimodal content blocks
- **Audio/other files**: saved to `<workspace>/.halo/assets/web/inbound/<accountId>/<yyyy-mm-dd>/` and path reported to agent in message text

## Halo API — Public endpoints

File: `packages/server/src/routes/web.ts`

All public endpoints require `x-token` header (or `?token=` query param) with a valid account token. No cookie auth needed.

> These paths are listed in `PUBLIC_PATHS` (`middleware/auth.ts`) so they bypass the admin cookie gate: `/api/web/chat`, `/api/web/sessions` (POST mint + GET list), `/api/web/stop`, `/api/web/history`, `/api/web/subscribe`, `/api/web/file`, and `/api/show/state` (the [halo-city](../../../halo-city/) snapshot — see [dev/api.md](../dev/api.md#show-world-snapshot)). The server CORS allowlist includes the `x-token` header, so browser-based custom frontends (web-demo, halo-city) can call these cross-origin.

### POST `/api/web/chat`

Send a message and receive streaming response via SSE.

```json
// Request
{
  "message": "hello",
  "images": [{ "data": "<base64>", "mimeType": "image/png" }],  // optional
  "workspace": "/abs/path",     // optional override, full-access tokens only
  "sessionId": "web_explicit",  // optional override, see below
  "agentId": "default"          // optional, only used when creating a new session
}

// Response: text/event-stream
data: {"type":"session","sessionId":"web_abc123_m1xyz"}
data: {"type":"thinking","text":"..."}
data: {"type":"tool_call","toolName":"file_read","toolUseId":"toolu_01…","toolInput":{...}}
data: {"type":"tool_result","toolName":"file_read","toolUseId":"toolu_01…","result":"..."}   // result capped at 500 chars
: keepalive                                  // SSE comment every 15 s, see below
data: {"type":"stream","text":"Hello! "}
data: {"type":"stream","text":"How can I help?"}
data: {"type":"switch","sessionId":"..."}   // after /session switch or /session new command
data: {"type":"complete"}
data: {"type":"error","error":"..."}
```

> **`toolUseId`**: both tool frames carry the provider's tool_use id, so a client can pair a result with its call even when calls interleave (the [ACP adapter](../dev/acp-adapter.md) uses it as the ACP `toolCallId`, and it matches the `toolUseId` in `/web/history`'s assistant `contentBlocks`). Additive — clients that pair by order can ignore it. It can be an empty string (some OpenAI-compatible streams carry no id); treat empty as missing.

#### SSE keepalive

`/web/chat` and `/web/subscribe` write an SSE comment line `: keepalive` every 15 s (`SSE_KEEPALIVE_MS` / `streamWithKeepalive` in `routes/web.ts`; the timer is cleared when the stream ends). A long tool call can otherwise leave the stream silent long enough for an idle reverse proxy / CDN to cut it. Comment lines aren't events — `EventSource` and any spec-following parser drop them; a hand-rolled parser must skip lines that don't start with `data:` (web-demo's both do).

> **Batch-boundary `complete` (must be absorbed, never closes the stream)**: when a root session drains a queue of multiple messages, the server runs N merged turns and emits an internal `complete` with `batchBoundary: true` between rounds (see [session.md](session.md#message-queue-and-drain)). The SSE generators in `channels/web/handler.ts` (`listenSession().events()` plus the `createMediaBuffer()` event processor) flush the just-finished round's text on a `batchBoundary` complete but **do not** send a `complete` SSE frame and **do not** set `done` — the response stays open for the next round; only the **terminal** (unmarked) `complete` closes the HTTP stream. Without this guard a producer→sub-agent fan-out would truncate the web client after the first round. The `batchBoundary` flag is therefore an internal server-side event marker only — it is never serialized into the SSE payload a client sees, so a custom frontend just consumes one ordinary `complete` at the end. (ACP rides on this channel, so it inherits the same safe behavior.)

> **Listener lifetime**: `handleMessage` registers its session listener (`listenSession`) *before* the media save and `sendUserMessage` — it must be listening when the turn starts — and wraps everything from there to the end of `events()` in a `try/finally` that closes it. So a throw in between (media save failed, `sendUserMessage` threw), a `queued` result, or the end of the stream all drop the listener; before, only `events()`'s own finally and the `queued` branch did, and an early throw leaked it for the process lifetime. The unsubscribe is idempotent, so closing twice on the normal path is harmless. The route passes the request's abort signal (`c.req.raw.signal`) through to `events(signal)` — for `/web/chat` and a skill command's follow-on stream, as `/web/subscribe` already did — so a client that disconnects mid-turn ends the stream and drops the listener right away instead of at the turn's terminal `complete`. The turn itself keeps running; disconnecting is not `/web/stop`.

#### Per-request overrides (`workspace`, `sessionId`, `agentId`)

By default each token is bound 1:1 to the workspace its admin row configured, and `/web/chat` operates on the account's "active" session (most-recently-used or one set by `/session new` / `/session switch`). External integrations — currently the [ACP adapter](../dev/acp-adapter.md) — need finer control:

- `workspace` (string, optional): server-side absolute path. Overrides `account.workspacePath` for this request only. **Gated on `accessLevel === 'full'`** — readonly / workspace tokens cannot escape their account-bound workspace; the gate returns an SSE `error` event.
- `sessionId` (string, optional): explicit halo session id. Bypasses the account's active-session pointer entirely. **Gated by ownership**: `full` tokens may address any id; readonly / workspace tokens only ids their own account minted (`web_<accountId>_*`) — anything else is refused with HTTP 403 `{error: "session not owned by this token"}` at the route layer (before the SSE stream opens), on `/web/chat`, `/web/stop`, `/web/history` and `/web/subscribe` alike. If the session doesn't yet exist, the server creates it with the supplied id (so callers can pre-mint stable ids and address them across reconnects).
- `agentId` (string, optional): only consulted when the request is creating a new session (no row yet for `sessionId`). Picks the agent profile to bootstrap with. Defaults to `default`.

Browser web-demo doesn't use any of these — it relies on per-token defaults. Three accepted transports per request, lowest-priority first:

1. Query string: `?workspace=…&sessionId=…&agentId=…`
2. Headers: `x-workspace`, `x-session-id`, `x-agent-id`
3. POST body fields (highest priority).

`/api/web/stop`, `/api/web/history`, `/api/web/subscribe` accept the same `workspace` + `sessionId` overrides via query string / header, and the same ownership gate. They don't accept `agentId` (no session creation path).

### POST `/api/web/sessions`

Mints a root session in the token's own `web_<accountId>_<ts>_<rand>` namespace, creates the row immediately, and returns `{ sessionId }`. Accepts `workspace` (full tokens only — same gate as above, refused with 403) and `agentId` (agent profile to bootstrap with, defaults to the workspace's default agent) via body / query / header; there is no `sessionId` override by definition.

Why it exists: the ownership gate above means a readonly / workspace token can only address ids under its own prefix, so an external caller cannot pre-mint an id of its own choosing and expect to drive it. The [ACP adapter](../dev/acp-adapter.md) used to mint `web_acp_*` locally and 403'd on the first prompt for anything but a full token; its `session/new` now calls this endpoint instead, so ACP id === halo id still holds and every later `/web/chat|stop|history|subscribe` with that id passes the gate.

Minting never touches the account's active-session pointer — a side session created by an integration must not clobber the browser tab's notion of "current session".

**Namespace sharing**: sessions minted here live under the same `web_<accountId>_` prefix as browser sessions. When the token has no active-session pointer, `/web/chat` without `sessionId` falls back to the latest root session under that prefix — which may be an API-minted one. Use a dedicated token for ACP if the same token also drives a browser client.

### GET `/api/web/sessions`

One page of the token's own root sessions — `web_<accountId>_*`, `parent_id IS NULL`, not archived — newest `updatedAt` first, 50 per page (`listSessions` in `channels/web/handler.ts`, over `SessionManager.listSessions({ rootOnly, prefix, cursor })`). Backs ACP `session/list`.

```json
// GET /api/web/sessions?cursor=<nextCursor>   (cursor optional)
{
  "workspace": "/abs/resolved/path",
  "sessions": [ { "sessionId": "web_abc123_m1xyz_q2", "title": "…", "updatedAt": 1791384914714 } ],
  "nextCursor": 1791384900000     // null on the last page
}
```

- `title` is the session title, falling back to its description, else `null`.
- `cursor` = the previous page's `nextCursor` (an `updatedAt` epoch-ms); the next page is rows updated strictly before it. Digits only — anything else (`0x10`, `1e3`, `-1`) → 400 `{error: "Invalid cursor"}`; an empty `cursor=` is the same as none (first page). Rows sharing the boundary millisecond can be skipped (shared list-query behaviour).
- A `workspace` override naming a directory with no `.halo/` → an empty page; the list never scaffolds a workspace (same guard as the admin `GET /api/sessions/logs`).
- **Prefix-scoped for every access level, `full` included** — the list is "this token's conversations", not the workspace's. A full token can still address any id it knows on the other routes.
- `workspace` override via query / `x-workspace` header, full tokens only (403 otherwise, like the mint). Bad token → 401.

### POST `/api/web/stop`

Stop the currently running task. Accepts optional `workspace` / `sessionId` overrides as documented above.

```json
// Response
{ "stopped": true }
```

### GET `/api/web/history`

Get a session's message history. Without overrides, returns the account's active session; with `sessionId` (and optionally `workspace`), returns whichever session you address.

Optional `since=<epoch ms>`: only root-log rows (no `taskId` — sub-agent rows dropped) whose `timestamp >= since`, filtered **before** serialization. For a caller that only needs the latest turn — the [ACP adapter](../dev/acp-adapter.md) settling a reply after a reconnect / queued drain passes its turn's start time — instead of the whole log, which on a long session runs to many MB of JSON built on the server's main thread. Digits only; anything else → 400 `{error: "Invalid since"}`; empty = absent. Rows are stamped with the server's clock.

```json
// Response
{
  "sessionId": "web_abc123_m1xyz",
  "messages": [ { "id": "...", "role": "user", "content": "..." }, ... ],
  "running": false
}
```

### GET `/api/web/subscribe`

Reconnect to a running session's event stream (same SSE format as `/chat`, keepalive included). Opens with a `session` frame; then, if the session is idle, sends a single `complete` and closes immediately — a manual `/compact` with no turn in flight counts as idle unless messages are queued (only then does `endCompact` drain them into a turn that ends in `complete`) — otherwise it streams until the run's terminal `complete` (batch-boundary completes absorbed as on `/chat`). The listener is registered *before* the idle check, so a turn that ends in between still delivers its `complete`. (Before 2026-10 the idle case waited for the next turn's `complete` instead of returning.) Accepts the same `workspace` / `sessionId` overrides.

## Halo API — Admin endpoints

Protected by cookie auth (admin panel). File: `packages/server/src/routes/web.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/web/accounts` | List all accounts |
| POST | `/api/web/accounts` | Create account (body: `{workspacePath, label?, accessLevel?, language?}`) |
| PATCH | `/api/web/accounts/:id` | Update account fields (label, workspacePath, enabled, accessLevel, language) |
| DELETE | `/api/web/accounts/:id` | Delete account (token invalidated) |

---

## packages/web-demo — Standalone Demo Frontend

An independent Express app that provides a browser UI for the web channel. It holds the Halo token server-side and exposes its own password-based auth.

### Deployment

```bash
cd packages/web-demo
node server.js
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `HALO_API` | Yes | Halo server URL (e.g. `http://localhost:9527`) |
| `HALO_TOKEN` | Yes | Token from Halo admin panel (Web settings) |
| `HALO_WEB_DEMO_PASSWORD` | No | Password for web-demo login. Empty = open access |
| `PORT` | No | Listen port (default: `9528`) |

### Security model

- **Proxy mode (default)**: `HALO_TOKEN` and `HALO_API` are server-side only, never exposed to the browser; frontend uses same-origin relative paths (`/chat`, `/history`, etc.); web-demo server proxies all requests to Halo, injecting the token in `x-token` header. Session auth: HMAC token in `x-session` header + localStorage. All proxy routes including `GET /file` are gated by the auth middleware.
  - **Session TTL: 7 days**, enforced without server-side storage — the signed payload *is* the issue timestamp, so `isValidSession` re-parses it and rejects anything older than `SESSION_TTL_MS`. A leaked token therefore stops working on its own; the frontend gets a 401 and falls back to the login view (`handleAuthFail → logout`). Previously the signature alone was checked, making every issued token valid forever.
- **Direct-connect mode (opt-in)**: the gear panel takes a halo server URL + web-channel token; the browser then calls `<server>/api/web/*` directly with `x-token`, bypassing the proxy (no password step). The token is stored in that browser's localStorage by explicit user choice — the UI says so next to the field. One slot; clearing it returns to proxy mode. Works because the server CORS reflects any origin and allowlists `x-token`.

### Proxy routes

| Frontend path | Upstream Halo path |
|---|---|
| `POST /chat` | `POST /api/web/chat` |
| `POST /stop` | `POST /api/web/stop` |
| `GET /history` | `GET /api/web/history` |
| `GET /subscribe` | `GET /api/web/subscribe` |
| `GET /file` | `GET /api/web/file` |

### Features

- Markdown rendering for assistant text (marked@12, gfm + breaks) with typewriter streaming; user text stays escaped plain text
- SSE streaming with collapsible thinking / tool-call step blocks
- Auto-reconnect: if session is running on page load, subscribes to live stream; history renders rebuild-from-scratch (never append)
- Message queue: can send while agent is running, messages queue and send sequentially
- Slash commands (`/help`, `/session`, `/agent`, `/skill`, `/workspace`), session/agent switcher menus
- Image upload + camera capture (camera button is mobile-only — the `capture` attribute is a no-op on desktop, where it would duplicate the file picker)
- Voice recording (webm audio saved to workspace, path given to agent)
- Stop/interrupt button
- i18n: auto-detects browser language (`navigator.language`), toggle button in header, persists to `localStorage`
- Mobile-first layout: 100dvh-safe, safe-area insets, ≥44px touch targets, bottom-sheet menus/settings on small widths, visual language shared with `packages/agentcore-demo`
- Page load needs internet for two CDN deps (tailwindcss, marked) — no longer fully self-contained

## Integration guide (custom frontend)

To build your own frontend against Halo's web channel:

1. Create an account in the admin panel (Channels → Web → Create)
2. Copy the generated token
3. Make HTTP requests with `x-token: <your-token>` header:

```bash
# Send a message (SSE response)
curl -N -H "x-token: YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"hello"}' \
  http://localhost:9527/api/web/chat

# Stop current task
curl -X POST -H "x-token: YOUR_TOKEN" http://localhost:9527/api/web/stop

# Get history
curl -H "x-token: YOUR_TOKEN" http://localhost:9527/api/web/history

# Subscribe to running session
curl -N -H "x-token: YOUR_TOKEN" http://localhost:9527/api/web/subscribe
```

SSE events are newline-delimited `data: {json}\n\n` lines. Parse the `type` field to handle each event kind.

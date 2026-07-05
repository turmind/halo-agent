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

> These paths are listed in `PUBLIC_PATHS` (`middleware/auth.ts`) so they bypass the admin cookie gate: `/api/web/chat`, `/api/web/stop`, `/api/web/history`, `/api/web/subscribe`, `/api/web/file`, and `/api/show/state` (the [halo-city](../../../halo-city/) snapshot — see [dev/api.md](../dev/api.md#show-world-snapshot)). The server CORS allowlist includes the `x-token` header, so browser-based custom frontends (web-demo, halo-city) can call these cross-origin.

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
data: {"type":"tool_call","toolName":"read_file","toolInput":{...}}
data: {"type":"tool_result","toolName":"read_file","result":"..."}
data: {"type":"stream","text":"Hello! "}
data: {"type":"stream","text":"How can I help?"}
data: {"type":"switch","sessionId":"..."}   // after /session switch or /session new command
data: {"type":"complete"}
data: {"type":"error","error":"..."}
```

> **Batch-boundary `complete` (must be absorbed, never closes the stream)**: when a root session drains a queue of multiple messages, the server runs N merged turns and emits an internal `complete` with `batchBoundary: true` between rounds (see [session.md](session.md#message-queue-and-drain)). The SSE generators in `channels/web/handler.ts` flush the just-finished round's text on a `batchBoundary` complete but **do not** send a `complete` SSE frame and **do not** set `done` — the response stays open for the next round; only the **terminal** (unmarked) `complete` closes the HTTP stream. Without this guard a producer→sub-agent fan-out would truncate the web client after the first round. The `batchBoundary` flag is therefore an internal server-side event marker only — it is never serialized into the SSE payload a client sees, so a custom frontend just consumes one ordinary `complete` at the end. (ACP rides on this channel, so it inherits the same safe behavior.)

#### Per-request overrides (`workspace`, `sessionId`, `agentId`)

By default each token is bound 1:1 to the workspace its admin row configured, and `/web/chat` operates on the account's "active" session (most-recently-used or one set by `/session new` / `/session switch`). External integrations — currently the [ACP adapter](../dev/acp-adapter.md) — need finer control:

- `workspace` (string, optional): server-side absolute path. Overrides `account.workspacePath` for this request only. **Gated on `accessLevel === 'full'`** — readonly / workspace tokens cannot escape their account-bound workspace; the gate returns an SSE `error` event.
- `sessionId` (string, optional): explicit halo session id. Bypasses the account's active-session pointer entirely. If the session doesn't yet exist, the server creates it with the supplied id (so callers can pre-mint stable ids and address them across reconnects).
- `agentId` (string, optional): only consulted when the request is creating a new session (no row yet for `sessionId`). Picks the agent profile to bootstrap with. Defaults to `default`.

Browser web-demo doesn't use any of these — it relies on per-token defaults. Three accepted transports per request, lowest-priority first:

1. Query string: `?workspace=…&sessionId=…&agentId=…`
2. Headers: `x-workspace`, `x-session-id`, `x-agent-id`
3. POST body fields (highest priority).

`/api/web/stop`, `/api/web/history`, `/api/web/subscribe` accept the same `workspace` + `sessionId` overrides via query string / header. They don't accept `agentId` (no session creation path).

### POST `/api/web/stop`

Stop the currently running task. Accepts optional `workspace` / `sessionId` overrides as documented above.

```json
// Response
{ "stopped": true }
```

### GET `/api/web/history`

Get a session's message history. Without overrides, returns the account's active session; with `sessionId` (and optionally `workspace`), returns whichever session you address.

```json
// Response
{
  "sessionId": "web_abc123_m1xyz",
  "messages": [ { "id": "...", "role": "user", "content": "..." }, ... ],
  "running": false
}
```

### GET `/api/web/subscribe`

Reconnect to a running session's event stream (same SSE format as `/chat`). If session is not running, returns a single `complete` event immediately. Accepts the same `workspace` / `sessionId` overrides.

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

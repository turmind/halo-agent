# Web

Talk to a halo agent over plain HTTP from any client you control — a browser, a curl script, a custom frontend, your own mobile app. The Web channel is the "build your own UI" channel: it gives you a token, you give the token to whatever client you wrote.

> If you want a ready-made browser frontend without writing code, halo ships `packages/web-demo` — a tiny Express app that wraps the Web channel with its own password gate. See "Standalone web-demo frontend" at the bottom.

## What you'll end up with

- A 24-byte random token (base64url-encoded) bound to one workspace
- A few public HTTP endpoints under `/api/web/*` that accept that token

The token is **the** credential — anyone holding it can talk to the agent at the bound workspace's access level. Treat it like a password.

## Step 1 — Create an account

Open halo admin → **Channels** → **Web** → **Add Account**:

| Field | Value |
|---|---|
| Workspace path | absolute path, e.g. `/home/ubuntu/my-project` |
| Label | optional |
| Access level | `readonly` (default), `workspace`, or `full` |
| Language | `en` or `zh` |

Click **Create**. The success screen shows the auto-generated token **once** — copy it now, you can't retrieve it again. (You can always delete the account and create a new one if you lose the token.)

## Step 2 — Use the token

All public endpoints require an `x-token: <token>` header (or `?token=<token>` query for endpoints that can't easily set headers, like SSE in browsers).

### Send a message (SSE stream back)

```bash
curl -N -H "x-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"hello"}' \
  http://localhost:9527/api/web/chat
```

Response is a stream of `data: {json}\n\n` SSE frames:

```
data: {"type":"session","sessionId":"web_abc123_m1xyz"}
data: {"type":"thinking","text":"..."}
data: {"type":"tool_call","toolName":"file_read","toolInput":{...}}
data: {"type":"tool_result","toolName":"file_read","result":"..."}
data: {"type":"stream","text":"Hello! "}
data: {"type":"stream","text":"How can I help?"}
data: {"type":"complete"}
```

Parse the `type` field on each event to render text vs tool calls vs completion.

### Other endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST /api/web/chat` | Send a message; SSE response |
| `POST /api/web/stop` | Cancel the running task |
| `GET /api/web/history` | Fetch session message history |
| `GET /api/web/subscribe` | Reconnect to a running session's SSE stream |

All four accept the same auth header.

### Per-request overrides

By default each token is locked to the workspace and active session set by the admin. External integrations (notably the [ACP adapter](acp.md)) need finer control:

- `workspace` — server-side absolute path, **gated on `accessLevel === 'full'`** (readonly / workspace tokens can't escape their bound workspace; the override is rejected)
- `sessionId` — explicit halo session id; lets clients pre-mint stable ids and address them across reconnects
- `agentId` — only used when the request creates a new session

These can be passed as POST body fields, headers (`x-workspace`, `x-session-id`, `x-agent-id`), or query params (`?workspace=…&sessionId=…&agentId=…`). POST body wins on conflict.

For browser apps you almost never want these — leave them off and use the per-token defaults.

## Step 3 — Send images / files

`/api/web/chat` accepts an optional `images` array, base64-encoded:

```json
{
  "message": "what's in this picture?",
  "images": [
    { "data": "<base64>", "mimeType": "image/png" }
  ]
}
```

Images go to the LLM as multimodal content. Audio and other binary uploads aren't supported on this endpoint directly — for those, save the file to `<workspace>/.halo/assets/web/inbound/<accountId>/<date>/` first (out-of-band) and reference its path in your message text.

The standalone web-demo handles voice + arbitrary files for you; if you want that, use it as a reference implementation.

## Slash commands

Slash commands are intercepted before they reach the agent — same set as every other channel:

| Command | Effect |
|---|---|
| `/new` | New session |
| `/list` | Recent sessions (with ownership tags) |
| `/switch <n>` | Switch active session |
| `/stop` | Cancel the running task |
| `/compact` | Compress context |
| `/ws` | Show / change workspace (full access only) |
| `/help` | List commands |

Send a slash command exactly like a normal message — the server detects the leading `/`.

## Common problems

| Symptom | Cause / fix |
|---|---|
| `401` on every call | Missing `x-token` header, or token is for a deleted account |
| `403` when passing `workspace=…` | Token is `readonly` / `workspace` access — only `full` can override |
| SSE stream hangs forever | Reverse proxy buffering. Disable buffering for `text/event-stream` (nginx: `proxy_buffering off`, Cloudflare: enable streaming) |
| Token leaked accidentally | Delete the account in admin, create a new one. The old token is invalidated immediately |
| Want to share one token across multiple users | Don't — every request would land on the same active session. Create one account per user / app |

## Standalone web-demo frontend

If you want a browser UI with login, image upload, voice recording, and multi-language support without writing it yourself:

```bash
cd packages/web-demo
node server.js
```

Environment variables:

| Variable | Required | Description |
|---|---|---|
| `HALO_API` | yes | Halo server URL, e.g. `http://localhost:9527` |
| `HALO_TOKEN` | yes | The web-channel token from Step 1 |
| `HALO_WEB_DEMO_PASSWORD` | no | Password gate; empty means open access |
| `PORT` | no | Listen port; default `9528` |

The demo holds your token server-side and exposes its own password-based session — the browser never sees the halo token. Open `http://localhost:9528` to use it.

## Security notes

- **Tokens are unhashed** in `~/.halo/secrets/channels/channels.db`. Restrict that file to the user that runs halo
- **No rate limit at the channel level** — if you expose the API on the public internet, put a reverse proxy with rate limits in front
- **Admin endpoints** (`POST /api/web/accounts`, `PATCH`, `DELETE`) require admin cookie auth, **not** the token. They're for the admin panel, not for the token holder
- A `full`-access token can call `/ws <abs-path>` to switch the bound workspace database-side. If you don't want that, give out `workspace` or `readonly` tokens instead

## Reference

- Code: `packages/server/src/channels/web/`
- Routes: `packages/server/src/routes/web.ts`
- Admin UI: `packages/admin/src/features/web/web-settings.tsx`
- Design notes: [../../design/web.md](../../design/web.md)

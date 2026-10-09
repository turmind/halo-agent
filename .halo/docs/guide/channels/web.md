# Web

Talk to a halo agent over plain HTTP from any client you control — a browser, a curl script, a custom frontend, your own mobile app. The Web channel is the "build your own UI" channel: it gives you a token, you give the token to whatever client you wrote.

## What you'll end up with

- A 24-byte random token (base64url-encoded) bound to one workspace
- A few public HTTP endpoints under `/api/web/*` that accept that token

The token is **the** credential — anyone holding it can talk to the agent at the bound workspace's access level. Treat it like a password.

## Step 1 — Create an account

Open halo admin → **Channels** → **Web** → **Create Access**:

| Field | Value |
|---|---|
| Bind to workspace | absolute path, e.g. `/home/ubuntu/my-project` |
| Name (optional) | a label for the account |
| Access level | `readonly` (default), `workspace`, `full`, or `observer` (global read-only, for dashboards / metrics) |
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

Response is a standard SSE stream: `data: {json}` event lines, plus a `: keepalive` comment line every 15 s so an idle proxy doesn't cut the connection during a long tool call:

```
data: {"type":"session","sessionId":"web_abc123_m1xyz"}
data: {"type":"thinking","text":"..."}
data: {"type":"tool_call","toolName":"file_read","toolUseId":"toolu_01…","toolInput":{...}}
: keepalive
data: {"type":"tool_result","toolName":"file_read","toolUseId":"toolu_01…","result":"..."}
data: {"type":"stream","text":"Hello! "}
data: {"type":"stream","text":"How can I help?"}
data: {"type":"complete"}
```

Parse the `type` field on each event to render text vs tool calls vs completion. **Only lines starting with `data:` are events** — skip everything else (the keepalive comment, blank separators). `EventSource` does this for you; a hand-rolled parser that splits on `\n\n` and slices off `data: ` will break on the keepalive. `toolUseId` pairs a `tool_result` with its `tool_call` when several run at once (it can be empty for some model providers — then pair with the most recent call).

### Other endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST /api/web/chat` | Send a message; SSE response |
| `POST /api/web/sessions` | Mint a new root session in the token's namespace; returns `{sessionId}` |
| `GET /api/web/sessions?cursor=…` | List the token's own conversations, newest first, 50 per page → `{workspace, sessions: [{sessionId, title, updatedAt}], nextCursor}`; pass `nextCursor` back as `cursor` for the next page (`null` = last page) |
| `POST /api/web/stop` | Cancel the running task |
| `GET /api/web/history` | Fetch session message history (optional `since=<epoch ms>`: only rows from then on) |
| `GET /api/web/subscribe` | Reconnect to a running session's SSE stream (an idle session answers with one `complete` straight away) |
| `GET /api/web/file?path=…` | Fetch a file from the bound workspace (path relative to it; `.halo` runtime state is refused) |

All seven accept the same auth header.

### Per-request overrides

By default each token is locked to the workspace and active session set by the admin. External integrations (notably the [ACP adapter](acp.md)) need finer control:

- `workspace` — server-side absolute path, **gated on `accessLevel === 'full'`** (readonly / workspace tokens can't escape their bound workspace; the override is rejected)
- `sessionId` — explicit halo session id; lets clients address a session across reconnects. **Gated on ownership**: `full` tokens may name any id; `readonly` / `workspace` tokens only ids under their own account (`web_<accountId>_*`, e.g. minted by `POST /api/web/sessions`) — anything else is `403`
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

Images go to the LLM as multimodal content. Any other `mimeType` (audio, PDF, …) in the same array is not sent to the model: the server saves it to `<workspace>/.halo/assets/web/inbound/<accountId>/<date>/` and appends a `[语音已保存: <path>]` line to your message so the agent can open it with its file tools.

## Slash commands

Slash commands are intercepted before they reach the agent — same set as every other channel:

| Command | Effect |
|---|---|
| `/session <verb>` | Session lifecycle: `new` / `list` / `switch <n>` / `stop` / `interrupt` / `compact` / `context` / `info` |
| `/agent <verb>` | Manage agents (`list` / `switch` / `desc` open to all; `delete` full; `create` / `update` via skill, full) |
| `/skill <verb>` | Manage skills (`list` / `desc` open; `disable` / `enable` workspace; `delete` full; `create` / `update` via skill, full) |
| `/workspace <verb>` | Workspace: `info` (all) / `switch <path>` (full) / `setup` / `tidy` (workspace) / `share` (full) |
| `/cron` `/extension` | Skill-backed object commands (full access); `/evo [hint]` queues a self-evolution run |
| `/help` | List commands — object commands show only the verbs you can run |

Send a slash command exactly like a normal message — the server detects the leading `/`.

## Common problems

| Symptom | Cause / fix |
|---|---|
| `401` on every call | Missing `x-token` header, or token is for a deleted account |
| `429` | 5 bad tokens from one IP within 15 minutes locks that IP out for 15 minutes (in-memory, cleared on restart) |
| `403` when passing `workspace=…` or a foreign `sessionId` | Token is `readonly` / `workspace` access — only `full` can override the workspace or address sessions it didn't mint |
| SSE stream hangs forever | Reverse proxy buffering. Disable buffering for `text/event-stream` (nginx: `proxy_buffering off`, Cloudflare: enable streaming) |
| Token leaked accidentally | Delete the account in admin, create a new one. The old token is invalidated immediately |
| Want to share one token across multiple users | Don't — every request would land on the same active session. Create one account per user / app |

## Security notes

- **Tokens are unhashed** in `~/.halo/secrets/channels/channels.db`. Restrict that file to the user that runs halo
- **Bad-token lockout only** — 5 invalid tokens from one IP in 15 minutes locks that IP out (`429`) for 15 minutes; there is no per-token request rate limit, so if you expose the API on the public internet put a reverse proxy with rate limits in front
- **Admin endpoints** (`POST /api/web/accounts`, `PATCH`, `DELETE`) require admin cookie auth, **not** the token. They're for the admin panel, not for the token holder
- A `full`-access token can call `/workspace switch <abs-path>` to switch the bound workspace database-side. If you don't want that, give out `workspace` or `readonly` tokens instead

## Reference

- Code: `packages/server/src/channels/web/`
- Routes: `packages/server/src/routes/web.ts`
- Admin UI: `packages/admin/src/features/web/web-settings.tsx`
- Design notes: [../../design/web.md](../../design/web.md)

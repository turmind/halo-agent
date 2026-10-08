# ACP Adapter

A stdio bridge that lets any [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) (ACP) client — an ACP-capable editor such as Zed or a JetBrains IDE — drive a halo server as if it were a native ACP agent.

The adapter is **only a translator**: ACP JSON-RPC over stdin/stdout on one side, halo's existing web channel HTTP + SSE on the other. It does not run agents itself, store any state on disk, or duplicate halo's auth / access-level model. One token in, one workspace out, one halo server upstream.

## When to reach for it

Topology that motivated the adapter:

```
[Mac]                                    [EC2]
Zed / JetBrains IDE                          halo server (port 9527)
   │   ACP / JSON-RPC over stdio                │
   ▼                                            │
halo acp adapter ────HTTP/SSE────────────────▶│
                                                │
                                          halo agent
                                          (workspace files
                                           live on EC2)
```

An editor on a developer's laptop wants to talk to a halo agent running in an EC2 / shared dev box. ACP is the protocol; this adapter is what makes the JSON-RPC stream the editor emits look like halo's HTTP + SSE chat to the server. Adapter and editor typically run on the same machine; the halo server sits behind whatever endpoint the developer configures.

## Quick start

1. Provision a web-channel token. Admin UI → Channels → Web → Create. Grab the token. **For multi-workspace use, pick `full` access level** — readonly / workspace tokens cannot override the workspace per request. For single-workspace use a readonly / workspace token works too: sessions are minted server-side in the token's own namespace, so the ownership gate never bites.

2. Launch the adapter from your ACP client. For Zed / JetBrains, register it as a custom agent (`agent_servers` in Zed's `settings.json` / `~/.jetbrains/acp.json` — full snippets in [guide/channels/acp.md](../guide/channels/acp.md#wiring-into-zed)):

   ```sh
   halo acp \
     --host my-ec2-or-localhost \
     --port 9527 \
     --token <web-token-from-step-1> \
     --workspace /abs/path/on/server \
     --agent-id default        # optional; omitted = the workspace's entry agent
   ```

3. The adapter writes JSON-RPC frames to stdout (1 message per line) and reads stdin the same way. Stderr is reserved for human-readable diagnostics — do not parse.

## CLI flags

| Flag             | Required | Notes                                                                                    |
|------------------|----------|------------------------------------------------------------------------------------------|
| `--host`         | yes      | Halo server hostname / IP (e.g. `localhost`, `ec2-1-2-3-4.compute…`).                  |
| `--port`         | yes      | Halo server port (e.g. `9527`).                                                        |
| `--scheme`       | no       | URL scheme — `http` or `https` (default `http`). Use `https` when the server sits behind a TLS reverse proxy. Invalid values are rejected at the adapter boundary. |
| `--token`        | yes      | Web-channel token from admin UI. `full` access required for multi-workspace use.         |
| `--workspace`    | yes      | Absolute server-side path for the workspace this adapter drives.                         |
| `--agent-id`     | no       | Halo agent profile to use when ACP `session/new` creates a new halo session. Must be a non-internal, non-disabled agent (else `session/new` fails with `agent not available`). Default: the workspace's entry agent — the highest-`priority` non-disabled, non-internal agent, i.e. `default` out of the box. Alias: `--agent` (matches the main CLI's `--agent`). |
| `--header`       | no       | Extra HTTP header on every upstream request, `"Name: value"` (like `curl -H`). Repeatable. For auth that sits **in front of** the halo server — see "Upstream auth" below. |

One adapter process binds to one workspace. To drive multiple workspaces concurrently from the same token, run multiple adapter processes — see "Multi-workspace" below.

## Upstream auth (`--header`)

`--token` authenticates the adapter to *halo itself* (it becomes the `x-token` header on every web-channel call). It does **not** cover a proxy sitting in front of the server — an SSO/session-cookie gateway, Cloudflare Access, ALB OIDC, nginx basic-auth. Those reject the request before halo ever sees the token.

`--header` is the generic escape hatch: it forwards arbitrary headers on every request the adapter makes (`/api/web/sessions`, `/chat`, `/history`, `/stop`), exactly like `curl -H`. The adapter deliberately knows nothing about any specific gateway — you supply whatever that layer wants:

```sh
# session-cookie gateway
halo acp --host h --port 9527 --scheme https --token <t> --workspace /ws \
  --header "Cookie: <the gateway's session cookie, verbatim>"

# Cloudflare Access (two headers — --header is repeatable)
halo acp … --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"

# HTTP basic auth
halo acp … --header "Authorization: Basic <base64 user:pass>"
```

Notes:

- **Repeatable** — pass `--header` as many times as the gateway needs.
- **Colon-safe** — the value is split on the *first* `:` only, so header values that themselves contain colons (`Cookie: a=b:c`) survive intact.
- **`x-token` always wins** — `--header` cannot override the adapter's own `x-token` / `content-type`; it only adds headers for the layer in front of halo.

## ACP method coverage

ACP protocol v1 (stable schema). The [ACP TCK](https://github.com/agentclientprotocol/acp-tck) v1 suite reports **CONFORMANT** — every mandatory requirement passes; capability requirements for features not advertised below are skipped.

**Minimum server: halo 1.5.11.** The adapter relies on server behaviour introduced there: `/api/web/subscribe` answering an idle session with one `complete` (older servers wait for the next turn's, so a prompt whose turn ended during a reconnect backoff — or whose queued drain finished before subscribe attached — hangs until another turn runs or the client cancels), `GET /api/web/sessions` (`session/list`), `toolUseId` on tool frames (older servers fall back to order-based pairing), `/api/web/history?since=` (older servers ignore it and send the whole log), a readonly / workspace token addressing the goal session bound to its own session (older servers 403 the goal-mode re-attach / stop), and the SSE keepalive. `halo acp` is often a newer local CLI talking to a remote server — upgrade the server first.

| Method              | Implemented? | Notes                                                                  |
|---------------------|--------------|------------------------------------------------------------------------|
| `initialize`        | ✅           | Declares `protocolVersion: 1`, `loadSession: true`, `sessionCapabilities: { list: {} }`, `promptCapabilities: { image: true, audio: false, embeddedContext: true }`, `authMethods: []`, and `agentInfo: { name: 'halo', title: 'Halo', version }` (the adapter package version — `src/version.ts`, pinned to `package.json` by a test because the bundled CLI has no `package.json` to read). |
| `authenticate`      | ✅ (no-op)   | Token already passed via launch flags; ACP-side auth has nothing to do. |
| `session/new`       | ✅           | Calls `POST /api/web/sessions`; the server mints `web_<accountId>_<ts>_<rand>` and creates the row immediately. The adapter registers the id locally. `cwd` / `mcpServers` are accepted and ignored (the agent runs in the server workspace). |
| `session/load`      | ✅           | Fetches `/api/web/history?sessionId=<id>` (404 → `-32602`), replays the session's **active log** as `session/update`s — all of them before the response — then answers `{}` and registers the id locally. That is the whole conversation until the session file is archived; after archiving (a compact on a log over the size threshold) only the newest part remains in the active log, so only that part is replayed. See "History replay" below. A turn still running server-side is replayed as far as it got; the live tail isn't attached. |
| `session/list`      | ✅           | `GET /api/web/sessions` — the token's own root sessions, newest first, 50 per page. Each entry is `{ sessionId, cwd, title?, updatedAt }`: `cwd` is the server-resolved workspace, `title` falls back to the session description (omitted when neither is set), `updatedAt` is ISO 8601. A `cwd` filter that isn't that workspace → `{ sessions: [] }`. `cursor` is opaque (the server's `nextCursor`, an updatedAt epoch-ms, as a string); anything that isn't plain digits → `-32602`, an empty one is the first page. |
| `session/prompt`    | ✅           | Content blocks → one halo message + `images[]` (`composePrompt` in `src/adapter.ts`), in prompt order — consecutive `text` blocks concatenate, every other block becomes its own paragraph: `image` → `images[]`; `resource` with `text` → a `[resource: <uri>]` line + the content in a fenced block (fence longer than any backtick run inside); `resource` with `blob` → `[binary resource omitted: <uri>]`; `resource_link` → `[resource link: <name> <uri>]` — a pointer only, the server can't open a client-local path. Text and `resource_link` are the v1 baseline every agent MUST accept; `image` / `resource` are the advertised `image` / `embeddedContext` capabilities. Anything else (`audio` — not advertised — or an unknown type) is dropped with a stderr warning. A second prompt on a session whose turn is still in flight → `-32600`; an empty prompt → `-32602`. Resolves `end_turn` or `cancelled` — see "Prompt turn lifecycle" below. |
| `session/cancel`    | ✅           | A notification (the legacy request form is still answered `null`). Fires `/web/stop` and keeps reading the stream so the stop's own updates reach the client before the prompt resolves `cancelled` — see "Prompt turn lifecycle". |
| Unknown methods     | —            | Requests → `-32601` (method not found); notifications — including `$/cancel_request` — are ignored and the connection stays usable. |
| `session/resume`, `session/set_mode`, `session/set_config_option`, `session/delete`, `session/close`, `logout` | ❌ | Not advertised, so they answer `-32601`. |
| Reverse `fs/*`      | ❌           | See "Reverse fs" below.                                                |
| Reverse `terminal/*`| ❌           | Same reasoning as reverse fs.                                          |
| `requestPermission` | ❌           | Halo has its own access-level system at the channel-account level; we don't surface a second permission gate at ACP. |

Also not sent: `available_commands_update`, `plan`, tool `locations` (paths are server-side — the client couldn't open them). The client's `mcpServers` are not connected.

### Session id model

ACP sessionId == halo sessionId. There's no extra mapping layer in the adapter: `session/new` asks the server for a fresh session (`POST /api/web/sessions`), which mints `web_<accountId>_<ts>_<rand>` inside the token's own namespace and creates the `agent_sessions` row on the spot — that exact string is what the ACP client gets back. The server has to be the one minting because readonly / workspace tokens can only address ids under their own `web_<accountId>_` prefix (`canAddressSession` in `packages/server/src/channels/web/handler.ts`); an adapter-chosen id would 403 on the first prompt. When the ACP client persists the id and replays it via `session/load`, the adapter fetches its history from `/api/web/history?sessionId=<id>` (which doubles as the existence check), replays it, then registers the id in its local in-memory map for prompt / cancel routing.

This keeps the adapter stateless on disk — losing the in-memory map on restart is harmless because the conversation lives on the halo server, which is also where `session/list` reads from: the server enumerates the token's own `web_<accountId>_*` root sessions (sub-agent sessions and archived ones excluded). The list is prefix-scoped even for a `full` token — it answers "this token's conversations", not "everything in the workspace"; a full token can still `session/load` any id it already knows. Sessions minted by a browser client on the same token show up too (see the namespace-sharing note in [design/web.md](../design/web.md#post-apiwebsessions)).

Paging caveat: the cursor means "updated strictly before this millisecond", so two sessions with the same `updatedAt` straddling a page boundary can lose the second one. This is the shared session-list query's behaviour.

### Prompt turn lifecycle

- **Normal turn** — `POST /api/web/chat` streams until the terminal `complete` → `end_turn`.
- **Busy session** — halo answers `queued` (the message drains inside the run already in flight). The adapter follows that run via `/api/web/subscribe` to its terminal `complete`, then settles against history (below) so the drained reply is never lost → `end_turn`.
- **Dropped stream** (proxy idle timeout, network blip, server restart — the stream ended without `complete` and without a cancel) — re-attach via `/api/web/subscribe` with backoff 1 / 2 / 4 / 8 / 16 s. A re-attach that delivers frames resets the budget, so a long task survives repeated drops. Once a re-attached stream completes (or subscribe reports the session idle) the reply is **settled against history**: the reply logged for this prompt is compared with what was streamed — already complete → nothing; streamed text is a prefix → only the missing tail is sent; anything else (a gap mid-reply) → the whole reply again behind a `[reconnected — full reply]` marker, so the client never silently shows a reply with a hole in it. `MEDIA:` marker lines are stripped from the logged reply one line at a time, exactly as the server strips them from the stream, so a send-file reply doesn't trip the marker. The settle fetches only this turn's tail (`/api/web/history?since=<turn start − 5 min skew margin>`), not the whole log. After 5 failed attempts in a row: `[adapter error] connection lost`, `end_turn`. The re-attach and the settle follow the session id from the stream's `session` frame — a goal-bound session routes to `goal_<ts>`, which the server lets the token address because it is bound to the token's own session.
- **Chat request fails before its first event** (HTTP error, server unreachable) — `[adapter error] <message>`, `end_turn`; no reconnect (nothing to re-attach to).
- **Cancel** — `session/cancel` aborts the turn, fires `POST /api/web/stop` (not awaited) for the session actually running it (the id latched from the `session` frame — the goal session when routed, not the ACP id), and keeps reading the stream until halo's `complete`, so the interrupted tool rows and final text arrive **before** the `cancelled` response (ACP prompt-turn "Cancellation"). If no `complete` arrives within 5 s the HTTP stream is aborted and the prompt resolves `cancelled` anyway. A cancel during a reconnect backoff, or while the reply is being settled against history, resolves `cancelled` without waiting out the delay. Until the cancelled prompt resolves the session's slot is still held, so a new `session/prompt` sent inside that window (≤ 5 s) gets `-32600` — send it after the `cancelled` response.
- The server's 15 s SSE keepalive comment (`: keepalive`, see [design/web.md](../design/web.md#sse-keepalive)) keeps idle proxies from cutting a long tool call; the adapter's parser skips it.

## Halo SSE → ACP `session/update` mapping

| Halo event   | ACP notification                | Notes                                      |
|----------------|----------------------------------|--------------------------------------------|
| `session`      | (latched internally)             | First-frame echo of the resolved sessionId. Adapter records it as the session to re-attach to, settle against and stop (a goal-bound session routes elsewhere); not surfaced. |
| `stream` (assistant text) | `agent_message_chunk`        | Forwarded as `content: { type: 'text', text }`. |
| `thinking`     | `agent_thought_chunk`            | Same shape as message chunk.               |
| `tool_call`    | `tool_call` (status: in_progress) | `toolCallId` = the frame's `toolUseId` (the provider's tool_use id — stable across a re-attach and identical to what `session/load` replays); a server without the field, or an empty id (some OpenAI-compatible streams), gets a minted id. `title` = tool name + the first 80 chars of its `command` / `pattern` / `url` / `path` argument. `kind`: `file_read` → `read`; `file_write` / `file_edit` → `edit`; `shell_exec` → `execute`; `grep` / `glob` / `file_list` → `search`; `web_fetch` → `fetch`; anything else → `other`. The halo `toolInput` goes out as `rawInput`. No `locations`. |
| `tool_result`  | `tool_call_update` (status: completed) | Pairs by `toolUseId`, so interleaved calls complete correctly. Without an id it falls back to the most recent `tool_call` (whose `toolName`, when the frame has one, must match). A result with no matching call is sent as a self-contained `tool_call` + `tool_call_update`. The web channel truncates `result` to 500 chars. |
| `file`         | `agent_message_chunk: [file: …]` | The file lives on the server; without reverse fs we can only point at it textually. |
| `error`        | `agent_message_chunk: [error] …` then end | Ends the prompt response with `stopReason: 'end_turn'` (we treat agent errors as a normal end-of-turn for protocol purposes). |
| `queued`       | (none — follow via subscribe)    | Halo queued the message because the session is busy; the adapter follows the running session to its terminal `complete` (see "Prompt turn lifecycle"). |
| `complete`     | (none — resolves the prompt)     | Caller's `session/prompt` request resolves with `stopReason: 'end_turn'` (`cancelled` after a cancel). |
| `user`         | (dropped)                        | Halo echoes the prompt; surfacing it would just confuse the ACP client. |
| `switch`       | (dropped)                        | Internal slash-command bookkeeping; ACP adapter doesn't send slash commands. |
| `: keepalive` comment | (skipped)                 | Not a `data:` frame — the SSE parser ignores it. |
| anything else  | (dropped)                        | Forward compat with newer servers. |

### History replay (`session/load`)

Built from `/api/web/history` messages in log order (`src/acp-updates.ts` `replayUpdates`), using the same builders as the live stream so a tool call looks the same either way:

| History entry | Replayed as |
|---|---|
| user message | `user_message_chunk` |
| assistant `contentBlocks`, in order | `agent_thought_chunk` (thinking) / `tool_call` / `agent_message_chunk` (text) |
| assistant without `contentBlocks` (legacy layout) | its `toolCalls` first, then the text — the admin's rendering order for these files |
| deleted turns, sub-agent `taskId` rows, system rows (usage / context / notification / agent_start / agent_done), standalone `tool_call` / `tool_result` rows | skipped |

Each replayed `tool_call` is self-contained: `status: completed`, `toolCallId` = its `toolUseId` (fallback `replay-<msgId>-<j>`), `title` / `kind` as above, `rawInput`, plus `rawOutput` + `content` capped at 500 chars like the live frame. The standalone `tool_call` / `tool_result` log rows are skipped because they carry neither the output nor the `toolUseId` — the assistant message's blocks have both.

## Multi-workspace

A single web-channel token in halo is bound to one workspace at the database level. The adapter works around this by using the per-request `workspace` + `sessionId` overrides on `/api/web/*`:

- `/api/web/chat`, `/api/web/stop`, `/api/web/history`, `/api/web/subscribe` accept `workspace=<path>` and `sessionId=<id>` (query params, headers `x-workspace` / `x-session-id`, or POST body fields); `/api/web/sessions` accepts `workspace` and `agentId` the same way.
- Server gates the workspace override on `accessLevel === 'full'` — readonly / workspace tokens cannot escape their account-bound workspace.
- The adapter sends both fields on every request, so concurrent adapters on the same token but different `--workspace` flags don't step on each other.

Caveat: `/workspace switch <path>` slash commands still mutate the bound workspace at the *db* level (changing the account row's default). Avoid sending `/workspace switch` from an adapter — its side effects leak to all other clients of the same token. Use `--workspace` at adapter launch instead.

## Reverse fs (parked)

ACP optionally lets the agent (running on the server) request files from the client (the laptop on the user's side) via `fs/read_text_file` and `fs/write_text_file`. This solves the "agent on EC2 wants to look at `~/.zshrc` on my Mac" problem — the agent sends a request, the client reads its local fs, contents come back over JSON-RPC.

We don't implement this in v1. Two reasons:

1. The web channel is HTTP + SSE — a one-way stream. Reverse fs needs client-initiated requests in the agent → client direction. We'd have to either swap the wire to WebSocket or layer long-poll on top.
2. Halo agents currently use the `file_read` / `file_write` tools that operate on the *server's* workspace directly. To benefit from reverse fs we'd need a parallel tool (`client_file_read`?) and a way for the agent to know when to use which.

What works instead: a file the client attaches as an embedded `resource` (e.g. an editor @-mention) arrives inline in the prompt text, so the agent can read it — it just can't fetch or write back client-side files on its own. A `resource_link` reaches the agent only as a name + uri line.

## Implementation notes

Code is in `packages/acp-adapter/`:

- `src/jsonrpc.ts` — minimal newline-delimited JSON-RPC 2.0 peer over stdio. No LSP-style Content-Length framing — ACP uses one JSON object per line.
- `src/halo-client.ts` — wraps `POST|GET /api/web/sessions`, `POST /api/web/chat` (SSE), `GET /api/web/subscribe` (SSE), `POST /api/web/stop` and `GET /api/web/history`. Parses `data: <json>\n\n` frames into JS objects; non-`data:` lines (the keepalive comment) are skipped.
- `src/adapter.ts` — registers the ACP method handlers, owns the per-session state (`Map<sessionId, { workspace, turn? }>` — `sessionId` is shared with halo; `turn` holds the in-flight prompt's cancel / HTTP abort controllers, the latched halo session id, streamed text and tool-call pairing), runs the prompt turn lifecycle, translates SSE events to `session/update` notifications. The halo client is injectable (`AdapterDeps`) so `test/adapter.test.ts` drives it against a scripted fake.
- `src/acp-updates.ts` — pure halo → ACP builders shared by the live stream and `session/load` replay: `toolKind` / `toolTitle`, `replayUpdates`, `replyAfterPrompt` (the reply settled against after a reconnect).
- `src/version.ts` — `ADAPTER_VERSION` for `agentInfo`.
- `src/index.ts` — CLI argv parsing, wires stdin/stdout to a `JsonRpcConnection`, instantiates the adapter.

CLI integration is in `@turmind/halo-cli`'s `index.ts` `cmd === 'acp'` branch — it imports `@turmind/halo-acp-adapter` and forwards argv. The adapter does not gate on `~/.halo/global/` being initialized: it only talks to a remote server.

## Testing

`packages/acp-adapter/test/` holds the vitest suite (`pnpm --filter @turmind/halo-acp-adapter test`): JSON-RPC framing, SSE parsing, the version pin, and `adapter.test.ts` — contract tests that drive the adapter over in-memory stdio against a scripted fake halo client (initialize, cancel, load replay, list, prompt content blocks, tool-call pairing, reconnect / settle, busy session, unknown methods). A live server and model are only exercised by the manual smoke below. The cases below cover the protocol surface and the realistic end-to-end shape (ACP client → adapter → halo server → agent). When you change adapter / web-channel code, walk this list.

### Setup

Pre-conditions for every case below:

1. A halo server running locally on `localhost:9527` with at least one full-access web token. (The example token below is the one provisioned for the `sa-agent` workspace in this repo's dev env — substitute your own.)
2. The remote workspace exists and has at least a `default` agent with model creds configured.

```sh
# sanity check: server up
curl -fs http://localhost:9527/api/health  # expect 200

# the token + workspace this section uses
TOKEN=<your-web-channel-token>
WS=/home/ubuntu/sa-agent
```

### Layer 1 — adapter alone (raw stdio)

**1.1 initialize handshake (1 line in, 1 response out, exits cleanly)**

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | halo acp --host localhost --port 9527 --token "$TOKEN" --workspace "$WS"
```

Expect: stdout has one `{"jsonrpc":"2.0","id":1,"result":{...protocolVersion:1, loadSession:true, ...}}` line. Exit 0.

**1.2 single-prompt round trip**

Use `/tmp/acp-1.mjs`:

```js
import { spawn } from 'node:child_process'
const c = spawn('halo', ['acp','--host','localhost','--port','9527','--token',process.env.TOKEN,'--workspace',process.env.WS], { stdio: ['pipe','pipe','inherit'] })
let buf = ''; const pending = new Map(); let next = 1
c.stdout.setEncoding('utf-8').on('data', x => { buf+=x; for (let nl=buf.indexOf('\n'); nl!==-1; nl=buf.indexOf('\n')) { const l=buf.slice(0,nl).trim(); buf=buf.slice(nl+1); if(!l) continue; const m=JSON.parse(l); if('id' in m && (m.result!==undefined||m.error!==undefined)) pending.get(m.id)?.(m); else if (m.method==='session/update' && m.params.update.sessionUpdate==='agent_message_chunk') process.stdout.write(m.params.update.content.text||'') }})
const send = (method, params) => new Promise((res,rej)=>{ const id=next++; pending.set(id, m=>m.error?rej(new Error(m.error.message)):res(m.result)); c.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n') })
;(async()=>{ await send('initialize',{protocolVersion:1,clientCapabilities:{}}); const {sessionId}=await send('session/new',{}); const r=await send('session/prompt',{sessionId,prompt:[{type:'text',text:'回复一个字: ok'}]}); console.log('\n['+r.stopReason+']'); c.stdin.end() })()
```

Run: `TOKEN=$TOKEN WS=$WS node /tmp/acp-1.mjs` — expect `ok` printed then `[end_turn]`.

**1.3 session/load resume**

Save the sessionId from 1.2 (it shows in stderr too), reuse on a second invocation with a different prompt — agent should answer based on the prior turn's context. Negative test: pass a bogus id, expect a `-32602` rejection.

**1.4 concurrent multi-session**

Two `session/new` from the same adapter, two `session/prompt` fired with `Promise.all`, verify each reply arrives on its own sessionId in `session/update.params.sessionId` (no cross-bleed).

**1.5 cancel mid-stream**

Long prompt (`"count to 50 with commentary"`), `setTimeout(() => send('session/cancel',{sessionId}), 1500)`, expect the original prompt resolves with `stopReason: 'cancelled'`.

### Bisection guide

When something fails:

1. **1.x fails, raw curl to `/api/web/chat` works**: bug is in `halo acp` adapter (jsonrpc.ts / adapter.ts / halo-client.ts).
2. **raw curl fails too**: bug is in halo server (web/handler.ts / session-manager) or the remote workspace itself (model creds, agent.yaml, …).

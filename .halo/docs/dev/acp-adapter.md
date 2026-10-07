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

| Method              | Implemented? | Notes                                                                  |
|---------------------|--------------|------------------------------------------------------------------------|
| `initialize`        | ✅           | Declares `protocolVersion: 1`, `promptCapabilities: { image, embeddedContext }`, `loadSession: true`, no auth methods. |
| `authenticate`      | ✅ (no-op)   | Token already passed via launch flags; ACP-side auth has nothing to do. |
| `session/new`       | ✅           | Calls `POST /api/web/sessions`; the server mints `web_<accountId>_<ts>_<rand>` and creates the row immediately. The adapter registers the id locally. |
| `session/load`      | ✅           | Verifies the supplied id still exists on the halo server (via `/api/web/history` 404), then registers it locally. The ACP client persists ids itself — the adapter holds no on-disk state. |
| `session/prompt`    | ✅           | Forwards text + image content blocks to halo. Resource / embedded-context blocks log a stderr warning and are dropped (see "Reverse fs" below for why). |
| `session/cancel`    | ✅           | Aborts the in-flight HTTP/SSE stream and POSTs `/web/stop` server-side. |
| Reverse `fs/*`      | ❌           | See "Reverse fs" below.                                                |
| Reverse `terminal/*`| ❌           | Same reasoning as reverse fs.                                          |
| `requestPermission` | ❌           | Halo has its own access-level system at the channel-account level; we don't surface a second permission gate at ACP. |

### Session id model

ACP sessionId == halo sessionId. There's no extra mapping layer in the adapter: `session/new` asks the server for a fresh session (`POST /api/web/sessions`), which mints `web_<accountId>_<ts>_<rand>` inside the token's own namespace and creates the `agent_sessions` row on the spot — that exact string is what the ACP client gets back. The server has to be the one minting because readonly / workspace tokens can only address ids under their own `web_<accountId>_` prefix (`canAddressSession` in `packages/server/src/channels/web/handler.ts`); an adapter-chosen id would 403 on the first prompt. When the ACP client persists the id and replays it via `session/load`, the adapter just calls `/api/web/history?sessionId=<id>` to verify the row still exists, then registers it in its local in-memory map for prompt / cancel routing.

This keeps the adapter stateless on disk — losing the in-memory map on restart is harmless because the conversation lives on the halo server. **The ACP client is the source of truth for "which sessions are mine"**, which is the right shape: a Mac-side editor knows about *its* sessions, the EC2-side halo agent doesn't need to enumerate them.

## Halo SSE → ACP `session/update` mapping

| Halo event   | ACP notification                | Notes                                      |
|----------------|----------------------------------|--------------------------------------------|
| `session`      | (latched internally)             | First-frame echo of the resolved sessionId. Adapter records it; not surfaced. |
| `stream` (assistant text) | `agent_message_chunk`        | Forwarded as `content: { type: 'text', text }`. |
| `thinking`     | `agent_thought_chunk`            | Same shape as message chunk.               |
| `tool_call`    | `tool_call` (status: in_progress) | Adapter mints a stable `toolCallId`; the halo `toolInput` goes out as `rawInput`. `kind: 'other'` because halo doesn't categorize tools. |
| `tool_result`  | `tool_call_update` (status: completed) | Pairs by *order* with the most recent `tool_call` (the frame's `toolName`, when present, must match it). A result with no matching call is sent as a self-contained `tool_call` + `tool_call_update`. The web channel truncates `result` to 500 chars. |
| `file`         | `agent_message_chunk: [file: …]` | The file lives on the server; without reverse fs we can only point at it textually. |
| `error`        | `agent_message_chunk: [error] …` then end | Ends the prompt response with `stopReason: 'end_turn'` (we treat agent errors as a normal end-of-turn for protocol purposes). |
| `queued`       | `agent_message_chunk: [queued — session busy]` | Halo queues messages when the session is busy. Adapter ends the response. |
| `complete`     | (none — resolves the prompt)     | Caller's `session/prompt` request resolves with `stopReason: 'end_turn'`. |
| `user`         | (dropped)                        | Halo echoes the prompt; surfacing it would just confuse the ACP client. |
| `switch`       | (dropped)                        | Internal slash-command bookkeeping; ACP adapter doesn't send slash commands. |

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

For now: if the user wants the agent to see a Mac-side file, they paste it into the prompt. The adapter logs a stderr warning when it sees a `resource` content block in `session/prompt` so the failure mode is obvious.

## Implementation notes

Code is in `packages/acp-adapter/`:

- `src/jsonrpc.ts` — minimal newline-delimited JSON-RPC 2.0 peer over stdio. No LSP-style Content-Length framing — ACP uses one JSON object per line.
- `src/halo-client.ts` — wraps `POST /api/web/sessions`, `POST /api/web/chat` (SSE), `POST /api/web/stop` and `GET /api/web/history`. Parses `data: <json>\n\n` frames into JS objects.
- `src/adapter.ts` — registers the ACP method handlers, owns the per-session state (`Map<sessionId, { workspace, lastToolCall, promptAbort }>` — `sessionId` is shared with halo), translates SSE events to `session/update` notifications.
- `src/index.ts` — CLI argv parsing, wires stdin/stdout to a `JsonRpcConnection`, instantiates the adapter.

CLI integration is in `@turmind/halo-cli`'s `index.ts` `cmd === 'acp'` branch — it imports `@turmind/halo-acp-adapter` and forwards argv. The adapter does not gate on `~/.halo/global/` being initialized: it only talks to a remote server.

## Testing

`packages/acp-adapter/test/` holds vitest unit tests for the JSON-RPC framing and SSE parsing (`pnpm --filter @turmind/halo-acp-adapter test`); the adapter ↔ server flow has no automated suite and is verified by manual smoke. The cases below cover the protocol surface and the realistic end-to-end shape (ACP client → adapter → halo server → agent). When you change adapter / web-channel code, walk this list.

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

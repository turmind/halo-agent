# ACP Adapter

A stdio bridge that lets any [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) (ACP) client — most importantly Anthropic's Claude Code — drive a halo server as if it were a native ACP agent.

The adapter is **only a translator**: ACP JSON-RPC over stdin/stdout on one side, halo's existing web channel HTTP + SSE on the other. It does not run agents itself, store any state on disk, or duplicate halo's auth / access-level model. One token in, one workspace out, one halo server upstream.

## When to reach for it

Topology that motivated the adapter:

```
[Mac]                                    [EC2]
Claude Code                                  halo server (port 9527)
   │   ACP / JSON-RPC over stdio                │
   ▼                                            │
halo acp adapter ────HTTP/SSE────────────────▶│
                                                │
                                          halo agent
                                          (workspace files
                                           live on EC2)
```

Claude Code on a developer's laptop wants to talk to a halo agent running in an EC2 / shared dev box. ACP is the protocol; this adapter is what makes the JSON-RPC stream Claude Code emits look like halo's HTTP + SSE chat to the server. Adapter and Claude Code typically run on the same machine; the halo server sits behind whatever endpoint the developer configures.

## Quick start

1. Provision a web-channel token. Admin UI → Channels → Web → Create. Grab the token. **For multi-workspace use, pick `full` access level** — readonly / workspace tokens cannot override the workspace per request.

2. Launch the adapter from your ACP client. For Claude Code, register it as a custom agent (see Claude Code's docs for `claude-code config agent add`):

   ```sh
   halo acp \
     --host my-ec2-or-localhost \
     --port 9527 \
     --token <web-token-from-step-1> \
     --workspace /abs/path/on/server \
     --agent-id default        # optional; falls back to 'default'
   ```

3. The adapter writes JSON-RPC frames to stdout (1 message per line) and reads stdin the same way. Stderr is reserved for human-readable diagnostics — do not parse.

## The `acp` skill — direct asks + halo-to-halo bindings

The most common use of this adapter isn't a third-party ACP client — it's *another halo agent* calling out over ACP. Halo ships a builtin skill `acp` (slash command `/acp`, full access). Its bundled `templates/ask.py` is a unified ACP client; `--kind` picks the peer:

- `halo` (default) — spawns `halo acp --host --port --token --workspace` (this adapter) to reach a **remote halo server**
- `claude` — spawns `claude-agent-acp` (npm `@agentclientprotocol/claude-agent-acp`): local Claude Code, zero config, just `--cwd`
- `kiro` — spawns `kiro-cli acp --trust-all-tools`: local Kiro, zero config `--cwd`, optional `--agent-id`

Session reuse works the same for every kind: the first call prints `SESSION: <id>` on stdout, follow-ups pass `--session-id <id>`. For `claude` / `kiro`, `session/load` must carry `cwd` + `mcpServers` exactly like `session/new` (kiro-cli exits silently without them) — ask.py fills these in.

The question text reaches the peer **verbatim — including the peer's own slash commands**. Verified with kiro: `/model` as the question lists its available models; `/model <full-model-id>` switches its model and saves it as default (full id only — fuzzy names like `claude` are rejected). Use this to drive a peer's built-in command set.

`/acp` verbs:

- `kiro <question>` / `claude <question>` — ask the local agent directly; no setup or binding needed
- `add` / `list` / `remove` — manage generated `ask-<label>` binding skills (below)

### `ask-*` bindings — the multi-remote-halo path

Remote halo servers are **not** a direct verb: each remote needs its own host/token/workspace, so `/acp add` walks the user through (label, host, port, workspace, token), then **stamps out a new skill** named `ask-<label>` containing:

- `SKILL.md` — slash command `/ask-<label>`, instructions tailored to this remote
- `config.yaml` — declares the binding's params so admin Settings shows a form
- `ask.py` — bundled JSON-RPC ↔ stdio helper (one copy per binding, intentional — keeps `/ws share` bundles self-contained)
- writes the connection values into `settings.yaml` (workspace or global, user picks)

After install, the local agent can simply do `shell_exec: python3 .../ask-<label>/ask.py "<question>" --host {{params.host}} ...` and halo's runtime substitutes the configured values. **Multiple bindings coexist** — each gets its own slash command, settings namespace, and Admin Settings page.

Implementation: `~/.halo/global/skills/acp/`. Templates live under `templates/`. `/acp add` is the **only** supported way to set up a binding — there's no generic single-target `ask-acp-agent` skill, because per-binding namespaces (one token-host-workspace triple per skill id) are required for multi-remote use.

To remove a binding: `/acp remove` (deletes the skill directory and points out the leftover `ask-<label>:` block in `settings.yaml`).

## CLI flags

| Flag             | Required | Notes                                                                                    |
|------------------|----------|------------------------------------------------------------------------------------------|
| `--host`         | yes      | Halo server hostname / IP (e.g. `localhost`, `ec2-1-2-3-4.compute…`).                  |
| `--port`         | yes      | Halo server port (e.g. `9527`).                                                        |
| `--token`        | yes      | Web-channel token from admin UI. `full` access required for multi-workspace use.         |
| `--workspace`    | yes      | Absolute server-side path for the workspace this adapter drives.                         |
| `--agent-id`     | no       | Halo agent profile to use when ACP `session/new` creates a new halo session. Default: `default`. |

One adapter process binds to one workspace. To drive multiple workspaces concurrently from the same token, run multiple adapter processes — see "Multi-workspace" below.

## ACP method coverage

| Method              | Implemented? | Notes                                                                  |
|---------------------|--------------|------------------------------------------------------------------------|
| `initialize`        | ✅           | Declares `protocolVersion: 1`, `promptCapabilities: { image, embeddedContext }`, `loadSession: true`, no auth methods. |
| `authenticate`      | ✅ (no-op)   | Token already passed via launch flags; ACP-side auth has nothing to do. |
| `session/new`       | ✅           | Mints a session id (shape `web_acp_<ts>_<rand>`) and registers it locally. Halo creates the row lazily on the first `/web/chat` with that id. |
| `session/load`      | ✅           | Verifies the supplied id still exists on the halo server (via `/api/web/history` 404), then registers it locally. The ACP client persists ids itself — the adapter holds no on-disk state. |
| `session/prompt`    | ✅           | Forwards text + image content blocks to halo. Resource / embedded-context blocks log a stderr warning and are dropped (see "Reverse fs" below for why). |
| `session/cancel`    | ✅           | Aborts the in-flight HTTP/SSE stream and POSTs `/web/stop` server-side. |
| Reverse `fs/*`      | ❌           | See "Reverse fs" below.                                                |
| Reverse `terminal/*`| ❌           | Same reasoning as reverse fs.                                          |
| `requestPermission` | ❌           | Halo has its own access-level system at the channel-account level; we don't surface a second permission gate at ACP. |

### Session id model

ACP sessionId == halo sessionId. There's no extra mapping layer in the adapter: when `session/new` mints `web_acp_<ts>_<rand>`, that exact string IS the row in `agent_sessions` (created lazily on first `/web/chat`). When the ACP client persists the id and replays it via `session/load`, the adapter just calls `/api/web/history?sessionId=<id>` to verify the row still exists, then registers it in its local in-memory map for prompt / cancel routing.

This keeps the adapter stateless on disk — losing the in-memory map on restart is harmless because the conversation lives on the halo server. **The ACP client is the source of truth for "which sessions are mine"**, which is the right shape: a Mac-side Claude Code knows about *its* sessions, the EC2-side halo agent doesn't need to enumerate them.

## Halo SSE → ACP `session/update` mapping

| Halo event   | ACP notification                | Notes                                      |
|----------------|----------------------------------|--------------------------------------------|
| `session`      | (latched internally)             | First-frame echo of the resolved sessionId. Adapter records it; not surfaced. |
| `stream` (assistant text) | `agent_message_chunk`        | Forwarded as `content: { type: 'text', text }`. |
| `thinking`     | `agent_thought_chunk`            | Same shape as message chunk.               |
| `tool_call`    | `tool_call` (status: in_progress) | Adapter mints a stable `toolCallId`. `kind: 'other'` because halo doesn't categorize tools. |
| `tool_result`  | `tool_call_update` (status: completed) | Pairs by *order* with the most recent `tool_call` — halo's `tool_result` event doesn't carry the tool name, but it's emitted in lockstep with its call. |
| `file`         | `agent_message_chunk: [file: …]` | The file lives on the server; without reverse fs we can only point at it textually. |
| `error`        | `agent_message_chunk: [error] …` then end | Ends the prompt response with `stopReason: 'end_turn'` (we treat agent errors as a normal end-of-turn for protocol purposes). |
| `queued`       | `agent_message_chunk: [queued — session busy]` | Halo queues messages when the session is busy. Adapter ends the response. |
| `complete`     | (none — resolves the prompt)     | Caller's `session/prompt` request resolves with `stopReason: 'end_turn'`. |
| `user`         | (dropped)                        | Halo echoes the prompt; surfacing it would just confuse the ACP client. |
| `switch`       | (dropped)                        | Internal slash-command bookkeeping; ACP adapter doesn't send slash commands. |

## Multi-workspace

A single web-channel token in halo is bound to one workspace at the database level. The adapter works around this by using the per-request `workspace` + `sessionId` overrides on `/api/web/*`:

- `/api/web/chat`, `/api/web/stop`, `/api/web/history`, `/api/web/subscribe` accept `workspace=<path>` and `sessionId=<id>` (query params, headers `x-workspace` / `x-session-id`, or POST body fields).
- Server gates the workspace override on `accessLevel === 'full'` — readonly / workspace tokens cannot escape their account-bound workspace.
- The adapter sends both fields on every request, so concurrent adapters on the same token but different `--workspace` flags don't step on each other.

Caveat: `/ws switch <path>` slash commands still mutate the bound workspace at the *db* level (changing the account row's default). Avoid sending `/ws switch` from an adapter — its side effects leak to all other clients of the same token. Use `--workspace` at adapter launch instead.

## Reverse fs (parked)

ACP optionally lets the agent (running on the server) request files from the client (the laptop on the user's side) via `fs/read_text_file` and `fs/write_text_file`. This solves the "agent on EC2 wants to look at `~/.zshrc` on my Mac" problem — the agent sends a request, the client reads its local fs, contents come back over JSON-RPC.

We don't implement this in v1. Two reasons:

1. The web channel is HTTP + SSE — a one-way stream. Reverse fs needs client-initiated requests in the agent → client direction. We'd have to either swap the wire to WebSocket or layer long-poll on top.
2. Halo agents currently use the `file_read` / `file_write` tools that operate on the *server's* workspace directly. To benefit from reverse fs we'd need a parallel tool (`client_file_read`?) and a way for the agent to know when to use which.

For now: if the user wants the agent to see a Mac-side file, they paste it into the prompt. The adapter logs a stderr warning when it sees a `resource` content block in `session/prompt` so the failure mode is obvious.

## Implementation notes

Code is in `packages/acp-adapter/`:

- `src/jsonrpc.ts` — minimal newline-delimited JSON-RPC 2.0 peer over stdio. No LSP-style Content-Length framing — ACP uses one JSON object per line.
- `src/halo-client.ts` — wraps `POST /api/web/chat` (SSE), `POST /api/web/stop`. Parses `data: <json>\n\n` frames into JS objects.
- `src/adapter.ts` — registers the ACP method handlers, owns the per-session state (`Map<sessionId, { workspace, lastToolCall, promptAbort }>` — `sessionId` is shared with halo), translates SSE events to `session/update` notifications.
- `src/index.ts` — CLI argv parsing, wires stdin/stdout to a `JsonRpcConnection`, instantiates the adapter.

CLI integration is in `@turmind/halo-cli`'s `index.ts` `cmd === 'acp'` branch — it imports `@turmind/halo-acp-adapter` and forwards argv. The adapter does not gate on `~/.halo/global/` being initialized: it only talks to a remote server.

## Testing

No automated suite yet — verification is by manual smoke. The cases below cover the protocol surface and the realistic end-to-end shape (Claude Code → ACP adapter → halo server → remote agent). When you change adapter / web-channel / settings code, walk this list.

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

Use these to bisect: if the adapter works here but the skill flow fails, the bug is in the skill / shell_exec substitution, not the adapter.

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

### Layer 2 — generated binding skill (helper script + settings)

Each `/acp add` run produces a binding under `<scope>/skills/ask-<label>/`. These tests assume one binding `ask-sa-agent` already exists with the workspace-scope settings populated. Use a different `<label>` if you've changed the example.

**2.1 minimal helper invocation**

```sh
cd /home/ubuntu/halo-test
python3 .halo/skills/ask-sa-agent/ask.py \
  "本月 EC2 总花费一句话告诉我" \
  --host localhost --port 9527 --token "$TOKEN" --workspace "$WS"
```

Expect stdout:

```
SESSION: web_acp_<ts>_<rand>
---
本月（2026-05…）EC2 总花费 约 $1,846 …
```

**2.2 helper with `--agent-id ""` (empty literal — should be ignored)**

```sh
python3 .halo/skills/ask-sa-agent/ask.py "ping" \
  --host localhost --port 9527 --token "$TOKEN" --workspace "$WS" --agent-id ""
```

Expect: works the same as 2.1 (uses remote `default` agent). Regression guard for the bug where an unset yaml `agent_id: ""` got passed through and crashed remote `createSession`.

**2.3 helper with `--agent-id '{{params.agent_id}}'` (unsubstituted literal)**

```sh
python3 .halo/skills/ask-sa-agent/ask.py "ping" \
  --host localhost --port 9527 --token "$TOKEN" --workspace "$WS" \
  --agent-id "{{ask-sa-agent.params.agent_id}}"
```

Expect: same as 2.1. Regression guard for the case where `settings.yaml` doesn't have `agent_id` at all — `ask.py` detects the `{{…}}` shape and drops the flag.

### Layer 3 — agent calls the binding via halo cli

Tests the full chain: agent → `activate_skill` → `shell_exec` → ask.py → adapter → server → remote agent → reply.

**3.1 explicit slash command**

```sh
cd /home/ubuntu/halo-test
halo cli -a default -n -w /home/ubuntu/halo-test \
  "/ask-sa-agent 一句话告诉我这个月 EC2 总花费"
```

Expect: agent activates the binding, runs `ask.py` once with all params populated from settings.yaml, replies with "我问了 SA Agent…本月 EC2 总花费 约 $1,846…".

**3.2 implicit binding selection (agent picks on its own)**

```sh
halo cli -a default -n -w /home/ubuntu/halo-test \
  "帮我问下 sa-agent 这个月 RDS 花了多少钱"
```

Expect: agent recognises "ask sa-agent" as a delegation cue, picks `ask-sa-agent` without being told. (Softer test — model behaviour, not protocol; failure usually means the binding's SKILL.md description needs sharpening for the model.)

**3.3 multi-turn with session resume**

In the same CLI session, send three messages in order:

```
让 sa-agent 拉一下本月 AWS top 10 service 费用
让它把 Bedrock 那部分按模型拆细
再问 us-east-1 跟 ap-northeast-1 的分布
```

Expect: agent saves the `SESSION:` id from message 1, passes `--session-id <id>` on messages 2/3. Remote sa-agent's responses build on the previous turn (no "what AWS account?" re-prompts).

### Layer 4 — generator (`/acp add`)

Tests that a fresh binding can be stamped out from scratch.

**4.1 generate a binding**

From a clean state (no `<workspace>/.halo/skills/ask-foo/`):

```sh
halo cli -a default -n -w /home/ubuntu/halo-test \
  '/acp add 参数：label=foo，host=localhost，port=9527，workspace=/home/ubuntu/sa-agent，token=<token>，scope=workspace。不要问后续问题，全自动创建。'
```

Expect: agent creates `.halo/skills/ask-foo/{SKILL.md,config.yaml,ask.py}`, writes `ask-foo` block to `<workspace>/.halo/settings.yaml` with **all 5 user values** (host/port/workspace/label/token), wires the binding into the current agent's skills list. Reply confirms the four paths.

**4.2 invoke the freshly-generated binding**

```sh
halo cli -a default -n -w /home/ubuntu/halo-test \
  '/ask-foo 给我一句话: 这个月 EC2 总花费'
```

Expect: real reply (not a 401 / "token not configured"). If 401, settings.yaml didn't get all 5 values written (regression on Step 4 of the meta-skill).

**4.3 cleanup**

```sh
rm -rf /home/ubuntu/halo-test/.halo/skills/ask-foo
# manually remove `ask-foo:` block from /home/ubuntu/halo-test/.halo/settings.yaml
```

### Layer 5 — admin Settings UI

Open admin → Settings → Skills → **Ask SA Agent** (or whichever binding):

**5.1** All 6 fields render: `host`, `port`, `workspace`, `label`, `agent_id`, `token` (with mask icon).

**5.2** Each field's source label says **workspace** (not "继承自 global"), because values live in `<halo-test>/.halo/settings.yaml`.

**5.3** Edit `label` (e.g. → "我的 SA 助手"), save, run a 3.1-style query — agent's reply preamble should use the new label.

### Bisection guide

When something fails:

1. **3.x fails, 2.x works**: bug is in the agent's command construction (SKILL.md prompts) or shell_exec substitution. Look at the actual `tool_call.input` in the session JSON — placeholder text `{{…}}` leaking into the cmd is the typical sign.
2. **2.x fails, 1.x works**: bug is in `ask.py` (helper) or how params reach it.
3. **1.x fails, raw curl to `/api/web/chat` works**: bug is in `halo acp` adapter (jsonrpc.ts / adapter.ts / halo-client.ts).
4. **raw curl fails too**: bug is in halo server (web/handler.ts / session-manager) or the remote workspace itself (model creds, agent.yaml, …).

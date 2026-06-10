# ACP (Agent Client Protocol)

Drive a halo server from any [ACP](https://github.com/zed-industries/agent-client-protocol)-speaking client. The most common use is **Claude Code on a developer's laptop, talking to a halo agent on EC2** — but any ACP client works.

ACP isn't a channel of its own. The `halo acp` command is a **stdio bridge** that translates ACP JSON-RPC into the Web channel's HTTP+SSE. So setup = "create a Web account, then point an adapter at it."

## When to reach for it

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

Use ACP when:
- You want to use Claude Code locally as the chat UI but the agent's tools / workspace live on a remote machine
- You want one halo server to delegate to **another** halo server on a different host (the `/acp add` flow below)
- You're integrating with any tool that already speaks ACP

If you just want a browser UI, use the [Web](web.md) channel directly — ACP is overkill.

## Step 1 — Provision a Web token

ACP rides on the Web channel. Follow [Web channel onboarding](web.md) Steps 1-2 to get a token. **Pick `full` access** if you need multi-workspace support — `readonly` and `workspace` tokens can't override the workspace per request, so each adapter is locked to one workspace.

Save:
- **Token** (the `…` from Web admin)
- **Server host + port** (e.g. `localhost:9527`, or `ec2-1-2-3-4.compute.amazonaws.com:9527`)
- **Workspace path** on the server (absolute, e.g. `/home/ubuntu/my-project`)

## Step 2 — Launch the adapter from your ACP client

The adapter is published as the `halo acp` subcommand in `@turmind/halo` (the same npm package that ships `halo server`).

```sh
halo acp \
  --host my-ec2-or-localhost \
  --port 9527 \
  --token <web-token-from-step-1> \
  --workspace /abs/path/on/server \
  --agent-id default        # optional; defaults to 'default'
```

| Flag | Required | Notes |
|---|---|---|
| `--host` | yes | Halo server hostname / IP |
| `--port` | yes | Halo server port |
| `--token` | yes | Web-channel token. `full` access required for multi-workspace use |
| `--workspace` | yes | Absolute server-side path for this adapter |
| `--agent-id` | no | Halo agent profile to use when ACP `session/new` creates a fresh session. Default `default` |

Each adapter process binds to **one** workspace. To drive multiple workspaces concurrently from one token, run multiple adapter processes — one per workspace.

The adapter reads/writes JSON-RPC frames on **stdin / stdout** (one message per line, no LSP-style framing). **Stderr** is reserved for human-readable diagnostics — never parse it.

### Wiring into Claude Code

Claude Code lets you register a custom agent. Use its `claude-code config agent add` command (see Claude Code's own docs for the exact incantation) and point it at the `halo acp …` invocation above.

After registration, you can launch a session in Claude Code that streams to the remote halo server transparently — Claude Code thinks it's talking to a local agent, halo thinks it's talking to a Web-channel client.

## Step 3 — (Halo-to-halo) bind a remote with `/acp add`

The most common use of this adapter isn't a third-party ACP client — it's **another halo agent** delegating out to a remote halo workspace. Halo ships a builtin `acp` skill for this (slash command `/acp`, full access). Type `/acp add` — or just ask in chat (e.g. "add an ACP binding to my other halo").

It walks you through `(label, host, port, workspace, token)` and **stamps out a new skill** named `ask-<label>` containing:

- `SKILL.md` — slash command `/ask-<label>`, instructions tailored to this remote
- `config.yaml` — declares the binding's params so admin Settings shows a form
- `ask.py` — bundled JSON-RPC ↔ stdio helper (one copy per binding, intentional — keeps `/ws share` bundles self-contained)

It also writes the connection values into `settings.yaml` (workspace or global, you pick).

After install, the local agent can do `shell_exec: python3 .../ask-<label>/ask.py "<question>"` and halo's runtime substitutes the configured values. **Multiple bindings coexist** — each gets its own slash command, settings namespace, and Admin Settings page. `/acp list` shows the bindings you've generated.

To remove a binding: `/acp remove` (deletes the skill directory and points out the leftover `ask-<label>:` block in `settings.yaml`).

This is the **only** supported way to set up a halo-to-halo binding — there's no generic single-target `ask-acp-agent` skill, because per-binding namespaces (one token-host-workspace triple per skill id) are required for multi-remote use.

### Direct asks — `/acp kiro` / `/acp claude`

Bindings are for **remote halo servers**. For agents on the **same machine** no binding is needed — the `acp` skill talks to them directly, zero config:

- `/acp claude <question>` — local Claude Code (via npm `@agentclientprotocol/claude-agent-acp`)
- `/acp kiro <question>` — local Kiro (via `kiro-cli acp`)

The question is passed verbatim — including the other agent's own slash commands (e.g. `/acp kiro /model <full-model-id>` switches Kiro's model). Both coexist with `/ask-<label>` bindings.

## ACP method coverage

| Method | Implemented | Notes |
|---|---|---|
| `initialize` | ✅ | Declares `protocolVersion: 1`, `loadSession: true`, no auth methods |
| `authenticate` | ✅ (no-op) | Token is passed via launch flags; ACP-side auth has nothing to do |
| `session/new` | ✅ | Mints a sessionId of shape `web_acp_<ts>_<rand>`. Halo creates the row lazily on first `/web/chat` |
| `session/load` | ✅ | Verifies the supplied id still exists on the halo server, then registers it locally |
| `session/prompt` | ✅ | Forwards text + image content blocks. Resource / embedded-context blocks log a stderr warning and are dropped (see "Reverse fs" below) |
| `session/cancel` | ✅ | Aborts the in-flight HTTP/SSE stream and POSTs `/web/stop` |
| Reverse `fs/*` | ❌ | See "Reverse fs" below |
| Reverse `terminal/*` | ❌ | Same reasoning |
| `requestPermission` | ❌ | Halo has its own access-level system at the channel-account level |

### Session id model

ACP `sessionId` **is** the halo session id — there's no extra mapping layer. When `session/new` mints `web_acp_<ts>_<rand>`, that exact string is what gets created in `agent_sessions` (lazily on first `/web/chat`). The ACP client persists ids itself; the adapter holds no on-disk state. Losing the adapter's in-memory map on restart is harmless because the conversation lives on the halo server.

The ACP client is the source of truth for "which sessions are mine" — a Mac-side Claude Code knows about *its* sessions, the EC2-side halo agent doesn't need to enumerate them.

## Multi-workspace

A Web-channel token in halo is bound to one workspace at the database level. The adapter works around this by sending `workspace` + `sessionId` overrides on every Web-channel call:

- `/api/web/chat`, `/api/web/stop`, `/api/web/history`, `/api/web/subscribe` accept `workspace=<path>` and `sessionId=<id>` overrides
- The server gates the `workspace` override on `accessLevel === 'full'` — readonly / workspace tokens cannot escape their bound workspace
- The adapter sends both fields on every request, so concurrent adapters on the same token but different `--workspace` flags don't step on each other

**Caveat:** sending `/ws switch <path>` from inside an ACP session still mutates the bound workspace at the **db level** (changing the account's default for everybody using that token). Avoid `/ws switch` from an adapter — use `--workspace` at adapter launch instead.

## Reverse fs (parked)

ACP optionally lets the agent (running on the server) request files from the client (the laptop on the user's side) via `fs/read_text_file` and `fs/write_text_file`. We don't implement this in v1 because:

1. The Web channel is HTTP + SSE — a one-way stream. Reverse fs would need WebSocket or long-poll
2. Halo agents currently use `file_read` / `file_write` against the **server's** workspace; supporting reverse fs would need a parallel toolset

For now: if you want the agent to see a Mac-side file, paste it into the prompt. The adapter logs a stderr warning when it sees a `resource` content block in `session/prompt`, so the failure mode is obvious.

## Common problems

| Symptom | Cause / fix |
|---|---|
| Adapter exits immediately on launch | Missing required flag, or the token / host are wrong. Check stderr |
| `401` on first prompt | Token typo, or token was deleted from admin |
| `403` when launching with `--workspace /some/other/path` | Token is `readonly` / `workspace` access — use a `full` token or omit `--workspace` |
| Tool calls don't appear in Claude Code | Expected — halo doesn't translate every event back as ACP `tool_call`. See [docs/dev/acp-adapter.md](../../dev/acp-adapter.md) for the full mapping |
| Two `session/prompt` calls on the same id, second hangs | Halo queues messages when a session is busy; ACP adapter ends the response with `[queued]`. Wait for the first to finish |
| `/ws switch <path>` worked but other tokens broke | You changed the db-level default. Switch back with another `/ws switch`, or stop using slash commands from the adapter |

## Reference

- CLI source: `packages/acp-adapter/src/index.ts`
- Adapter source: `packages/acp-adapter/src/adapter.ts`, `halo-client.ts`, `jsonrpc.ts`
- Full design + protocol mapping: [../../dev/acp-adapter.md](../../dev/acp-adapter.md) — read this before changing the wire format
- Web channel: [web.md](web.md) — the underlying transport

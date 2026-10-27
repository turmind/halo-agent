# Linked machines (`halo node`)

> User guide: [guide/node.md](../guide/node.md). Tool reference: [dev/tools.md → Node tools](../dev/tools.md#node-tools). API: [dev/api.md → Linked machines](../dev/api.md#linked-machines-halo-node). Code: `packages/server/src/nodes/` (wired in `index.ts`, `session-agent-builder.ts`, `cron/runner.ts`), CLI `packages/cli/src/index.ts` (`cmdNode`), admin `features/nodes/`.

## Problem

The server's agents work on the server's filesystem. Users also want them to touch files on *their own* machine — a laptop or a box behind NAT the server can't reach. `halo node` is a small outbound client: it dials the server over WebSocket, and the workspace's full-access agents get `node_*` tools that run the local file tools (and, opt-in, `shell_exec`) **on that machine**. No inbound port, no model keys, no `halo setup` on the machine.

## Pieces

| Piece | File | Role |
|---|---|---|
| Accounts | `nodes/accounts.ts` | Pairing tokens in `~/.halo/secrets/channels/channels.db` `channel_accounts` (`channel_type='node'`, `label` = machine name, `config` = `{ token }`, `access_level` = `'full'`). Name `^[a-z0-9][a-z0-9-]{0,31}$`, unique per workspace (realpath compare) → 409 |
| Hub | `nodes/hub.ts` | Server side. `noServer` `WebSocketServer` on `/api/nodes/connect`; one live connection per account; request/response correlation, timeouts, cancel, heartbeat; `nodes:changed` broadcast. Process singleton via `setNodeHub` / `getNodeHub` |
| Tools | `nodes/tools.ts` | `buildNodeTools(workspaceRoot)` → the fixed 8 tools. Dispatch: hub (in-process) → loopback relay (cron child) → `NODES_UNAVAILABLE` |
| Routes | `nodes/routes.ts` | Admin CRUD (`/api/nodes/accounts`) + the cron relay (`POST /api/nodes/call`) |
| Client | `nodes/node-client.ts` | `runNode()` — the `halo node` process: connect, reconnect with backoff, execute requests |
| Executor | `nodes/node-exec.ts` + `node-path.ts` | Machine side. Wraps the **same** `createWorkspaceTools(base, { accessLevel: 'full' })` the server's agents use; adds the root check |

Not built in AgentCore mode (`nodeHub = AGENTCORE ? null : …`), the CLI / TUI or the evo sandbox — there the tools exist but return `NODES_UNAVAILABLE`.

## Two modes

- **Folder mode** (`--root <dir>`): `root` is realpath'd at start. Every path argument and node_run's `cwd` must resolve inside it, else the call is refused before any I/O (`"<p>" is outside this machine's shared folder (<root>) — …`; machine log `[Node] refused <op> <path>: outside root`). Relative paths resolve against `root`.
- **Whole-machine mode** (no `--root`, or `--root /`): no prefix check — the same reach as a full-access local session, i.e. whatever the machine user can access. Relative paths and node_run's default cwd resolve against `base` = the directory `halo node` was started in. A startup line says so. `node_list` reports the machine as `root: null, wholeMachine: true, base: "<dir>"`; the admin row shows "Whole machine".

`--allow-shell` is independent of the mode and off by default. Commands run **unsandboxed** as the machine user — in folder mode only their `cwd` is held inside `root`, the command itself can reach anything (v1 accepted trade-off; the startup warning and the guide say so). `{{ns.params.x}}` placeholders are never substituted on the machine (empty namespace set), so no settings secret reaches a command.

### Path check (`resolveInRoot`)

Resolve against root, then walk up with **`lstat`** to the longest existing prefix, `realpath` it, re-append the missing tail, and test containment with `path.relative` (so `/x/root-other` is not inside `/x/root`; drive letters compare right on Windows). `lstat`, not `existsSync`: `existsSync` follows a dangling symlink and reports it missing, so `root/link → /outside/new` would stay unresolved, pass the prefix test, and the write would follow the link out of root. With `lstat` the link is found, its `realpath` fails, and the call is refused. A narrow TOCTOU window (a component swapped for a symlink between check and syscall) remains — same as the local tools.

When the checked path equals the plain resolution, the agent's own string is passed through, so results read exactly like the local tool's (`File written: notes/a.md`).

## Protocol (v1)

**Handshake** — `GET /api/nodes/connect`, upgrade, headers:

| Header | Value |
|---|---|
| `authorization` | `Bearer <token>` |
| `x-halo-node-protocol` | `1` |
| `x-halo-node-instance` | random uuid per process start |
| `x-halo-node-info` | base64url JSON `{ root \| null, base, shell, shellTimeoutMs, os, hostname, version }` |
| any `--header` | passed through (auth proxies) |

`verifyClient` answers in this order: **429** IP locked out (`middleware/brute-force.ts`, own `node-token` bucket: 5 bad tokens in 15 min) → **426** protocol mismatch → **401** unknown token (recorded as a failure) → **404** bound workspace gone → **400** info / instance missing or malformed → **409** account already connected from a *different* instance. The path is in no auth middleware; the token is the auth.

**Frames** (JSON text, ≤ `MAX_FRAME_BYTES` = 8 MiB both ways):

```
server → node  { t: 'welcome', name, workspace }
server → node  { t: 'req', id, op, args }        op ∈ read write edit list grep glob run
server → node  { t: 'cancel', id }
node → server  { t: 'res', id, ok: true, text } | { t: 'res', id, ok: false, error }
```

`args` are the local tool's input minus `node` (node_run: `{ command, cwd }`). Results longer than `NODE_RESULT_MAX_CHARS` (256K) are cut on the machine with `[Content truncated on the machine: N chars total]`; the agent loop's own caps (8000 to the LLM, 64K to the UI) then apply as for any local tool. A request over 8 MiB is refused before sending.

**Close codes**: `4001` token revoked (DELETE in admin) → node exits 1. `4009` replaced: a reconnect from the **same** instance supersedes the old socket (half-open link recovery); a **different** instance is refused (`409` at handshake, or `4009 already connected from another process` if it raced) and keeps retrying with backoff — so starting a second `halo node` with the same token never kicks the first. `1001` server shutting down → reconnect.

**Liveness**: server pings every 20 s and terminates after 2 missed pongs; the node's watchdog terminates after 60 s without any traffic. Either side dropping fails all in-flight calls.

**Timeouts**: node_run waits `shellTimeoutMs + 15 s` (the machine's own shell timeout — `HALO_SHELL_TIMEOUT` in ms, default 120 s — kills the command first; `node_list` shows it as `shellTimeoutSec`); every other op 120 s. On timeout or session abort the hub sends `cancel`; the node aborts the call (shell: process group SIGTERM → SIGKILL).

**Reconnect** (node): backoff 1 s doubling to 30 s, ±20 % jitter, reset on `welcome`; 10 s handshake timeout. Fatal (exit 1): 401, 404, 426, close 4001. 409 retries with backoff; 429 waits ≥ 60 s.

## Disconnect semantics

Results are never replayed. When the link drops mid-call:

- server side: each pending call rejects with `machine "<n>" went offline during the call (connection lost). The operation may or may not have completed on the machine — check its state before retrying.`
- machine side: every running call is aborted (child processes killed) and the log reads `connection lost (…) — stopped N running call(s); reconnecting in Xs`.

Offline vs unknown are distinct errors: `machine "<n>" is offline (…). Do not retry in a loop — tell the user to start it.` vs `unknown machine "<n>" — machines linked to this workspace: a, b (see node_list)`.

## Cron relay

A cron run is a `halo cli` child — no hub in that process. `cron/runner.ts` spawns it with `{ ...cleanChildEnv(), ...getNodeHub()?.relayEnv() }`:

- `HALO_NODE_RELAY_URL` = `http://127.0.0.1:<port>/api/nodes/call`
- `HALO_NODE_RELAY_TOKEN` = a 32-byte hex secret generated per server boot (never persisted)

The child's node tools POST `{ workspace, node, op, args }` there (`op: 'nodes'` = node_list) with header `x-halo-node-relay`. The route is in `PUBLIC_PATHS` and gated by loopback source **and** a `timingSafeEqual` match on the secret — the secret is the real gate (a same-host reverse proxy is loopback too). `child-env.ts` strips `HALO_NODE_RELAY_URL` / `HALO_NODE_RELAY_TOKEN` / `HALO_NODE_TOKEN` from every other child (shell_exec, MCP, …), so neither leaks into agent commands.

## Prompt-cache invariant

The tool list is decided **only** by `agent.yaml`: `node_list` in `tools:` + a full-access session (`accessLevel === null`) → all 8 tools; otherwise none. `buildNodeTools` returns constant names / descriptions / schemas — it reads no hub, db, env or machine list. Machines coming and going therefore never change the tools block or the system prompt, and the prompt cache survives. Online state reaches the model only as the **result** of `node_list` (and in errors). Pinned by `session-agent-builder.test.ts` (tools JSON + system prompt byte-identical with 0 and 2 machines online). See [memory/2026-10-27-node-prompt-cache.md](../../memory/2026-10-27-node-prompt-cache.md).

Cost: the 8 descriptions measure ≈ 460 tokens (Claude CountTokens); with schemas the set adds ≈ 1.6K tokens per request for agents that opt in.

## Admin

`features/nodes/` adds **Channels → Linked machines** (after Web): a row per token with online dot, name, workspace, `root | Whole machine · shell on/off · os`, token copy and delete. The add dialog takes workspace + name and shows a ready-to-copy `halo node --server <origin> --token <t> --root <folder>`. Online state comes from the list response, then `nodes:changed` (full snapshot, global broadcast — the channels page is a global view); a WS reconnect re-fetches the list. No polling.

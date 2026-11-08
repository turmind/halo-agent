# Linked machines (`halo-node`)

> User guide: [guide/node.md](../guide/node.md). Tool reference: [dev/tools.md → Node tools](../dev/tools.md#node-tools). API: [dev/api.md → Linked machines](../dev/api.md#linked-machines-halo-node). Code: `packages/server/src/nodes/` (wired in `index.ts`, `session-agent-builder.ts`), machine client `packages/node-go/`, admin `features/nodes/`.

## Problem

The server's agents work on the server's filesystem. Users also want them to touch files on *their own* machine — a laptop or a box behind NAT the server can't reach. `halo-node` is a small outbound client: it dials the server over WebSocket, and the workspace's full-access agents get `node_*` tools that run the local file tools (and, opt-in, `shell_exec`) **on that machine**. No inbound port, no model keys, no `halo setup` on the machine.

## Pieces

| Piece | File | Role |
|---|---|---|
| Accounts | `nodes/accounts.ts` | Pairing tokens in `~/.halo/secrets/channels/channels.db` `channel_accounts` (`channel_type='node'`, `label` = machine name, `config` = `{ token }`, `access_level` = `'full'`). Name `^[a-z0-9][a-z0-9-]{0,31}$`, unique per workspace (realpath compare) → 409 |
| Hub | `nodes/hub.ts` | Server side. `noServer` `WebSocketServer` on `/api/nodes/connect`; one live connection per account; request/response correlation, timeouts, cancel, heartbeat; `nodes:changed` broadcast. Process singleton via `setNodeHub` / `getNodeHub` |
| Tools | `nodes/tools.ts` | `buildNodeTools(workspaceRoot)` → the fixed 8 tools. Dispatch: hub (in-process) → `NODES_UNAVAILABLE` |
| Routes | `nodes/routes.ts` | Admin CRUD (`/api/nodes/accounts`) |
| Client | `packages/node-go/` | `halo-node`: the machine side, a standalone Go binary (no cgo, cross-compiled for Linux amd64 / arm64 / armv7, macOS arm64 / amd64 and Windows amd64). Connects, reconnects with backoff and runs each request through its own port of the local file tools (the seven ops, POSIX rm guard, process-group / Windows Job Object kill) with JS value, UTF-16 and V8 regex semantics (`internal/jsv`, `internal/jsregex` over regexp2), so results read like the server's own tools. Ships as release assets via `.github/workflows/node-go.yml`, not npm |

Not built in AgentCore mode (`nodeHub = AGENTCORE ? null : …`), the CLI / TUI or the evo sandbox — there the tools exist but return `NODES_UNAVAILABLE`.

### Platforms

CI (`node-go.yml`) runs `go vet` / `go test` natively on Linux and Windows and `go test` for Linux arm64 / armv7 under qemu (binfmt) — including `cmd/halo-node/lifecycle*_test.go`, which run the binary against a fake hub (fatal 401 / 404 / 426 / 4001, retried 409 / 429 / 4009 / other HTTP, backoff, a running call killed on 4001 / drop / SIGTERM) — plus the rm-guard vector `--check` (`testgen/gen-rmguard-vectors.mjs`: the vectors must still equal what the server's `sandbox.ts` `assertRmSafe` says) and a 20k-pattern regex differential fuzz against Node's `RegExp` (`testgen/regex-fuzz.mjs`). Accepted regex gaps against V8 are pinned by `known` vectors in `internal/jsregex/testdata/regex-regress.jsonl` (D11: a capture inside a quantified group isn't reset per iteration; D10: regexp2 engine limits and its 30 s per-match timeout, which aborts the grep / glob call). macOS builds are only cross-compiled — no macOS runner, not tested on a Mac. They use the POSIX code paths (process groups, rm guard); `internal/jsv`'s errno table is Linux-only, so on macOS a filesystem error reads `Unknown system error -<n>: …` instead of Node's `ENOENT: no such file or directory, …` text.

Windows implementation: the shell starts suspended, is assigned to a `KILL_ON_JOB_CLOSE` job, then resumes. Cancel and timeout call `TerminateJobObject` (no graceful SIGTERM equivalent for hidden cmd.exe), retaining the shared 2 s escalation / 200 ms force-settle ceiling. The byte-capped stdout / stderr streams decode as strict UTF-8, falling back to GBK. Folder checks use case-insensitive Windows `filepath.Rel`, reject other volumes, and resolve the longest existing prefix with `GetFinalPathNameByHandle` (including junctions). A bootstrap cmd.exe gets a new hidden console, runs `chcp 65001`, then starts the command's cmd.exe so it initializes in UTF-8 even without an interactive desktop. The Unicode command passes through `HALO_NODE_COMMAND` in the child environment (delayed expansion in the bootstrap only; the inner `/d /s /c` shell inherits the machine/user `DelayedExpansion` default), not the bootstrap's legacy-codepage parser. Win32 filesystem errors map through libuv's Node-style errno names. `~/` uses `USERPROFILE`; `~\` stays literal.

The POSIX rm-guard tests are build-excluded on Windows: the guard isn't called there.

## Two modes

- **Folder mode** (`--root <dir>`): `root` is realpath'd at start. Every path argument and node_run's `cwd` must resolve inside it, else the call is refused before any I/O (`"<p>" is outside this machine's shared folder (<root>) — …`; machine log `[Node] refused <op> <path>: outside root`). Relative paths resolve against `root`.
- **Whole-machine mode** (no `--root`, or `--root /`): no prefix check — the same reach as a full-access local session, i.e. whatever the machine user can access. Relative paths and node_run's default cwd resolve against `base` = the directory `halo-node` was started in. A startup line says so. `node_list` reports the machine as `root: null, wholeMachine: true, base: "<dir>"`; the admin row shows "Whole machine".

`--allow-shell` is independent of the mode and off by default. Commands run **unsandboxed** as the machine user — in folder mode only their `cwd` is held inside `root`, the command itself can reach anything (v1 accepted trade-off; the startup warning and the guide say so). `{{ns.params.x}}` placeholders are never substituted on the machine (empty namespace set), so no settings secret reaches a command.

### Path check (`nodepath.InRoot`)

Resolve against root, then walk up with **`lstat`** to the longest existing prefix, `realpath` it, re-append the missing tail, and test containment with `filepath.Rel` (so `/x/root-other` is not inside `/x/root`; drive letters compare right on Windows). `lstat`, not a following `stat`: that follows a dangling symlink and reports it missing, so `root/link → /outside/new` would stay unresolved, pass the prefix test, and the write would follow the link out of root. With `lstat` the link is found, its `realpath` fails, and the call is refused. A narrow TOCTOU window (a component swapped for a symlink between check and syscall) remains — same as the local tools.

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

Forward proxy: `--proxy <http(s)://[user:pass@]host:port>` is used alone; without it `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` apply (Go's `http.ProxyFromEnvironment`: loopback servers are never proxied). A `wss://` server goes through `CONNECT`, so the token stays inside TLS; `user:pass@` becomes `Proxy-Authorization: Basic` and is never printed (the startup line shows `Redacted()`). Redirects are never followed: a 3xx is `server refused the connection (HTTP 3xx)` and the token never goes to the `Location`.

`verifyClient` answers in this order: **429** IP locked out (`middleware/brute-force.ts`, own `node-token` bucket: 5 bad tokens in 15 min) → **426** protocol mismatch → **401** unknown token (recorded as a failure) → **404** bound workspace gone → **400** info / instance missing or malformed → **409** account already connected from a *different* instance. The path is in no auth middleware; the token is the auth.

**Frames** (JSON text, ≤ `MAX_FRAME_BYTES` = 8 MiB both ways):

```
server → node  { t: 'welcome', name, workspace }
server → node  { t: 'req', id, op, args }        op ∈ read write edit list grep glob run
server → node  { t: 'cancel', id }
node → server  { t: 'res', id, ok: true, text } | { t: 'res', id, ok: false, error }
```

`args` are the local tool's input minus `node` (node_run: `{ command, cwd }`). Results longer than `NODE_RESULT_MAX_CHARS` (256K) are cut on the machine with `[Content truncated on the machine: N chars total]`; the agent loop's own caps (8000 to the LLM, 64K to the UI) then apply as for any local tool. A request over 8 MiB is refused before sending.

**Close codes**: `4001` token revoked (DELETE in admin) → node exits 1. `4009` replaced: a reconnect from the **same** instance supersedes the old socket (half-open link recovery); a **different** instance is refused (`409` at handshake, or `4009 already connected from another process` if it raced) and keeps retrying with backoff — so starting a second `halo-node` with the same token never kicks the first. `1001` server shutting down → reconnect.

**Liveness**: server pings every 20 s and terminates after 2 missed pongs; the node's watchdog terminates after 60 s without any traffic. Either side dropping fails all in-flight calls.

**Timeouts**: node_run waits `shellTimeoutMs + 15 s` (the machine's own shell timeout — `HALO_SHELL_TIMEOUT` in ms, default 120 s — kills the command first; `node_list` shows it as `shellTimeoutSec`); every other op 120 s. On timeout or session abort the hub sends `cancel`; the node aborts the call (shell: process group SIGTERM → SIGKILL).

**Reconnect** (node): backoff 1 s doubling to 30 s, ±20 % jitter, reset on `welcome`; 10 s handshake timeout. Fatal (exit 1): 401, 404, 426, close 4001. 409 retries with backoff; 429 waits ≥ 60 s.

## Disconnect semantics

Results are never replayed. When the link drops mid-call:

- server side: each pending call rejects with `machine "<n>" went offline during the call (connection lost). The operation may or may not have completed on the machine — check its state before retrying.`
- machine side: every running call is aborted (node_run's process group gets SIGTERM, SIGKILL 2 s later) and the log reads `connection lost (…) — stopped N running call(s); reconnecting in Xs`.

When `halo-node` itself exits — Ctrl-C or a fatal refusal such as a revoked token (4001) — the same abort runs, but the process exits only after the aborted calls have settled, capped at 2.5 s. The SIGKILL follow-up is a timer in the node process and the command's group is detached, so exiting first would leave a TERM-ignoring command running on the machine.

Offline vs unknown are distinct errors: `machine "<n>" is offline (…). Do not retry in a loop — tell the user to start it.` vs `unknown machine "<n>" — machines linked to this workspace: a, b (see node_list)`.

## Cron runs

Cron runs execute in the server process since 2.2 ([cron.md](cron.md#execution-runjob)), so their node tools reach the hub directly like any other server-side session. The loopback relay the old `halo cli` child used (`POST /api/nodes/call`, a per-boot secret in `HALO_NODE_RELAY_URL` / `HALO_NODE_RELAY_TOKEN`) is gone. `child-env.ts` still strips `HALO_NODE_TOKEN` from every child the server builds, and `halo-node` drops it from its own environment at start and from every `node_run` command's — env hygiene, not a boundary: a full-level command runs unsandboxed as the same user and can read that user's processes and files anyway.

## Prompt-cache invariant

The tool list is decided **only** by `agent.yaml`: `node_list` in `tools:` + a full-access session (`accessLevel === null`) → all 8 tools; otherwise none. `buildNodeTools` returns constant names / descriptions / schemas — it reads no hub, db, env or machine list. Machines coming and going therefore never change the tools block or the system prompt, and the prompt cache survives. Online state reaches the model only as the **result** of `node_list` (and in errors). Pinned by `session-agent-builder.test.ts` (tools JSON + system prompt byte-identical with 0 and 2 machines online). See [memory/2026-10-27-node-prompt-cache.md](../../memory/2026-10-27-node-prompt-cache.md).

Cost: the 8 descriptions measure ≈ 460 tokens (Claude CountTokens); with schemas the set adds ≈ 1.6K tokens per request for agents that opt in.

## Admin

`features/nodes/` adds **Channels → Linked machines** (after Web): a row per token with online dot, name, workspace, `root | Whole machine · shell on/off · os`, token copy and delete. The add dialog takes workspace + name and shows two ready-to-copy commands (token in the env, not a flag). **Linux / macOS** is `curl -fsSL <base>/install.sh | sh`, then `PATH="$HOME/.local/bin:$PATH" HALO_NODE_TOKEN=<t> halo-node --server <origin> --root <folder>` — a non-root install lands in `~/.local/bin`, which Debian / Ubuntu / Raspberry Pi OS put on `PATH` only at a login after it exists. **Windows** (PowerShell) downloads `<base>/halo-node-windows-amd64.exe` with `Invoke-WebRequest`, sets `$env:HALO_NODE_TOKEN` and runs `.\halo-node-windows-amd64.exe --server <origin> --root <folder>`. `install.sh` (`packages/node-go/install.sh`, POSIX sh) is uploaded per release with that release's version stamped in. It maps `uname -s` (Linux / Darwin) and `uname -m` (Darwin: `arm64` → arm64, `x86_64` → amd64), downloads the binary, checks it against `SHA256SUMS` and runs its `--version`, then installs to `/usr/local/bin` (root) or `~/.local/bin` by a rename in that directory, so a running `halo-node` is replaced without "Text file busy". No token, no service. The base comes from `/api/health`'s `version`: a plain `x.y.z` pins `releases/download/v<x.y.z>`, so the machine and the server come from the same tag; a dev build (`x.y.z-<sha>`) or a failed fetch uses `releases/latest/download`. Online state comes from the list response, then `nodes:changed` (full snapshot, global broadcast — the channels page is a global view); a WS reconnect drops the pushed snapshot and re-fetches the list. No polling.

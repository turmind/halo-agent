# AgentCore Runtime Mode

Halo server as an **Amazon Bedrock AgentCore Runtime** container speaking the
**A2A protocol** (AgentCore `serverProtocol: A2A`) — a fourth way to run halo
(server / CLI / desktop / AgentCore). `halo agentcore --workspace <path>` sets
`HALO_RUNTIME_MODE=agentcore-a2a` and runs the server in the foreground; the
implementation is `packages/server/src/a2a/agentcore.ts`. The repo ships no
deploy package (Dockerfile / IaC): you build the image and create the runtime
yourself. The former HTTP-protocol mode (`/invocations`, WS `/ws`, per-user
workspaces) and its demo package were removed 2026-10-09 (git history `7e98369`).

```
Caller (any halo server, or any A2A client that SigV4-signs)
   │  POST …/runtimes/<escaped ARN>/invocations/   (A2A JSON-RPC, SigV4)
   │  GET  …/invocations/.well-known/agent-card.json
   │  X-Amzn-Bedrock-AgentCore-Runtime-Session-Id = fixed id
   ▼
AgentCore Runtime (per-session microVM, verifies the signed request)
   ▼
halo agentcore :9000  (HALO_RUNTIME_MODE=agentcore-a2a)
   ├── GET  /ping                          Healthy | HealthyBusy
   ├── POST /                              A2A JSON-RPC
   └── GET  /.well-known/agent-card.json   card (no securitySchemes)
        one fixed workspace (EFS) — <ws>/.halo/{a2a.db, runs.db, agentcore.lease}
```

## Running it

`halo agentcore [-w <path>] [-p N]`; the workspace is required and must exist.

`HALO_HOME` must be initialized first: run `halo setup --non-interactive` in
the image build (seeds `~/.halo/global` — agents, skills, models). `halo
agentcore` skips the CLI's setup gate, but the server still exits at boot with
"~/.halo/global/ not initialized" without it. Edits to the seeded files (e.g.
pointing the agents' Bedrock endpoint at the runtime's region) go after it.

| Setting | Meaning |
|---|---|
| `-w, --workspace` / `HALO_WORKSPACE` | The one workspace served — an EFS mount in practice. |
| `-p, --port` | Listen port, default `9000` (the AgentCore contract). Always overrides `HALO_PORT`. |
| `HALO_A2A_PUBLIC_URL` | The runtime's invoke URL (`…/runtimes/<escaped ARN>/invocations`); becomes the card's interface URL (`<url>/`). Unset → warning, and the card advertises the container's own origin. |
| `HALO_A2A_ACCESS` | Access level of every session: `workspace` (default) \| `full` \| `readonly`. Anything else is a boot error. |
| `HALO_LOG_LEVEL=info` | Needed for CloudWatch — see the ops notes. |

## What the mode changes (packages/server/src/index.ts)

`config.server.runtimeMode === 'agentcore-a2a'` skips:

- **Password/JWT gate** and the **single-instance lock** — AgentCore verifies
  the signed request before forwarding; many microVMs coexist by design.
- **Channels, cron, evolution, archive daemon, extensions watcher, admin WS
  and transcribe proxy** (every WS upgrade gets the router's 400).
- **The whole `/api/*` surface** (auth middleware included) **and the admin
  static bundle / SPA fallback.** The container answers only `/ping`, `POST /`
  and the card (the only paths AgentCore passes through); everything else is a
  plain JSON 404, no HTML.
- The normal `/a2a/<path>` mount and the `/a2a-push` receiver. There is no
  outbound A2A from inside the container (`a2a_send` reports itself
  unavailable): a remote's webhook can't reach a microVM.

Everything else (agent loop, tools, skills, sqlite) is the normal server. The
card is `<ws>/.halo/agent-card.json`, seeded (name `Halo`, `skills: []`) if
missing, never overwritten — edit it to describe the agent.

## Workspace and lease

Sessions live in the workspace's `.halo/` and A2A task state in
`<ws>/.halo/a2a.db`, so tasks survive microVM recycling. `a2a.db` holds push
tokens, so it (and `-wal` / `-shm`) is hidden from non-full sessions
(`tools/sandbox.ts`).

Everything the mode keeps on the workspace (EFS), under `<ws>/.halo/`:

| File | What | Written |
|---|---|---|
| `halo.db` (+ `-wal` / `-shm`) | session rows (title, counts, tokens, output, `reply_to`, `stopped_at`) | every turn and tool call — see [SQLite durability](#sqlite-durability) |
| `a2a.db` (+ `-wal` / `-shm`) | A2A tasks, push configs + outbox | task create / touch / transition, push delivery |
| `runs.db` (+ `-wal` / `-shm`) | run ledger, see [Resume after a mid-task kill](#resume-after-a-mid-task-kill) | entry / exit of every run |
| `sessions/<agentId>/<seg>.{ui,raw}.jsonl` | session logs ([session.md](session.md)) | appended at every save, rewritten whole on compaction / archive |
| `sessions/<agentId>/<seg>.ui.arch.<N>.<h>.jsonl.gz` | archived UI history | turn end, past 5 MB |
| `agentcore.lease` | single-writer lease (below) | heartbeat every 10 s |
| `runtime.lock` | runtime claim; deleted and re-claimed at each acquisition | lease acquisition |
| `agent-card.json` | the served card, seeded if missing | first non-`/ping` request |
| `agents/`, `skills/`, `prompts/`, `memory/`, `canvas/self.html`, `tmp/`, `assets/a2a/…` | workspace content, as on any server ([storage.md](storage.md)) | by the agent / inbound images |

The container's `HALO_HOME` (`~/.halo`: settings, model registry, `server.log`)
is the image's and dies with the microVM.

Each runtime session id gets its own microVM, all mounting the same EFS, so a
single-writer lease guards it — `<ws>/.halo/agentcore.lease`, plain NFSv4 file
ops only:

- **Activation is lazy.** AgentCore boots microVMs ahead of time (a warm pool)
  and mounts the filesystem only when a session is assigned, at its first
  invocation — at boot `HALO_WORKSPACE` is still the image's empty dir. So
  nothing touches the workspace at boot: the first request other than `/ping`
  creates `.halo/` and seeds the card.
- **Acquire on request.** Each `POST /` makes one acquisition attempt unless the
  lease is held (concurrent POSTs share one attempt). There is no background
  retry: a refused microVM never polls, so only the microVM callers are actually
  talking to competes. AgentCore can leave microVMs it no longer routes to
  (see gotchas), and a polling one would take the workspace away from the
  fixed session id.
- The holder rewrites a heartbeat every **10 s**; a lease older than **45 s**
  is stale and taken over by the next request (rename, then a 2 s inline
  recheck that it still names us). The owner is a per-process random id, so a
  successor takes over after release or staleness, whatever its session id.
- `a2a.db`, the SessionManager and the push sender start only once the lease
  is held; `runtime.lock` is then deleted (its pid probe can't see other microVMs).
- Without the lease: `POST /` answers JSON-RPC `-32603` "workspace is in use by
  another runtime session — call with the fixed runtime session id", and
  `/ping` reports `Healthy` (never busy) so AgentCore can reap that microVM.
- **Handoff takes ~45 s in practice, not a graceful release.** Graceful stop
  does try to delete the lease, but on AgentCore the EFS mount is usually
  already detached when SIGTERM arrives (`StopRuntimeSession`, idle reap). The
  next session — the same id too, which comes back on a fresh microVM — waits
  out the stale window and gets `-32603` meanwhile. Measured: 42–47 s
  typically, 1.6 s once when the release did land.
- On **losing** the lease (heartbeat stalled past the stale window and someone
  took over) the process exits immediately, skipping the graceful flush that
  would write into the new holder's workspace.

### Resume after a mid-task kill

The [run ledger](session.md#run-ledger--restart-nudge-for-interrupted-roots-haloglobalrunsdb) lives on the workspace in this mode — `<ws>/.halo/runs.db` (hidden from non-full sessions, like `a2a.db`), not the container's `HALO_HOME`, which dies with the microVM. So a task cut off mid-run (the 8 h `maxLifetime`, a crash, a recycle) resumes on the next microVM:

- `onAcquired` opens the ledger (`setRunsDb(createRunsDb(<ws>/.halo))`) **before** `registry.getOrCreate`; `index.ts` opens none in this mode. The SessionManager constructor then runs the server's boot chain — claim `runtime.lock`, orphan reconcile, goal sweep, run-ledger sweep — which drains the rows the dead microVM left and nudges each interrupted root.
- The `POST /` that acquired the lease waits for those nudges to reach their sessions (`nudgesSettled`) before it is handled, so a GetTask on the interrupted task sees its root running → `WORKING`, not idle.
- Nothing wakes a new microVM by itself: the resume happens on the **next invocation** — the caller's `a2a_read` / GetTask, or a new send. No caller-side polling.
- `ownsRuntimes` stays `false`, so the lazy FAILED in `routes.ts` `reconcileStale` remains the fallback for a task the sweep didn't resume (root idle, quiet subtree): "Interrupted by a server restart on the remote. Send again on the same context to resume."
- Verified locally: `kill -9` mid-task (2 of 6 `sleep 30` calls done) → new process refused for ~45 s, then the first accepted GetTask read `WORKING` and the task completed with all six results.

### SQLite durability

**`synchronous=FULL` on the workspace dbs.** WAL mode defaults to `synchronous=NORMAL` (better-sqlite3 builds with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`): a commit writes its WAL frames and returns without an fsync. On EFS those frames sit in the NFS client's page cache until writeback or a checkpoint — SQLite's unlock is on `-shm` and flushes nothing of `-wal`. A microVM that dies (stop timeout, crash, the 8 h `maxLifetime`) could lose its last seconds of commits: a lost `insertRunning` means the killed run is never resumed, a lost `createTask` leaves the caller a taskId nobody knows, a lost `transition` gets a completed task marked FAILED by the next boot's reconcile. So `createAgentCoreA2A` registers `<ws>/.halo` (`setDurableDbDir`, `db/durability.ts`) before anything opens there, and `createDb` / `createRunsDb` / `createA2ADb` set `synchronous=FULL` on a connection in that dir, right after `journal_mode` and before their own schema writes and the SessionManager constructor's sweeps. Server mode registers nothing — every db there (HOME-side ones included) keeps NORMAL. The session `.jsonl` files need nothing: every write closes its fd, and NFS close-to-open flushes on close.

Cost: one fsync per commit that changes a row; an UPDATE that changes nothing writes no frame and syncs nothing. Measured (strace, scripted A2A SendMessage): a follow-up turn with no tool call commits 10 times (a2a.db 2 — create + complete; runs.db 2 — insert + delete; halo.db 6 — `reply_to` set + clear, output / last-activity twice (first event, release), counts / tokens, `updated_at`); each tool call adds one (the next model call's token UPDATE), plus the output / last-activity write at most once per 5 s mid-turn. Checkpoints fsync the main db file on top.

**Known risk — `-shm` and dead-host locks on NFS (unverified).** SQLite doesn't support WAL on network filesystems; here the lease keeps a single writer, so normal running is fine, and the risk sits at a crash handoff. When a db opens, SQLite rebuilds the wal-index only if no other connection holds the DMS lock byte on `-shm`. A killed microVM's NFS locks persist until its lock lease expires on the server; if that outlasts the ~47 s lease handoff, the next holder keeps the old `-shm` contents — which the dead client's mmap may never have written back — and the wal-index may not match the WAL (wrong pages read). Needs measuring on EFS: the lock lease length, and a `kill -9` handoff under write load. If it bites, the candidate is `journal_mode=TRUNCATE` + `synchronous=FULL` on the workspace dbs (no `-shm`; ~8 ms per commit, ~5 ms more than now).

**Known cost — synchronous IO on the event loop.** Session-log writes, SQLite commits and the bwrap mask lookups are synchronous by design (they keep UI / raw writes and the tombstone check in one synchronous slice), so each EFS round trip blocks the loop: estimated at ~40 ms per tool call and ~70 ms per turn before the 2.0 IO trimming, during which other sessions and `/ping` wait. Moving to async IO would reorder the write paths' guarantees; not planned.

## Access model

"Upstream" strategy: AgentCore verifies the caller's SigV4 before forwarding,
so the container does no token auth and the card carries no `securitySchemes`.
Every call is one fixed caller (`accountId: agentcore`) on the fixed workspace,
mounted at `/` (any sub-path is 404), with the session level from
`HALO_A2A_ACCESS` — default `workspace`, not `full`. See
[guide/delegation-and-access.md](../guide/delegation-and-access.md).

## Caller side (any halo server)

In the caller server's `~/.halo/secrets/a2a-remotes.yaml` (server-wide, full-only):

```yaml
remotes:
  agentcore:
    card: https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/<escaped ARN>/invocations/.well-known/agent-card.json
    auth: sigv4
    push_base: http://<caller's VPC-reachable host>:<port>
```

- `auth: sigv4` signs the card GET and every RPC (service `bedrock-agentcore`,
  region from the host name, SDK default credential chain) — `a2a/outbound.ts`.
- It sends a fixed `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` =
  `halo-` + sha256(caller workspace realpath + remote name), 69 chars: the same
  (workspace, remote) always lands on the same microVM, so card, RPCs and
  follow-ups share it.
- A `-32054` "retry" error (AgentCore's RetryableConflict — the session's
  microVM is being provisioned or torn down) is retried with backoff
  0.5 → 1 → 2 → 4 → 8 s, re-signed each time; the plain ConflictException
  shares the code but isn't retried.
- `push_base` is where the container posts task results (the webhook is
  `<push_base>/a2a-push/<id>`); default is the caller's own public URL, which
  must be reachable from the runtime's network. A failed push is retried with
  backoff and given up after 10 attempts or **1 h** of age, whichever comes
  first (the age cap is 24 h elsewhere), because pending pushes keep `/ping`
  busy.
- The container checks the push URL against `general.a2a.url_allowlist` in its
  own settings.yaml (default `100.64.0.0/10,*.ts.net`): a private-IP or
  plain-http `push_base` is refused unless listed there.
- Only `halo server` calls out: `a2a_send` is available at every access level
  except the A2A read-only profile, and unavailable inside the AgentCore
  container itself and in CLI/TUI.

## Session lifecycle

- `/ping` returns `HealthyBusy` while the lease is held and an agent session is
  running (`hasRunningSessions()`) or a push is pending — the keep-alive for
  long tool chains with no open request.
- Idle timeout (`idleRuntimeSessionTimeout`, **60 s**) terminates a session
  whose `/ping` reports `Healthy` — the microVM exits on its own once idle (no
  self-stop, no extra IAM). So the 8 h `maxLifetime`, which force-terminates
  even busy ones, bounds one busy stretch rather than accumulating across
  tasks; a task cut off by it resumes (see above). Failed health checks kill
  immediately.
- Termination is cheap: state is on EFS; the next call cold-starts a microVM
  and takes the lease once the old one is stale (~45 s, see above). A call in
  that gap gets the lease-busy `-32603`; the caller side (`a2a/outbound.ts`)
  retries it at 5 / 10 / 15 / 20 s, matched on the code plus the `LEASE_BUSY`
  message prefix — keep that text stable.
  There is **no list/get-runtime-sessions API** (observe via the CloudWatch
  `Sessions` metric + runtime log filtering).

## Ops crib sheet

- CloudWatch logs capture container **stdout**; halo's logger drops
  sub-threshold lines before stdout — set `HALO_LOG_LEVEL=info` or the log
  group stays near-empty.
- `update-agent-runtime` **replaces the whole config** — omit
  `--filesystem-configurations` and the EFS mount silently disappears.
  Fetch-modify-send, and strip `requireServiceS3Endpoint` (rejected on
  newer runtimes).
- VPC mode has no public IP: private subnets need `0.0.0.0/0 → NAT` or all
  egress (Bedrock included) hangs → opaque 502s.

## Gotchas

Found deploying `halo_a2a` (ap-northeast-1, 2026-10-09):

- **EFS is mounted only at a session's first invocation**, not at microVM
  boot (warm pool) — hence lazy activation. Anything touching the workspace
  at startup writes into the image's empty dir (first card fetch: 500, ENOENT).
- **StopRuntimeSession stops one microVM.** Concurrent first calls on a new
  session id can land on several; the others linger until the idle timeout (60 s).
  Harmless now that refused microVMs don't poll the lease.
- **EFS is gone by SIGTERM** — graceful lease release usually can't land
  (`missing` / `Unknown system error -512`); handoff = stale window.
- **curl `--aws-sigv4` can't sign the ARN-form invoke URL** (curl 8.5 doesn't
  double-encode the escaped `%3A` / `%2F` in the canonical path → 403). Use
  the id form `…/runtimes/<runtime-id>/invocations?accountId=<acct>` for
  JSON-RPC (`accountId` required). The card is served only on the ARN form,
  so sign that with botocore or the server's own `sigv4Headers` (smithy), which
  both get it right.
- **aws-cli `create-agent-runtime` has no `metadataConfiguration`** (2.36);
  only `update-agent-runtime` takes `requireMMDSV2` — create, then update.
- **`pnpm deploy --prod` rewrites the repo's
  `node_modules/.pnpm-workspace-state-v1.json`** as a prod-only install; the
  next `pnpm <script>` in that checkout then tries `install --production` and
  aborts without a TTY. Back the file up around `pnpm deploy` (or run builds
  with `pnpm_config_verify_deps_before_run=warn` — `pnpm_config_*`, not
  `npm_config_*`).
- `-32054` RetryableConflict never showed up in practice (concurrent cold
  first calls, bursts after a stop); the caller retry stays as cheap insurance.

## Observability

The runtime container can export traces/metrics/logs via `general.observability.*`
to an in-container or sidecar OpenTelemetry collector, same as any other halo
deployment. AgentCore Evaluations reads the resulting spans out of the
CloudWatch `aws/spans` log group (Transaction Search) — see
[design/observability.md](observability.md) for the collector config and the
Evaluations input contract.

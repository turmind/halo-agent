# AgentCore Runtime Mode

Halo server as an **Amazon Bedrock AgentCore Runtime** container — a fourth
way to run halo (server / CLI / desktop / AgentCore). `halo agentcore
--workspace <path>` sets `HALO_RUNTIME_MODE=agentcore-a2a` and runs the server
in the foreground; the implementation is `packages/server/src/a2a/agentcore.ts`
(+ `invocations.ts` for jobs, `agentcore-front.ts` in session-dirs mode). One
process serves both AgentCore server protocols, and AgentCore forwards only the
paths of the runtime's own protocol:

- **A2A** (`serverProtocol: A2A`, :9000) — `POST /` JSON-RPC and the agent
  card. Callers are halo servers with an `auth: sigv4` remote, or any A2A
  client that SigV4-signs.
- **HTTP** (`serverProtocol: HTTP`, :8080) — [`POST /invocations`](#post-invocations),
  a prompt job, for anything that signs `InvokeAgentRuntime`: EventBridge
  Scheduler (which can't send A2A), a script.

The repo ships no deploy package (Dockerfile / IaC): the hub skill
`agentcore-deploy` ([turmind/halo-hub](https://github.com/turmind/halo-hub))
builds the image and creates the runtime, or you do it yourself. An earlier
HTTP mode (`/invocations` with WS `/ws` and per-user workspaces) and its demo
package were removed 2026-10-09 (git history `7e98369`); today's
`/invocations` is a different, job-shaped entry.

```
Caller — a halo server / SigV4 A2A client (A2A runtime), or anything that
         signs InvokeAgentRuntime: EventBridge Scheduler, a script (HTTP runtime)
   │  POST …/runtimes/<escaped ARN>/invocations   (A2A JSON-RPC | job payload, SigV4)
   │  GET  …/invocations/.well-known/agent-card.json   (A2A)
   │  X-Amzn-Bedrock-AgentCore-Runtime-Session-Id = session id
   ▼
AgentCore Runtime (per-session microVM, verifies the signed request)
   ▼
halo agentcore :9000 (A2A) | :8080 (HTTP)   (HALO_RUNTIME_MODE=agentcore-a2a)
   ├── GET  /ping                          Healthy | HealthyBusy
   ├── POST /                              A2A JSON-RPC
   ├── GET  /.well-known/agent-card.json   card (no securitySchemes)
   └── POST /invocations                   prompt job: sync | SSE | async | get
        one fixed workspace (EFS) — <ws>/.halo/{a2a.db, runs.db, agentcore.lease}
        session-dirs mode: one per session id, <base>/<sid> seen as /workspace
```

## Running it

`halo agentcore [-w <path>] [-p N]`; the workspace is required and must exist.

`HALO_HOME` must be initialized first: run `halo setup --non-interactive` in
the image build (seeds `~/.halo/global` — agents, skills, models). `halo
agentcore` skips the CLI's setup gate, but the server still exits at boot with
"~/.halo/global/ not initialized" without it. Edits to the seeded files (e.g.
pointing the agents' Bedrock endpoint at the runtime's region) go after it.
In session-dirs mode the worker's home is `/home/node`, so seed that one
(`HOME=/home/node halo setup --non-interactive`, as user `node`).

| Setting | Meaning |
|---|---|
| `-w, --workspace` / `HALO_WORKSPACE` | The one workspace served — an EFS mount in practice. In session-dirs mode, the base holding one dir per session id. |
| `-p, --port` / `HALO_PORT` | Listen port: `-p`, else `HALO_PORT`, else `9000`. A2A runtimes listen on 9000, HTTP runtimes on 8080 (the AgentCore contracts); halo serves every route on either. Session-dirs mode refuses 9100 (the worker's loopback port). |
| `HALO_A2A_PUBLIC_URL` | The runtime's invoke URL (`…/runtimes/<escaped ARN>/invocations`); becomes the card's interface URL (`<url>/`). Unset → warning, and the card advertises the container's own origin. |
| `HALO_A2A_ACCESS` | Access level of every session (A2A and `/invocations`): `workspace` (default) \| `full` \| `readonly`. Anything else is a boot error. |
| `HALO_AGENTCORE_NOTIFY` | Shell command run when an `/invocations` job finishes — see [the notify hook](#completion-and-the-notify-hook). |
| `HALO_AGENTCORE_SESSION_DIRS=1` | One workspace per runtime session id — see [Session dirs](#session-dirs). |
| `HALO_LOG_LEVEL=info` | Needed for CloudWatch — see the ops notes. |
| `OTEL_*` | Telemetry from the runtime env, no settings edit — see [Observability](#observability). |

## What the mode changes (packages/server/src/index.ts)

`config.server.runtimeMode === 'agentcore-a2a'` skips:

- **Password/JWT gate** and the **single-instance lock** — AgentCore verifies
  the signed request before forwarding; many microVMs coexist by design.
- **Channels, cron, evolution, archive daemon, extensions watcher, admin WS
  and transcribe proxy** (every WS upgrade gets the router's 400).
- **The whole `/api/*` surface** (auth middleware included) **and the admin
  static bundle / SPA fallback.** The container answers only `/ping`, `POST /`,
  the card and `POST /invocations`, exact paths (AgentCore passes through only
  its protocol's); everything else is a plain JSON 404, no HTML.
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
| `a2a.db` (+ `-wal` / `-shm`) | A2A tasks, push configs + outbox; `/invocations` jobs (`agentcore_invocations`, see [Job rows](#job-rows-a2adb)) | task create / touch / transition, push delivery; job accept / finish / supersede |
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
- **Acquire on request.** Each `POST /` and `POST /invocations` makes one
  acquisition attempt unless the lease is held (concurrent POSTs share one
  attempt). There is no background
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
  another runtime session — call with the fixed runtime session id"
  (`POST /invocations`: HTTP 503 with the same text), and `/ping` reports
  `Healthy` (never busy) so AgentCore can reap that microVM.
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
- The lease counts as held only once `onAcquired` has returned. If it throws (an `a2a.db` migration, `createRunsDb`, `getOrCreate`), the lease file is released, the half-opened db handles are closed and unset, `[AgentCore] workspace lease released: opening the workspace failed (…)` is logged, and the request is refused. The next request retries the whole acquisition. Otherwise the process would hold a lease with no heartbeat, and a second writer would take over 45 s later.
- `/invocations` sessions resume the same way: a root with an `{invocation}` `reply_to` gets the nudge, and its resumed run finishes the job (state, result, notify). That includes `cron-*` session ids — the `agentcore-deploy` skill passes the local cron session id as `session`. The sweep skips a `cron-*` root only when it has no `reply_to` (a cli-driven cron tree); with one, a caller is waiting on it.
- The request that acquired the lease — a `POST /` (A2A) or a `POST /invocations`, a `get` included — triggers that sweep. A `POST /` and a new `/invocations` job then wait for the nudges to reach their sessions (`nudgesSettled`) before they are handled, so a GetTask on the interrupted task sees its root running → `WORKING`, not idle. A `get` answers at once: a job's row has no lazy reconcile and stays `running` until the resumed run finishes it.
- Nothing wakes a new microVM by itself: the resume happens on the **next invocation** — the caller's `a2a_read` / GetTask, a new send, or an `/invocations` call (a new job or a `get`). No caller-side polling.
- `ownsRuntimes` stays `false`, so the lazy FAILED in `routes.ts` `reconcileStale` remains the fallback for a task the sweep didn't resume (root idle, quiet subtree): "Interrupted by a server restart on the remote. Send again on the same context to resume."
- Verified locally: `kill -9` mid-task (2 of 6 `sleep 30` calls done) → new process refused for ~45 s, then the first accepted GetTask read `WORKING` and the task completed with all six results.

### SQLite durability

**`synchronous=FULL` on the workspace dbs.** WAL mode defaults to `synchronous=NORMAL` (better-sqlite3 builds with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`): a commit writes its WAL frames and returns without an fsync. On EFS those frames sit in the NFS client's page cache until writeback or a checkpoint — SQLite's unlock is on `-shm` and flushes nothing of `-wal`. A microVM that dies (stop timeout, crash, the 8 h `maxLifetime`) could lose its last seconds of commits: a lost `insertRunning` means the killed run is never resumed, a lost `createTask` leaves the caller a taskId nobody knows, a lost `transition` gets a completed task marked FAILED by the next boot's reconcile. So `createAgentCoreA2A` registers `<ws>/.halo` (`setDurableDbDir`, `db/durability.ts`) before anything opens there, and `createDb` / `createRunsDb` / `createA2ADb` set `synchronous=FULL` on a connection in that dir, right after `journal_mode` and before their own schema writes and the SessionManager constructor's sweeps. Server mode registers nothing — every db there (HOME-side ones included) keeps NORMAL. The session `.jsonl` files need nothing: every write closes its fd, and NFS close-to-open flushes on close.

Cost: one fsync per commit that changes a row; an UPDATE that changes nothing writes no frame and syncs nothing. Measured (strace, scripted A2A SendMessage): a follow-up turn with no tool call commits 10 times (a2a.db 2 — create + complete; runs.db 2 — insert + delete; halo.db 6 — `reply_to` set + clear, output / last-activity twice (first event, release), counts / tokens, `updated_at`); each tool call adds one (the next model call's token UPDATE), plus the output / last-activity write at most once per 5 s mid-turn. Checkpoints fsync the main db file on top.

**Known risk — `-shm` and dead-host locks on NFS (measured 2026-10-17, low).** SQLite doesn't support WAL on network filesystems; here the lease keeps a single writer, so normal running is fine, and the risk sits at a crash handoff. When a db opens, SQLite rebuilds the wal-index only if no other connection holds the DMS lock byte on `-shm`. A dead microVM's NFS locks persist until its lock lease expires on the server; while they stand, the next holder keeps the old `-shm` contents, which could in theory lag the WAL. Measured on the `halo_a2a` runtime (2.0.1, EFS through the microVM's loopback NFS proxy):

- `StopRuntimeSession` and `kill -9`: the old locks are gone ~1 s later — no overlap with the ~45 s lease handoff. Three mid-load handoffs (2–3 tasks committing on every tool call): every task resumed and completed with no step missing or repeated, `integrity_check` ok on all three dbs at every checkpoint, no acked commit lost.
- **Idle reap** (no stop, the 60 s idle timeout): the dead microVM's locks stand **78–88 s** after its last write, i.e. 30–40 s past the 45 s stale window (consistent with a ~90 s NFSv4 lock lease, inferred). Real halo took over at 48–50 s under the standing locks and ran normally (3/3); a write-heavy probe db saw a transient `SQLITE_BUSY` / `SQLITE_PROTOCOL` on 2 of 16 opens and no corruption. A stale `-shm` behind its WAL was never observed.

So `journal_mode=TRUNCATE` is not warranted. If the transient BUSY ever matters, the cheaper knobs are a longer busy timeout on the workspace dbs or a stale window past the ~90 s lock lease — neither tried.

**Known cost — synchronous IO on the event loop.** Session-log writes, SQLite commits and the bwrap mask lookups are synchronous by design (they keep UI / raw writes and the tombstone check in one synchronous slice), so each EFS round trip blocks the loop: estimated at ~40 ms per tool call and ~70 ms per turn before the 2.0 IO trimming, during which other sessions and `/ping` wait. Moving to async IO would reorder the write paths' guarantees; not planned.

## `POST /invocations`

A prompt job over plain HTTP — the entry of an HTTP-protocol runtime, for
callers that can't speak A2A (EventBridge Scheduler → `InvokeAgentRuntime`,
a script). Routes in `agentcore.ts`, job state in `invocations.ts`. Wire shapes
and status codes: [dev/api.md](../dev/api.md#post-invocations).

### Request and dispatch

The body (≤ 1 MiB) is a JSON object: exactly one of `prompt` / `promptFile`,
plus optional `session`, `agent`, `id`, `async`; unknown fields are ignored.
`{"get": "<key>"}` alone reads a job instead (below). Shape errors are 400 and
answered before the lease.

- **Lease first.** Like `POST /`, the request takes the workspace lease (busy
  → 503 with the `LEASE_BUSY` text) and waits for the acquisition's run-ledger
  nudges (`nudgesSettled`) before dispatching.
- **`promptFile`** is read from the workspace: its realpath must be a regular
  file inside it, not a hidden runtime path (sessions, dbs — `isHiddenWorkspacePath`),
  non-empty, ≤ 1 MiB. The skill points a job at `.halo/jobs/<name>.md`, so the
  prompt is edited by syncing a file, not by recreating the schedule.
- **`session`** (`^[A-Za-z0-9_:-]{1,200}$`, a root session id) names the halo
  session: a fixed one keeps the job's history across runs (one per schedule),
  an existing one is resumed with its own agent. Absent → a fresh
  `inv_<time><hex>` session. **`agent`** applies only when the session is
  created (unknown or internal agent → 400); default is the workspace's default
  agent. Sessions run at `HALO_A2A_ACCESS`.
- The prompt reaches the model behind cron's unattended preamble ("nobody will
  answer questions…"); the chat log shows the prompt alone. A busy session
  queues it, as for any user message.
- **`reply_to = {"invocation": <id>}`** on the root marks it as owing the job —
  the third kind of [relay](relay.md) pointer beside `{workspace, sessionId}`
  and `{a2a}`. A session already owing an A2A task or a relay report is refused
  (409).
- A dispatch that throws before the message reached the session deletes the
  row and clears the pointer, so the caller's retry with the same `id` runs (500).

### Response modes

A new job answers by mode, all from the same receipt
`{status: "accepted", invocation, session, id}`:

- **sync** (default) — waits until the job leaves `running`, at most 10 min
  (A2A blocking SendMessage's cap), then answers the job body. Past the cap the
  body still reads `running`; the run goes on and the caller `get`s it later.
- **SSE** (`Accept: text/event-stream`) — `accepted` (the receipt, so a client
  that sent no `id` can still `get` after a drop), `delta {text}` events with
  the root's live text (sub-sessions' deltas are not forwarded), a
  `: keepalive` comment every 15 s, then one `result` event (the job body) and
  close. No time cap.
- **async** (`"async": true`) — the receipt at once.
- **get** (`{"get": "<key>"}`) — the job body now; the key is an invocation id,
  else a caller `id`. Unknown → 404.

A client that disconnects only stops waiting (sync) or unsubscribes (SSE); the
run is never tied to the request. Waiters are woken in-process
(`onInvocationDone`) — no polling of the db.

The **job body**: `{status, invocation, session, id, result, files,
startedAt, finishedAt, supersededBy?}`. `status` ∈ `running` \| `ok` \| `error`
\| `superseded`; `result` is the final reply (`finalOutput || output`, the text
`halo cli` prints, `MEDIA:` lines kept), null until finished; `files` is
`[{path, size}]` for the reply's `MEDIA:` paths that were regular files inside
the workspace at finish (realpath checked; paths as the agent wrote them,
`/workspace/…` in session-dirs mode) — a manifest, never the bytes.

### Idempotency and supersede

- **`id`** (≤ 256 chars) is the caller's idempotency key, unique across the
  workspace's jobs (partial unique index). A repeat answers that job's current
  body plus `"duplicate": true` at once, in any mode (JSON even when SSE was
  asked for), and runs nothing — whatever the new payload says. The re-check
  right before the insert sits in the same synchronous slice as the insert, so
  two concurrent retries can't both run; the unique index is the cross-process
  backstop. Keys persist with the rows (no expiry).
- **Supersede.** A new job on a session still owing an earlier one (still
  running, or cut off and never resumed) takes the pointer: the earlier row
  becomes `superseded` with `supersededBy` = the new id, its sync waiter and SSE
  stream answer that at once, and one completion — the new job's — covers both
  (the message folded into the same session). The same happens when an A2A
  message or a `relay_send` / `relay_interrupt` lands on a session owing a job:
  the job is superseded (`supersededBy` = `a2a:<task id>` /
  `relay:<caller session>`), then their pointer is written (`relay.ts`
  `takeReplyTo`). A job on a session owing an A2A task or a relay report is
  refused (409). For a new session that is checked again right after it is
  created, in the same synchronous slice as the write, so a concurrent request
  can't slip in between.

### Completion and the notify hook

The job ends exactly like an A2A task: relay's turn-end hook
(`deliverRelayReport`, after the quiet gate — the root's whole subtree idle)
calls `finishInvocation`, then clears `reply_to`. `finishInvocation` is a
guarded UPDATE on `running` (first writer wins): it stores `state` (`error`
when the turn ended in an error, else `ok`), `finished_at`, `result` and
`result_files` in one statement, wakes the waiters, then starts the hook.
Interim reports are not sent — a job notifies its final reply only.

`HALO_AGENTCORE_NOTIFY` (unset = no hook) runs as `sh -c <cmd>` in its own
process group: stdin = the final reply, env = the process env plus
`HALO_SESSION_ID`, `HALO_RUN_STATUS` (`ok` \| `error`) and `HALO_WORKSPACE`,
cwd = `HALO_WORKSPACE`. It is a server child, outside the agent sandbox; it is
killed (whole group) after 300 s, and its outcome is logged as one
`[AgentCore] notify <session>: exit N (ms) stdout: … stderr: …` line (tails of
1000 chars). `/ping` stays `HealthyBusy` while a hook runs. The hub skill's
`notify.py` is the intended hook: it pushes the text and its `MEDIA:` files
to Feishu / Slack / Telegram / WeCom from secrets in the runtime env.

In single-process mode the hook's env and `HALO_WORKSPACE` are the server's own
(the workspace). In [session-dirs mode](#notify-hand-off) the worker hands the
reply to the root front instead, which runs the hook on vetted input.

**At most once.** The job's row is final before the hook starts, and nothing
re-runs a hook. A hook that is cut off loses that push, and the row still
reads `ok` / `error` (`get` has the result). A hook is cut off by the 300 s
kill, or when the microVM goes away mid-hook: a stop, or the 8 h `maxLifetime`.
`/ping` reports `HealthyBusy` while a hook runs, so an idle reap doesn't cut
one off. On SIGTERM, single-process mode's `gracefulShutdown` does not wait for
a running hook; in session-dirs mode the front does, within its 30 s stop
budget ([front and worker](#front-and-worker)).

### Job rows (`a2a.db`)

`agentcore_invocations` in the workspace's `a2a.db` (durable on EFS, so a key
and an outcome survive microVM recycling): `id` (the invocation id, a UUID),
`request_id` (the caller's `id`, partial unique index), `session_id`, `state`,
`created_at`, `finished_at`, `result`, `result_files` (JSON `[{path, size}]`),
`superseded_by`. Sync, SSE and `get` answer from the row, never from the
session log (a fixed job session keeps growing). `A2A_MIGRATIONS` v2 adds the
last three columns to a table created by an earlier build (`user_version` 2
after it). Rows are not pruned.

## Session dirs

`HALO_AGENTCORE_SESSION_DIRS=1` gives each runtime session id its own
workspace `<base>/<sid>` on the EFS base (`HALO_WORKSPACE`), so callers on one
runtime don't share files. One microVM serves one session id, so isolation is
the microVM's own mount view — no extra namespace. Code:
`a2a/agentcore-front.ts` (front), `agentcore-notify.ts` (hook + worker → front
calls).

```
AgentCore ──► front  (PID 1, root, :9000 | :8080; node builtins only — no config / dbs / SessionManager)
                │  session header check, view setup once, proxy (streams both ways)
                ▼
              worker (uid/gid 1000, no caps, no_new_privs, env allowlist)
                = plain `halo agentcore --workspace /workspace -p 9100` on 127.0.0.1
                │  /ready, /notify ──► front loopback (per-boot token)
```

### Front and worker

- `halo agentcore` with the env set runs only the front: it needs root, refuses
  port 9100 (the worker's) and a base overlapping `/workspace`.
- Exact contract paths, else 404. `/ping` is the front's: `Healthy` until a
  worker is ready, then the worker's answer (5 s timeout; no answer →
  `HealthyBusy`, so a worker whose loop is blocked on EFS IO isn't reaped
  mid-run), `HealthyBusy` while the front runs a hook.
- Every other request needs `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`
  matching `^[A-Za-z0-9][A-Za-z0-9_-]{32,254}$` — 33–255 chars: AgentCore
  allows 256, but the id is the dir name and NAME_MAX is 255, so a 256-char id
  is a 400 rather than a dir that can never be made. A leading dot can't
  match, so `.template` / `.tmp-*` are never served. Else 400. Once a microVM
  serves a session id, any other id is 409: it never switches workspace.
- **First request:** the base must be a mount point (`/proc/self/mountinfo`;
  EFS arrives only at the first invocation — not yet → 503 "`<base>` is not a
  mount point …", retried by the next request; a `HALO_WORKSPACE` that isn't
  the EFS mount path keeps answering it). `<base>/<sid>` is created if
  missing: built in a dot-named `.tmp-<16 hex>` (0700 — no id in the name, so
  a long id can't push it past NAME_MAX) from `<base>/.template` minus `.halo/sessions`,
  sqlite files (+ `-wal` / `-shm` / `-journal`), `runtime.lock` and
  `agentcore.lease*`, chowned to 1000:1000 (best effort — an access point that
  enforces 0:0 refuses it and access still works), then renamed in, so a
  half-copied dir is never served and two microVMs racing on one id end with
  one complete dir. A failure here is a 500, retried by the next request.
  `<base>/.template` is the deployer's (the skill's `sync --template`); a new
  caller's first call costs a full copy of it.
- Then the [view setup](#view-setup), then the worker:
  `setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all
  --bounding-set=-all --no-new-privs env -i <allowlist> <node> <halo>
  agentcore --workspace /workspace -p 9100`, cwd `/workspace`. The allowlist:
  `PATH`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `HALO_LOG_LEVEL`,
  `HALO_A2A_ACCESS`, `HALO_A2A_PUBLIC_URL`, Halo's tuning knobs
  (`HALO_MAX_CONTEXT_TOKENS`, `HALO_SHELL_TIMEOUT`, `HALO_WEB_FETCH_TIMEOUT`,
  `HALO_MODEL_TIMEOUT`, `HALO_SESSION_GRACE`, `HALO_TERMINAL_GRACE`,
  `HALO_MAX_CACHED_SESSIONS`, `HALO_LOG_MAX_SIZE`, `HALO_LOG_MAX_FILES`), every
  `OTEL_*`, `AGENT_OBSERVABILITY_*` and `AWS_CONTAINER_*`, plus
  `HOME=/home/node` and the front's loopback URL + token — each named, no
  `HALO_*` wildcard. Channel secrets, `HALO_AGENTCORE_NOTIFY` and
  `HALO_PASSWORD` stay with the front.
- **Models: Bedrock on the runtime role only.** Model keys don't pass either:
  a `<<OPENAI_API_KEY>>`-style placeholder in `settings.yaml` resolves to
  nothing in the worker. The worker's credentials are the AWS ones above, so
  its agents use Bedrock through the runtime's execution role (as the
  `agentcore-deploy` skill deploys them). Another provider needs its key
  written as a literal value into the image's `/home/node/.halo` — and is then
  readable by the agent.
- The worker is the single-workspace mode on `/workspace`, unchanged (lease,
  run ledger, dbs, `/invocations`), bound to 127.0.0.1; once listening it posts
  `/ready` to the front (push, no probe). No `/ready` within 30 s → 503 for
  good. The request that triggered the start waits for it, then is proxied
  (unless its client has gone meanwhile — then nothing reaches the worker);
  hop-by-hop headers dropped, bodies streamed (SSE chunk by chunk), a closed
  client aborts the upstream request, and a worker response cut off mid-body
  closes the client's too (logged `[AgentCore] front: worker response cut off
  mid-stream`), so no client hangs on a dead stream. A handler that throws is
  logged and answered 500, never fatal to the front.
- The worker exiting ends the front: with the worker's exit code, or 1 when
  that was 0 or a signal (an unasked-for worker exit is a failure). SIGTERM /
  SIGINT to the front go to the worker — its graceful stop releases the lease.
  Either way the front first waits for its own notify work (a MEDIA copy or a
  hook still running), within the same 30 s budget: SIGKILL to the worker and
  exit once it is spent.

### View setup

Once per process, as root in the front's own (the microVM's main) mount
namespace, every command with a 30 s timeout:

1. `mkdir -p /workspace`
2. `mount --bind <base>/<sid> /workspace`
3. `umount -l <base>` — repeated while mountinfo still lists the base, at most
   5 times. `/mnt/efs` can carry stacked mounts (the platform's overlay bind
   under the nfs4 one) and each `umount` pops only the top one.
4. Check: the base is no longer a mount point and `<base>/<sid>` is no longer
   visible. Layers left after 5 rounds → "`<base>` still has N mount(s) after
   5 × umount -l".

Fail closed: any failing step or check answers 503 for that request and every
later one, the worker is never spawned and the setup never re-run (a half-done
setup must not be served). There is no network step — see
[the limits](#known-limitations-session-isolation-within-a-runtime).

**503 means "not serving right now", not "give up"** — the reason is the
body's `error` text, the status alone doesn't say which. Only two are for good
on this microVM: the view setup failed, and the worker wasn't ready in 30 s.
The base not being a mount point yet and the workspace lease being held by
another runtime session (`/invocations`) clear on their own — retry with the
same id. A caller can't decide to stop retrying from a 503 alone.

### Notify hand-off

In a worker, `finishInvocation` posts `{id, session, status, text}` to the
front's loopback `/notify` instead of running a hook. The token is per boot
but readable by the agent (same uid as the worker), so the front treats every
field as agent-controlled:

- token compared in constant time (else 403); body ≤ 16 MiB; `session` must
  match `^[A-Za-z0-9_:-]{1,200}$`, `status` be `ok` \| `error`, `text` a string
  (else 400). `/ready` works only while the worker starts; any other path, or
  `/notify` before the view is set up, is 404.
- 202, then — only if `HALO_AGENTCORE_NOTIFY` is set — a root-only (0700)
  temp dir per notify, which is also the hook's `HALO_WORKSPACE` and cwd. Each
  `MEDIA:<path>` line becomes a copy in it (`<dir>/<n>/<name>`): the path must
  be absolute; it is opened `O_PATH` (no side effects, never blocks on a FIFO),
  the file actually opened must resolve (`/proc/self/fd/N`) under `/workspace/`,
  be a regular file and ≤ 20 MB, and its bytes are read through that same fd.
  So no symlink or swap between the checks can point root at another file. A
  refused line is dropped with `[AgentCore] notify <session>: MEDIA dropped
  (<why>): "<path>"`.
- The hook runs with the front's env (the channel secrets) plus the validated
  `HALO_SESSION_ID` / `HALO_RUN_STATUS`, and the temp dir is removed after it.
  `notify.py`'s own "file under `$HALO_WORKSPACE`" rule then admits only the
  copies.

### Known limitations: session isolation within a runtime

Session dirs keep callers on one runtime from **reading each other by
accident**; they don't stop a caller who can make the agent read another
session on purpose. This is an accepted limitation; the hard boundary is the
runtime.

- **No network isolation inside the microVM.** Root has `CAP_SYS_ADMIN` but
  not `CAP_NET_ADMIN` (no packet-filter rules, nft or legacy); Landlock
  returns `ENOSYS` (and kernel 6.1 has no Landlock network rules); the cgroup
  fs is read-only (no cgroup-bpf); there is no `/dev/net/tun`. So halo can't
  keep the worker off the NFS port, and doesn't try.
- **Shared storage paths stay reachable.** EFS is mounted through a
  platform-side NFS proxy on the microVM's loopback (`127.0.0.1:/`, a high
  port) outside the container, and uid 1000 can get the execution role's
  credentials from the microVM metadata service (MMDS). An agent that writes
  an NFS client can mount the access point through either path and read every
  session's dir on that runtime.
- **The session id is the access key.** Anyone allowed to invoke the runtime
  with a given session id gets that session's dir.
- **The worker can call `/notify` itself** (it holds the token): only the
  deployer's hook runs, on validated input, but nothing rate-limits it.

What to do instead:

- **Separate runtimes for callers that don't trust each other** — the simplest
  hard isolation. The hub skill
  [`agentcore-deploy`](https://github.com/turmind/halo-hub) builds each deploy
  that way: its own encrypted EFS, access point and execution role, with a
  file-system policy of three statements — `DenyNonTls`,
  `DenyWithoutAccessPoint`, `AllowRuntimeRoleViaAP` — so a runtime can mount
  only its own access point, over TLS, and never the fs root. Storage limits
  live at that infra layer, not in halo.
- **Possible later hardening (not done):** run the worker in a network
  namespace with only `lo`, and give it a CONNECT proxy on a unix socket that
  allows only the Bedrock endpoints.

## Access model

"Upstream" strategy: AgentCore verifies the caller's SigV4 before forwarding,
so the container does no token auth and the card carries no `securitySchemes`.
Every call is one fixed caller (`accountId: agentcore`) on the fixed workspace,
mounted at `/` (any sub-path is 404), with the session level from
`HALO_A2A_ACCESS` — default `workspace`, not `full`. `/invocations` sessions
run at the same level. See
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
  running (`hasRunningSessions()`), a push is pending or a notify hook (or its
  hand-off to the front) is in flight — the keep-alive for long tool chains
  with no open request.
- Idle timeout (`idleRuntimeSessionTimeout`, **60 s**) terminates a session
  whose `/ping` reports `Healthy` — the microVM exits on its own once idle (no
  self-stop, no extra IAM). So the 8 h `maxLifetime`, which force-terminates
  even busy ones, bounds one busy stretch rather than accumulating across
  tasks; a task cut off by it resumes (see above). Failed health checks kill
  immediately.
- Termination is cheap: state is on EFS; the next call cold-starts a microVM
  and takes the lease once the old one is stale (~45 s, see above). A call in
  that gap gets the lease-busy `-32603` (`/invocations`: HTTP 503, same text);
  the caller side (`a2a/outbound.ts`) retries the A2A one at 5 / 10 / 15 / 20 s,
  matched on the code plus the `LEASE_BUSY` message prefix — keep that text
  stable. An `/invocations` caller retries itself, with the same `id`.
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

Found deploying session-dirs runtimes (2026-10-17, kernel 6.1 amzn2023, arm64):

- **No `CAP_NET_ADMIN` in the microVM** — root's CapEff is `0xa82425fb`
  (`CAP_SYS_ADMIN` yes, `CAP_NET_ADMIN` no), so packet-filter rules can't be
  added; a fail-closed setup step that needs them refuses every request.
- **`/mnt/efs` can be two mounts deep** (an overlay bind with nfs4 on top,
  depending on the image); `umount -l` pops one layer per call.

## Observability

The runtime container can export traces/metrics/logs via `general.observability.*`
to an in-container or sidecar OpenTelemetry collector, same as any other halo
deployment. AgentCore Evaluations reads the resulting spans out of the
CloudWatch `aws/spans` log group (Transaction Search) — see
[design/observability.md](observability.md) for the collector config and the
Evaluations input contract.

The image's `settings.yaml` needn't carry any of it: the standard
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` /
`OTEL_SERVICE_NAME` in the runtime env win over settings, and
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (`true` / `false`)
overrides `capture_content` ([details](observability.md#configuration)). In
session-dirs mode every `OTEL_*` var passes the worker's env allowlist.

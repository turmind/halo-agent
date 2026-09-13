# Cron — Scheduled Tasks Design

Run an agent on a schedule (daily report, periodic broadcast) and fan the result out to channels. Jobs live in the global db, fire via [croner](https://github.com/hexagon/croner), and execute as a fresh `halo cli` child process.

## Architecture

```
cron_jobs (global db)                      registered at boot:
      │                                    ┌── slack/cron-dispatcher
      ▼  reloadAll / reconcileFromDb       ├── feishu/cron-dispatcher
  runner.ts ──── croner schedule ──┐       ├── telegram/cron-dispatcher
      │                            │       └── wechat/cron-dispatcher
      │ fire                       │              ▲
      ▼                            │              │ registerCronDispatcher
  spawn `halo cli -n -s cron-<id>` │       dispatcher.ts (registry)
      │ stdout                     │              ▲
      ▼                            └──────────────┘ dispatchToTargets(rawText, targets, workspacePath)
  cron_runs (audit row + log file) ───────────────┘
```

Two halves, cleanly split:
- **runner.ts** — the scheduler. Owns the croner instances, spawns the cli, persists audit rows.
- **dispatcher.ts** — a channel-agnostic registry. Knows how to look up a dispatcher by `channelType` and hand off; knows nothing about any specific channel.

## Scheduling model

Schedules are **durable** — the source of truth is the `cron_jobs` table; in-memory croner state is rebuilt on every server boot (`startCronDaemon` → `reloadAll`). A restart never loses a schedule.

- **Recurring**: standard cron expression (`job.schedule`), optional `timezone`.
- **One-shot**: `job.runAt` (epoch ms) — croner fires once at that instant. After it completes, `finalize` sets `enabled=0` so it never re-fires. A `runAt` already in the past at schedule time is marked `lastRunStatus='missed'` and disabled (rather than firing immediately or retrying every reconcile).

### Trigger-mode exclusivity (the db contract)

Exactly **one** of `schedule` / `runAt` is set per job. `runner.ts` `scheduleJob` silently prefers `runAt` when both are present, and at-mode's post-fire auto-disable (`enabled=0`) would then kill the recurring schedule too — so the invariant is enforced at every write point, not just at create. `PUT /api/cron/jobs/:id` validates the **merged** row (partial PUT bodies make this non-obvious):

- Both sides in one body → `400 schedule and runAt are mutually exclusive`.
- One side only → treated as a **mode switch**: the other side is implicitly cleared (`schedule` set ⇒ `runAt=null`; `runAt` set ⇒ `schedule=''`).
- Clearing the active side with nothing to replace it (`schedule: ''` on a recurring job, `runAt: null` on an at-mode job) → `400 schedule or runAt required`. A triggerless job would sit `enabled` and never fire.
- A non-number, non-null `runAt` is rejected (`400`) *before* the exclusivity check — otherwise garbage types slip past `typeof body.runAt === 'number'` and land in the db as-is.

### Hot-reload + out-of-band edits

REST route mutations call `scheduleJob` / `unscheduleJob` directly. But the `cron` skill (and manual ops) edit `cron.db` over a *different* sqlite connection. `reconcileFromDb` (10s timer) catches those:

- Fast path: `PRAGMA data_version` flips only when *another* connection commits. If unchanged since last pass, skip the full select entirely — one pragma read (~µs) vs. a select-all + per-row fingerprint compare. The pragma (and the run-pruning `NOT IN (subquery)` below) needs the raw better-sqlite3 handle, which the runner gets from the shared `rawSqlite(db)` helper (`db/raw-sqlite.ts`) instead of re-spelling drizzle's `$client` / `.session.client` cast at each site — it did, three times, each with its own hand-written method shape.
- On change: diff db rows against the in-memory `_fingerprint` map (`enabled|schedule|runAt|timezone`); schedule new rows, unschedule deleted ones, re-instantiate croner only for rows whose fingerprint changed. Broadcasts a coalesced `cron:job_changed` per affected job.

## Execution (`runJob`)

Each fire:

1. **Concurrency guard**: if the same `jobId` is already running in this process (in-memory `_inflight` set), insert a `cron_runs` row with `status='skipped'`, `failureReason='previous run still in progress'`, broadcast, and bail without spawning. Applies to both scheduled fires and manual run-now clicks. Two overlapping cli children would double-write the same `cron-<jobId>` on-disk session state; SessionManager's per-session lock is in-process and can't see across cli children, so this set is the cheapest place to enforce serialization. The set itself is in-memory, but its restart blind spot is covered: the boot-time orphan sweep (below) re-enters stale jobIds before croner re-arms.
2. Insert a `cron_runs` row with `status='running'` up front (UI sees it mid-flight); broadcast `cron:run_changed`.
3. Check `job.workspacePath` exists — fail loudly if the workspace was moved/deleted.
4. Spawn `halo cli -a <agent> -s cron-<jobId> -w <workspace>`, prompt on **stdin** (avoids Windows argv length limits). The stable `cron-<jobId>` session id means each fire *resumes the same session*, so the conversation accumulates and is reviewable in the admin Sessions tab. The child's pid is written back onto the `running` row (`cron_runs.pid`, nullable) — this is what makes the orphan sweep possible after a server crash. Note the **dual-writer layout** this creates: the cli child and the server share the workspace's session files. The server side is view-only for these sessions — admin subscribes seed a UIState from disk, and the WS detach-save skips it via the dirty gate (see [session.md](session.md#ws-disconnect-resilience)); without that gate a frozen server snapshot would overwrite the cli child's newer messages (the cron-session UI-log truncation incident). Live streaming of a cli-driven session into the admin is out of scope — events don't cross processes; the Sessions tab re-reads the file on open.
5. Tee stdout + stderr live to `~/.halo/global/logs/cron/<runId>.log`; capture stdout to memory for dispatch. Since 1.1.5 the cli's stdout is the **final reply of the last root turn** as raw markdown (stdout is not a TTY, so no terminal styling; the interim text the model emits before tool calls and the wrap-ups of earlier drained turns are not included — see [session.md](session.md#message-queue-and-drain) "Final-text flag"). Before that it was every streamed text block of the whole run, which for a director session absorbing a dozen sub-agent reports reached ~40 KB and blew the wechat gateway ceiling.
6. Enforce a **per-job timeout** (`job.timeoutSec ?? 3600`, the nullable `cron_jobs.timeout_sec` validated 60–21600 at every write surface; a change takes effect on the job's next fire, no croner re-instantiation needed) via a Node timer (cross-platform, not the Linux-only `timeout(1)`), with a **two-phase kill**: SIGTERM the direct child first — the cli has a SIGTERM handler that stops the harness, repairs + flushes the session, kills its own shell_exec process groups, and exits 143 — then, if it's still alive after a 30s grace, SIGKILL the entire descendant tree (POSIX ppid-walk over one `ps` snapshot; `taskkill /T /F` on Windows) so no grandchild survives to double-write the workspace on the next fire. A ppid walk, not a process-group kill: the cli sandbox spawns shell_exec workers `detached` into their own groups, so `kill(-pid)` would miss them. Timed-out runs still report exit code 124. Generous because overlap-of-the-same-job is already blocked up-front in step 1; this is just the long-stop reaper for a truly stuck child.
7. Classify: exit 124 → `timeout`; non-zero → `failed`; zero but empty stdout → `failed` ("nothing to dispatch" — with the final-only stdout contract this means the last turn produced no wrap-up text, not that the agent never spoke); else `succeeded`.
8. On success only, `dispatchToTargets(stdout, targets, job.workspacePath)` — the raw stdout goes down as-is; `MEDIA:` extraction happens per-target inside the dispatcher (see Dispatch model). If every target fails, downgrade to `failed`.
9. `finalize`: write the terminal `cron_runs` row, update `cron_jobs.lastRun*`, disable one-shot jobs, broadcast. The `_inflight` entry is released in `finally`, regardless of outcome.

The cli executable is resolved via `resolveHaloCli()` (`$HALO_CLI` override; `halo.cmd` on Windows to dodge the GUI `Halo.exe` on PATH).

### Orphan sweep on boot (`sweepOrphanRuns`)

The step-1 guard is per-process, so it has one blind spot: the server dies (SIGKILL, crash) while a cli child is mid-run. On POSIX the child is re-parented and survives; the restarted server has an empty `_inflight` and croner re-arms the schedule — the next fire would double-write the orphan's `cron-<jobId>` session. Per the "persistent operations must not depend on in-memory state" rule, recovery is driven from the db: any `cron_runs` row still at `status='running'` at boot can only be a previous incarnation's leftover (this process hasn't run anything yet).

`startCronDaemon` calls `sweepOrphanRuns` **before** `reloadAll`. For each stale row:

1. Re-enter its jobId into `_inflight` first — the core invariant: while the orphan may be alive, no new cli for that job is spawned (a fire in that window is recorded as `skipped`, same as normal overlap).
2. If the row has a pid (POSIX): **identity-check before killing** — `ps -p <pid> -o args=` must contain the `cron-<jobId>` fingerprint, so a recycled pid never kills an innocent process. Verified → SIGTERM (graceful path, same as timeout phase 1); still alive after a 30s async grace (`unref`ed timer, identity re-checked — pid reuse again) → SIGKILL the descendant tree.
3. No pid / already dead / fingerprint mismatch / Windows: no kill, log only. Windows deliberately marks-only — there's no cheap command-line identity check (WMI is slow and sometimes policy-blocked), and a full-tree `taskkill /T /F` on a reused pid is irreversible while a double-written session is fixable; the orphan-survives-server-death window is also naturally smaller there.
4. Either way the row is finalized as `failed` (`failureReason` notes the orphan disposition, `completedAt` stamped) so the UI stops showing a ghost `running`, and the jobId is released from `_inflight` once the orphan is confirmed dead (or immediately when nothing was killable).

Only the kill grace is asynchronous; the boot-blocking part is one small select + row updates.

## Dispatch model

`dispatcher.ts` is a registry keyed by `channelType`. Each channel ships a `CronChannelDispatcher` inside its own directory and calls `registerCronDispatcher(...)` once at boot — **adding a channel never edits dispatcher.ts**.

```ts
interface CronChannelDispatcher {
  channelType: string
  supportsMedia?: boolean   // true = dispatch actually delivers `media` attachments
  dispatch: (accountId, text, chatId?, media?: CronMedia) => Promise<DispatchResult[]>
  listTargets?: () => CronTargetOption[]
}
```

- `dispatchToTargets` is **never throws** — every target's outcome (ok / error) is captured into a `DispatchResult[]` persisted to `cron_runs.dispatch_results`. One channel being down doesn't block the others.
- **`MEDIA:` attachments**: the runner passes raw stdout down untouched; `dispatchToTargets(rawText, targets, workspacePath)` extracts the agent's `MEDIA:<path>` marker lines once, then decides **per target** (one run can mix both kinds of channel):
  - `supportsMedia: true` (wechat, slack) → marker-stripped text + a `CronMedia { paths, workspacePath }`; the channel sends real file uploads, one `DispatchResult` row per attachment. Both skip the text send when a marker-only run leaves it empty.
  - no `supportsMedia` (telegram, feishu) → the **original text with `MEDIA:` lines intact** — the attachment degrades to a visible path instead of silently vanishing.
  - `CronMedia.workspacePath` is the **job's** workspace (where the run produced its files), not the target account's — it's the sandbox root for `isMediaPathAllowed` (paths outside workspace/OS-tmp are rejected with a failed result row).
  - Wiring telegram/feishu up for real requires refactoring first, not copying: telegram's file send is an inline `sendPhoto/…/sendDocument` switch in `handler.ts`'s responder; feishu's `sendFeishuMedia` is anchored to an inbound `messageId` a cron run doesn't have. Extract the send-to-chat half in the channel module, then flip `supportsMedia: true` (details in each `cron-dispatcher.ts` header).
- **Per-channel size limits are the dispatcher's job**, not the runner's: wechat splits the text at `WECHAT_TEXT_LIMIT` (3500 chars, shared `splitText` from `channels/shared/chunk.ts`) and sends the chunks in order — the ilink gateway rejects any single `sendmessage` over 16 KB with `ret=-2`. A failure on chunk *i* of *n* is recorded as `chunk i/n: <error>` in the target's `DispatchResult`, so the admin run row shows how much of the report already landed (a `failed` row no longer means "nothing arrived"). Telegram still sends one shot (Bot API caps at 4096) — same class of gap, unfixed.
- **`chatId` semantics**: when a job is created from inside a chat, the target pins to that conversation (`chatId` set). When unset, the channel's own fan-out / default-recipient logic decides (e.g. Telegram fans out to its whitelist; Slack/Feishu require an explicit `chatId`).
- `listTargets()` aggregates across all dispatchers (`listAllCronTargets`) to feed the admin create-form dropdown without the routes knowing any channel.

## Retention

- **Runs**: keep newest `RUNS_PER_JOB_KEEP` (100) rows per job; older pruned on each new run via a single `DELETE … NOT IN (SELECT … LIMIT 100)` over the `(job_id, started_at)` index.
- **Logs**: files older than 30 days deleted on a daily timer (db row kept; UI shows "log unavailable"). `cron_runs` rows older than 60 days are also dropped.

## Key files

- `packages/server/src/cron/runner.ts` — scheduler: croner lifecycle, `runJob` spawn/capture/finalize, reconcile, retention.
- `packages/server/src/cron/dispatcher.ts` — channel-agnostic dispatch registry (`registerCronDispatcher`, `dispatchToTargets`, `listAllCronTargets`).
- `packages/server/src/db/cron-db.ts` — `cron_jobs` + `cron_runs` schema, `getCronDb`.
- `packages/server/src/channels/<ch>/cron-dispatcher.ts` — per-channel `dispatch` + `listTargets`.
- `packages/server/templates/skills/cron/SKILL.md` — the agent-facing skill that CRUDs `cron_jobs` (edits the db directly; `reconcileFromDb` picks it up).

## Scope

Supported: recurring (cron expr) + one-shot (`runAt`) schedules; per-timezone; per-job configurable timeout (`timeoutSec`, 60–21600s, default 3600); multi-target fan-out; stable accumulating session per job; run-now (manual trigger); admin UI history with per-run logs + dispatch results.

Not supported: sub-minute schedules below croner's resolution; in-process job execution (always a fresh cli child); conversation context carried *between different jobs* (each job has its own `cron-<jobId>` session).

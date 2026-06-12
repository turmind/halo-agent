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
      ▼                            └──────────────┘ dispatchToTargets(text, targets)
  cron_runs (audit row + log file) ───────────────┘
```

Two halves, cleanly split:
- **runner.ts** — the scheduler. Owns the croner instances, spawns the cli, persists audit rows.
- **dispatcher.ts** — a channel-agnostic registry. Knows how to look up a dispatcher by `channelType` and hand off; knows nothing about any specific channel.

## Scheduling model

Schedules are **durable** — the source of truth is the `cron_jobs` table; in-memory croner state is rebuilt on every server boot (`startCronDaemon` → `reloadAll`). A restart never loses a schedule.

- **Recurring**: standard cron expression (`job.schedule`), optional `timezone`.
- **One-shot**: `job.runAt` (epoch ms) — croner fires once at that instant. After it completes, `finalize` sets `enabled=0` so it never re-fires. A `runAt` already in the past at schedule time is marked `lastRunStatus='missed'` and disabled (rather than firing immediately or retrying every reconcile).

### Hot-reload + out-of-band edits

REST route mutations call `scheduleJob` / `unscheduleJob` directly. But the `cron` skill (and manual ops) edit `cron.db` over a *different* sqlite connection. `reconcileFromDb` (10s timer) catches those:

- Fast path: `PRAGMA data_version` flips only when *another* connection commits. If unchanged since last pass, skip the full select entirely — one pragma read (~µs) vs. a select-all + per-row fingerprint compare.
- On change: diff db rows against the in-memory `_fingerprint` map (`enabled|schedule|runAt|timezone`); schedule new rows, unschedule deleted ones, re-instantiate croner only for rows whose fingerprint changed. Broadcasts a coalesced `cron:job_changed` per affected job.

## Execution (`runJob`)

Each fire:

1. **Concurrency guard**: if the same `jobId` is already running in this process (in-memory `_inflight` set), insert a `cron_runs` row with `status='skipped'`, `failureReason='previous run still in progress'`, broadcast, and bail without spawning. Applies to both scheduled fires and manual run-now clicks. Two overlapping cli children would double-write the same `cron-<jobId>` on-disk session state; SessionManager's per-session lock is in-process and can't see across cli children, so this set is the cheapest place to enforce serialization. Lost on server restart by design — no stale-entry cleanup needed.
2. Insert a `cron_runs` row with `status='running'` up front (UI sees it mid-flight); broadcast `cron:run_changed`.
3. Check `job.workspacePath` exists — fail loudly if the workspace was moved/deleted.
4. Spawn `halo cli -a <agent> -s cron-<jobId> -w <workspace>`, prompt on **stdin** (avoids Windows argv length limits). The stable `cron-<jobId>` session id means each fire *resumes the same session*, so the conversation accumulates and is reviewable in the admin Sessions tab.
5. Tee stdout + stderr live to `~/.halo/global/logs/cron/<runId>.log`; capture stdout to memory for dispatch.
6. Enforce a **3600s timeout** via a Node timer (kills child, reports exit code 124 — cross-platform, not the Linux-only `timeout(1)`). Generous because overlap-of-the-same-job is already blocked up-front in step 1; this is just the long-stop reaper for a truly stuck child.
7. Classify: exit 124 → `timeout`; non-zero → `failed`; zero but empty stdout → `failed` ("nothing to dispatch"); else `succeeded`.
8. On success only, `dispatchToTargets(stdout, targets)`. If every target fails, downgrade to `failed`.
9. `finalize`: write the terminal `cron_runs` row, update `cron_jobs.lastRun*`, disable one-shot jobs, broadcast. The `_inflight` entry is released in `finally`, regardless of outcome.

The cli executable is resolved via `resolveHaloCli()` (`$HALO_CLI` override; `halo.cmd` on Windows to dodge the GUI `Halo.exe` on PATH).

## Dispatch model

`dispatcher.ts` is a registry keyed by `channelType`. Each channel ships a `CronChannelDispatcher` inside its own directory and calls `registerCronDispatcher(...)` once at boot — **adding a channel never edits dispatcher.ts**.

```ts
interface CronChannelDispatcher {
  channelType: string
  dispatch: (accountId, text, chatId?) => Promise<DispatchResult[]>
  listTargets?: () => CronTargetOption[]
}
```

- `dispatchToTargets` is **never throws** — every target's outcome (ok / error) is captured into a `DispatchResult[]` persisted to `cron_runs.dispatch_results`. One channel being down doesn't block the others.
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

Supported: recurring (cron expr) + one-shot (`runAt`) schedules; per-timezone; multi-target fan-out; stable accumulating session per job; run-now (manual trigger); admin UI history with per-run logs + dispatch results.

Not supported: sub-minute schedules below croner's resolution; in-process job execution (always a fresh cli child); conversation context carried *between different jobs* (each job has its own `cron-<jobId>` session).

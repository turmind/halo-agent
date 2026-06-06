# Cron Tasks

Global, cross-workspace scheduled agent runs. The user defines a job
(workspace + agent + prompt + schedule + channel targets); the server
schedules it via croner; on fire, a `halo cli` child runs the prompt;
the captured stdout is fanned out to the bound channels and the run is
recorded in an audit log.

Two trigger modes:

- **Recurring** — standard 5-field cron expression; fires on every match.
- **One-shot (at-mode)** — exact instant via `runAt` (epoch ms); fires
  once at that time, then auto-disables (the row is kept for history /
  rerun, but `enabled=0` so reload doesn't re-instantiate the schedule).
  Same shape as `at(1)`. Picked when the user says "remind me at 3pm",
  "send the report next Monday" — anything that doesn't repeat.

## Goal

Enable scheduled agent work — daily reports, periodic monitoring digests,
one-off reminders, scheduled data refreshes — without leaving a session
open or wiring external schedulers (cron, systemd timers, etc.).

Non-goals:

- **One-off ad-hoc invocations bound to "fresh state" per fire.** Each
  job has a stable `cron-<jobId>` session id; first fire creates it,
  subsequent fires resume it. So history accumulates over time and the
  user can review the full conversation in the admin Sessions tab.
  Threading via `-s cron-<jobId>` lets the agent remember what it told
  the channel last week without each prompt needing to bootstrap from
  `.halo/memory/`.
- **Conditional / event-driven triggers.** Only time-based scheduling.
- **Cross-job orchestration.** Each job is independent.

## Components

### Storage

`~/.halo/global/cron.db` (sqlite + drizzle, parallel to `evo.db`).

```sql
cron_jobs(
  id              TEXT PRIMARY KEY,
  label           TEXT,                  -- nullable
  workspace_path  TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  user_prompt     TEXT NOT NULL,
  schedule        TEXT NOT NULL,         -- 5-field cron; '' for at-mode
  run_at          INTEGER,               -- one-shot fire time (epoch ms);
                                         -- mutually exclusive with `schedule`
  timezone        TEXT,                  -- IANA zone, null = host TZ
  targets         TEXT NOT NULL          -- JSON array of
                                         -- {channelType, accountId, chatId?}
                  DEFAULT '[]',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_status TEXT,                  -- runner-managed cache
  last_run_at     INTEGER,
  last_run_id     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)

cron_runs(
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  trigger_kind     TEXT NOT NULL,        -- 'scheduled' | 'manual'
  status           TEXT NOT NULL,        -- running | succeeded | failed | timeout
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  output           TEXT,                 -- final cli stdout
  exit_code        INTEGER,
  failure_reason   TEXT,
  log_path         TEXT,                 -- absolute path to per-run log file
  dispatch_results TEXT                  -- JSON array of per-recipient outcomes
                                         -- {channelType, accountId, chatId?, ok, error?}
)
```

`run_at` is added in-place to pre-existing dbs via a `PRAGMA table_info`
guard in `createCronDb` (idempotent ALTER) — no manual migration step.

Per-target `chatId` pins delivery to a specific conversation. For
**telegram / slack / feishu** it is required — the dispatchers reject
targets without one (the old "fan out to allowedUsers" / "fall back to
lastActiveChatId" behaviour was removed because in practice the most-
recent inbound was rarely the cron creator, and the result kept landing
in a stranger's chat). For **wechat** it stays optional — wechat has a
QR-bound owner so single-recipient delivery has an obvious target.

Cron jobs created from inside a chat via `/manage-cron-jobs` auto-pin
the originating `chatId` (the channel context exposes it as
`{{channel.chat_id}}`). Admin-UI cron jobs that don't specify a chatId
for tg/slack/feishu run silently — the result shows in the cron log,
nothing is pushed.

Why a separate db: same reasoning as `evo.db` — global, cross-workspace
state shouldn't live inside any one workspace's `.halo/`. The runner
itself is workspace-agnostic.

### Runner — `packages/server/src/cron/runner.ts`

Boot path:
1. `startCronDaemon()` is called from server `index.ts` after
   `setCronDb(...)`.
2. Reads every `enabled=1` row, instantiates a croner schedule per job.
   - Recurring rows: `new Cron(job.schedule, { timezone }, fn)`.
   - One-shot rows (`runAt` set): `new Cron(new Date(job.runAt), …, fn)`.
     croner accepts a `Date` and self-stops after firing once. Past-due
     `runAt` is logged and skipped — the user can still fire via run-now.
3. Starts two timers:
   - `pruneOldLogs` — daily, drops log files past 30-day retention and
     `cron_runs` rows past 60 days.
   - `reconcileFromDb` — every 10 seconds, syncs the in-memory schedule
     map against db rows. Detects adds / removes / schedule / runAt /
     timezone / enabled changes and patches the croner instances
     accordingly. Cheap (small table) and covers out-of-band edits (the
     `manage-cron-jobs` skill writes via `sqlite3` rather than the REST
     API). Per-row fingerprint = `enabled|schedule|runAt|timezone`.

When a fire happens:
1. `runJob(jobId, 'scheduled')` writes a `cron_runs` row with
   `status='running'`.
2. Spawns `halo cli -a <agentId> -s cron-<jobId> -w <workspacePath>` with
   the prompt piped on **stdin** (not argv — a long prompt would overflow the
   Windows command-line limit). A Node timer kills the child after
   `CLI_TIMEOUT_SEC` and reports exit 124 — same contract as the Linux-only
   `timeout(1)` binary, but cross-platform.
   On Windows `resolveHaloCli()` returns `halo.cmd` (not bare `halo`):
   the desktop installer drops `halo.cmd` and `Halo.exe` into the same
   dir on PATH, and PATHEXT ranks `.EXE` above `.CMD`, so a bare `halo`
   would launch the GUI instead of the cli. Spawning a `.cmd` directly is
   rejected by Node ≥21.7 (EINVAL), so the child is routed through
   `cmd.exe /c` on Windows.
   On **macOS** bare `halo` resolves via PATH to the `/usr/local/bin`
   launcher, but a Finder/Dock-launched desktop app has only launchd's
   minimal PATH — so the Electron main process prepends the standard CLI
   dirs to the server child's `env.PATH` (see `dev/desktop-packaging.md`),
   otherwise this spawn would `ENOENT`.
   The `-s` flag uses **create-on-missing semantics** (added alongside
   cron): if the session id already exists in `agent_sessions`, cli
   resumes it; if not, cli creates a new row with that exact id. So the
   first fire bootstraps the session, every subsequent fire continues
   the same conversation, and the user can review history in the admin
   Sessions tab. The `cron-<jobId>` prefix avoids collision with normal
   `cli_*` / `tg_*` / `wx_*` ids.
   Same shape as the evo wrapper (`spawn` + tee'd stdout/stderr to
   `~/.halo/global/logs/cron/<runId>.log`).
3. On exit:
   - Exit 0 + non-empty stdout → `succeeded`, dispatch the trimmed
     stdout to every target.
   - Exit 124 → `timeout`.
   - Anything else → `failed` with stderr tail as `failure_reason`.
   - Empty output on exit 0 → `failed: cli produced no output`.
4. If every target's dispatch failed, downgrade the run status to
   `failed` so the UI surfaces the issue (and so a job that always
   times-out on telegram doesn't keep showing green).
5. **At-mode auto-disable.** `finalize` looks up the row; when `runAt`
   is set, it patches `enabled=0` alongside the lastRunStatus update.
   Reconcile then tears down the croner instance on its next pass.
   The row is kept (so the admin UI shows it under run history; user
   can still hit run-now to refire).

### Dispatcher — `packages/server/src/cron/dispatcher.ts` (registry)

The dispatcher is **channel-agnostic**. It exposes a tiny registry
(`registerCronDispatcher`) and a single fan-out entry-point
(`dispatchToTargets`); each channel module supplies its own
`CronChannelDispatcher` and registers it at server boot. There is no
switch-on-channelType anywhere in `cron/`.

```ts
interface CronChannelDispatcher {
  channelType: string
  dispatch: (accountId: string, text: string, chatId?: string) => Promise<DispatchResult[]>
  listTargets?: () => CronTargetOption[]   // for admin UI dropdown
}
```

`dispatch` returns one `DispatchResult` row per recipient. Today every
channel is single-recipient (one explicit chatId → one row), but the
array shape is preserved so a future channel that supports broadcast
could return N. Throwing wraps into a single failed-result.

Channel modules:

- `packages/server/src/channels/telegram/cron-dispatcher.ts` —
  `registerTelegramCronDispatcher()`. Requires explicit numeric `chatId`;
  errors otherwise. (Previous build fanned out to `allowedUsers` and fell
  back to `lastActiveChatId`; both removed because cron output kept
  landing in unrelated chats.)
- `packages/server/src/channels/wechat/cron-dispatcher.ts` —
  `registerWechatCronDispatcher()`. Single-recipient with chained
  fallback: explicit `chatId` → account `userId` (QR-bind owner) →
  cached `lastActiveChatId`. WeChat keeps the fallback because the
  QR-bound owner is a stable, unambiguous target.
- `packages/server/src/channels/slack/cron-dispatcher.ts` —
  `registerSlackCronDispatcher()`. Requires explicit `chatId` shaped as
  `D…` (DM), `C…` (channel top-level), or `C…:<thread_ts>` (anchored
  inside a thread). Posts via `postMessage` with `thread_ts` set when
  present.
- `packages/server/src/channels/feishu/cron-dispatcher.ts` —
  `registerFeishuCronDispatcher()`. Requires explicit `chatId` shaped as
  `oc_…`. Posts via the v1 messages API with `receive_id_type=chat_id`.
  (A `:rootId` suffix is accepted in the storage shape for forward-compat
  but currently ignored — Feishu's open API has no thread-anchored
  sendMessage path analogous to Slack's `thread_ts`.)

Both register at server boot in `index.ts`. **Adding a new channel = ship
a `cron-dispatcher.ts` next to its handler + register it once.** Nothing
in `cron/` or `routes/cron.ts` needs to change.

`listTargets()` per channel feeds the admin UI's create-form dropdown
via `listAllCronTargets()` (aggregator). `ready` flag: wechat = QR-bind
userId OR cached lastActiveChatId; telegram / slack / feishu always
report `ready=true` (readiness depends on the per-target `chatId` the
admin picks, not on prior inbound history). The admin form has a
per-target chatId input + search dropdown for slack/feishu, backed by
`users.conversations` / `/im/v1/chats`. Channels with no UI-pickable
surface (a hypothetical webhook channel) can omit `listTargets`.

`DispatchResult` shape:

```ts
{ channelType, accountId, chatId?, ok, error? }
```

`chatId` is recorded so the admin UI can render per-recipient outcomes
("slack:T01234/D012345 ✓ · feishu:appA/oc_xxx ✗ (no permission)") when a
job has multiple targets, instead of just a single ok/fail roll-up.

### Realtime updates — WS broadcast (no client polling)

The admin UI subscribes to `cron:job_changed` and `cron:run_changed`
events on the existing `/ws` channel rather than polling on a timer.
Server emits them at every state-change point:

- `runner.runJob` insert of the `running` cron_runs row →
  `cron:run_changed status='running'`
- `runner.finalize` (success/failure/timeout) →
  `cron:run_changed status='succeeded'|'failed'|'timeout'` plus a
  `cron:job_changed` so the list's "last run" badge updates
- REST routes (POST/PUT/DELETE on `/cron/jobs[/:id]`) →
  `cron:job_changed kind='created'|'updated'|'deleted'`

Broadcast is fan-out via `ws/broadcast.ts` to every connected admin
socket. Idle traffic is ~zero.

### REST routes — `packages/server/src/routes/cron.ts`

Standard CRUD over `cron_jobs` plus:

- `POST /api/cron/jobs/:id/run-now` — fire-and-forget; returns
  immediately, run status flips broadcast as cron:run_changed events.
- `GET /api/cron/jobs/:id/runs?limit=N&before=<runId>` — cursor-paged
  history. `runId` is `<isoTimestamp>-<slug>`, so its lexicographic
  order matches time — `id < cursor` gives "older than" without a
  numeric sequence column. Response: `{ runs, hasMore, nextCursor }`.
- `GET /api/cron/runs/:runId/log` — raw log content (or null if past
  retention).
- `GET /api/cron/channel-targets` — the create-form's list of bindable
  channel accounts. Aggregated from the registry via
  `listAllCronTargets()` — routes/cron.ts is channel-agnostic. `ready`
  flag is computed inside each channel's `listTargets()` (see
  "Dispatcher" above for the per-channel rules).
- `POST /api/cron/reload` — force re-read all schedules. Rarely needed
  (reconcile already polls); useful after manual db edits if you don't
  want to wait 10 seconds.

All routes go through the standard auth middleware — same cookie/token
as the rest of `/api`.

### Agent skill — `templates/skills/manage-cron-jobs/`

Registered in `init.ts`'s `BUILTIN_SKILL_IDS`. Frontmatter has
`requiresAccess: full`, so readonly / workspace channels (like a
public-facing telegram bot) can't see or invoke this skill — only
admin-shell agents can. The skill ships with a `manage-cron.py` helper
that the agent calls via `shell_exec`; the script handles id
generation, target JSON encoding, and timestamps so the agent isn't
hand-crafting SQL.

The runner's reconcile loop picks up db changes within ~10 seconds and
broadcasts `cron:job_changed { kind: 'reconciled' | 'deleted' }` so
admin UIs in another tab/browser see the same edit. The skill doesn't
need REST/auth — it's filesystem + sqlite, with the in-process runner
catching up on its own pace.

The skill walks the agent through:
1. Identifying user intent (list / create / edit / delete).
2. Defaulting workspace (current), agent (`default`), targets (current
   chat when invoked from a channel — see channel context below).
3. Translating spoken-time → 5-field cron (recurring) **or** ISO-8601
   instant (`--run-at`, one-shot at-mode).
4. Querying `channels.db` for available targets and surfacing
   readiness warnings (currently only wechat can be `ready=false`).
5. Writing the appropriate INSERT/UPDATE/DELETE.

**Channel context at skill invocation.** When the user runs
`/manage-cron-jobs` from inside a telegram / wechat / slack / feishu
chat, the channel handler injects structured origin into the skill's
render context as built-in placeholders: `{{channel.type}}`,
`{{channel.account_id}}`, `{{channel.chat_id}}`. The skill body uses
these to default the `--targets` flag to `<type>:<account_id>:<chat_id>`
so the schedule keeps replying in the same conversation. Admin/WS
invocations leave the placeholders empty — the skill then either asks
for an explicit chatId or accepts a silent (no-target) cron.

**Reverse-lookup by chatId.** Inside a chat the user doesn't know the
cron `id` ("delete the daily digest I set up here"). The helper script
exposes `list --chat-id <id>` that filters `cron_jobs` to those whose
`targets[].chatId` matches. The skill uses
`list --chat-id {{channel.chat_id}}` to find candidate jobs, confirms
with the user, then deletes by id. Different channels' chatId formats
don't collide (telegram numeric, slack `D…/C…`, feishu `oc_…`,
wechat `o…`), so a single chatId match is unambiguous across channels.

### Admin UI — `packages/admin/src/features/cron/cron-main.tsx`

Activity-bar entry next to Evolution. Two-pane layout matching
Evolution's: list of jobs on the left, detail panel on the right with
run history and edit/run-now/delete actions. Form supports both create
and edit. Form pulls workspace + agent + channel-target options from
existing APIs (`/api/agent-configs`, `/api/cron/channel-targets`).

## Boot

`packages/server/src/index.ts`:
```ts
setChannelDb(channelDb)                              // for dispatcher's getChannelDb()
setCronDb(createCronDb(path.join(HALO_HOME, 'global')))
// `bootChannels` walks `defaultChannelDescriptors` and calls each
// descriptor's `registerCronDispatcher` (alongside its handler/route
// setup). Order is irrelevant — the registry is keyed by channelType.
bootChannels(app, defaultChannelDescriptors, { registry, db: channelDb })
// Daemon starts after channels boot so the registry is fully populated
// before the first scheduled fire.
startCronDaemon()
```

`packages/server/src/init.ts` `BUILTIN_SKILL_IDS` includes
`manage-cron-jobs` so `halo setup` deploys the skill.

## Known limits

- **No mid-run heartbeat.** If the server crashes between the
  `cron_runs.insert(status='running')` and the cli exit handler, the row
  is stranded in `running`. (Evo handles this via heartbeat + ticker
  recovery.) For cron, runs are short (<10 minutes by `timeout`) and
  infrequent; we accept the rough edge for now. Fix: add a daily
  scanner that flips stale-running rows to `failed: server crashed`.
- **Web channel can't deliver.** SSE channel is reactive-only; cron
  records a clear failure rather than swallowing.
- **No retry.** Failed runs stay failed; user sees them in history and
  decides whether to investigate or wait for the next fire.
- **Single-process scheduler.** Two server instances against the same
  global db would both schedule the same jobs. Today there's only ever
  one server per host (pid lock); document & enforce when that
  assumption ever breaks.
- **`run-now` ignores enabled flag.** A disabled job can still be
  fired manually from the UI for testing — the schedule is paused, the
  runner code path isn't.

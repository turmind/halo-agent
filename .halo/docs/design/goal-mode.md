# Goal Mode — Design

In a long agent collaboration the user plays two roles without noticing: the **pusher** (the agent stops after each turn, the user types "continue") and the **evaluator** (the agent says "done", the user checks whether it actually is). Goal mode codifies both so the user can hand them off, keeping only the two things that must not be delegated: **decision authority** (a genuine fork reaches the user and the loop waits) and **final acceptance** (a pass ends the loop with a report the human signs off on).

One invariant drives the whole design:

> **The user's attention may only be consumed by the judge; the worker has no right to stop and wait for the user.**

Core: `packages/server/src/agents/goal-mode.ts` (state, overlay, delivery point, G-only tools, restart sweep) + `packages/server/src/channels/shared/commands.ts` (`/goal` verbs) + `packages/server/templates/agents/goal/` (the judge agent) + `packages/admin/src/features/chat/goal-{banner,store}.{tsx,ts}` (admin surface). Tests: `packages/server/test/goal-mode.test.ts`.

## Architecture: two peer roots

```
  user's chat surface (admin / WeChat / Telegram / Slack / Feishu / Web)
        │  routing OVERLAY while a goal is active: inbound → G;
        │  binding rows / active-session pointers stay untouched
        ▼
┌──────────────────┐    work orders (query_session)     ┌──────────────────┐
│  G  goal session  │ ─────────────────────────────────▶ │  W  worker session│
│  (agent `goal`:   │                                    │  (the session the │
│   intake + judge  │ ◀───────── round reports ───────── │   user was in;    │
│   + dispatcher)   │     (delivery point: code seam)    │   fans out freely)│
└──────────────────┘                                    └───────┬──────────┘
                                                                 ├── executor …
                                                                 └── dev …
```

Both G and W are **root sessions** (`parentId: null`), each visible in the Sessions tab with its own subtree. W is *not* G's child — G is a referee sitting beside the worker, not its owner. The hard invariants (round counting, cap enforcement, edge revocation, report routing) live **in code at the delivery point**; G's LLM owns only verdict quality. LLM softness therefore degrades to fail-stop (loop stalls visibly), never to contract breach (runaway is impossible — continuing requires the lateral edge, which code revokes).

### G — the goal agent

Template `packages/server/templates/agents/goal/` (agent id `goal`, `GOAL_AGENT_ID`). `internal: true` in its yaml hides it from rosters and blocks delegation *to* it, but the id deliberately has **no `__` wrapping** — `isInternalAgent` keys off the underscore pattern, so G's session files stay **workspace-local** (visible in the workspace Sessions tree) instead of landing in `~/.halo/global/internal-sessions/`. Only `/goal create` mints a G session (id `goal_<ts36>`, title `🎯 Goal`). One G per goal; G is single-use — a terminal state seals it (state rule, not deletion: the transcript stays readable) and the next `/goal create` mints a fresh one.

G declares no `team`, so it never gets the standard session-tool bundle; `session-agent-builder` injects the G-only tool set instead (`createGoalTools`, keyed off `GOAL_AGENT_ID` — see [dev/tools.md → Goal tools](../dev/tools.md#goal-tools)).

### W — the worker

The session the user typed `/goal create` in — possibly mid-conversation, possibly fresh (both work, no special casing; it must be a root session and not itself a G). W runs normally and may fan out sub-agents at will. During a run W never talks to the user: work arrives as `[Goal work order · round N/cap]` messages from G, and its wrap-ups return to G as round reports.

## The binding — one datum, three uses

Written by `/goal create`, persisted in the workspace sqlite (never memory-only — survives restarts):

- **G's `agent_sessions` row, `goal` JSON column** (`GoalState`): `{goalId, workerSessionId, status, round, caps: {maxRounds, maxWallMs, maxTokens}, decisionPolicy, createdAt, startedAt, tokenBaseline, specHash, delegatedCount, noProgress, lastReportHash, haltReason}`. `goalId` == G's session id and names the goal dir `<ws>/.halo/goal/<goalId>/`.
- **W's row, `goal_session_id` back-pointer column** — lets the delivery point and the routing overlay resolve with one indexed field read instead of scanning.

Both columns are added via idempotent `ALTER TABLE` in `db/index.ts`. `status` walks `intake → running → paused/halted/done/cleared`; active = `intake | running | paused`. Goals are **serialized per workspace** — `findLatestGoal` makes "the" goal unambiguous, and a second `/goal create` while one is active prints that goal's status instead.

Every state write goes through `writeGoalState`, which persists **and** broadcasts `goal:changed` — a transition can never forget the UI push. Every terminal transition (`done` / `halted` / `cleared`) also clears W's back-pointer (`clearWorkerBackptr`); G's `goal` JSON stays behind as the historical record.

**The overlay, not surgery**: channel binding rows and active-session pointers are never mutated by goal mode. The routing layer consults the goal fields as an overlay; when the goal ends the fields are cleared and the overlay evaporates — nothing needs restoring because nothing was changed.

## Routing overlay (`resolveGoalRoute`)

Given the session a chat surface resolved, return where the inbound user message should actually go:

- W with a goal in `intake` or `running` → **G** (stray chat can never contaminate a round; deliberate steering = talking to G, which folds it into the next work order).
- `paused` → **not diverted**: pause is the manual-takeover escape hatch, the user talks to W directly.
- Terminal states cleared the back-pointer, so they never reach the status check.
- Everything else → unchanged.

Called at every channel's inbound seam: WS `handleChat`, web (SSE), wechat, telegram, slack, feishu. On the admin WS path a divert additionally rebinds the client's event listener to G and emits `session:switched` (same mechanics as a command `switchTo` — see [ws.md](ws.md#switchto-rebind--sessionswitched)).

## The delivery point (`deliverGoalRound`)

The single code seam of the feature. `runSession`'s `finally` runs `tryReportToParent → deliverGoalRound → releaseSession` — the goal check sits exactly where sub-agent auto-report sits, but for goal-bound roots (fire-and-forget; a cheap `goal_session_id` field read makes it a no-op for everyone else).

Gates, in order:

1. Root only (`parentId === null`), row carries `goalSessionId`, goal status is `running`.
2. **Subtree-quiet gate** (inherited from `tryReportToParent`): no active children in the db **and** an empty message queue. A W that dispatched executors and idled while they run does NOT end the round — their reports wake W first.
3. **Spec tamper gate**: sha256 of `GOAL_SPEC.md` must equal the `specHash` stamped at attach. Changed or missing → halt (`spec-tampered`), back-pointer cleared, G instructed to write a halt diagnosis. Never silently restore.
4. **Question-stop**: a report containing `<NEED_INPUT>` is delivered with a question-stop header and consumes **neither** the round counter nor the no-progress budget — the worker is waiting, not failing. G triages: answerable from spec + scene → `goal_decide` + relay; genuine user-sovereignty fork → park to the user.
5. **Round accounting**: `round++`; `noProgress` increments when the report hash is unchanged from last round, else resets (a deterministic proxy for hard-stuck — semantic no-progress is G's judging duty).
6. **Guardrails** — plain counters checked in code:

| Guardrail | Default | Trips when |
|---|---|---|
| Max rounds | 10 | `round >= caps.maxRounds` |
| Wall time | 4h | `now − startedAt > caps.maxWallMs` |
| No-progress breaker | 3 | 3 consecutive byte-identical reports |
| Token budget | off unless set at attach | W's `totalOutputTokens − tokenBaseline > caps.maxTokens` (G's own consumption is not metered) |

Breach → `halted` + `haltReason`, back-pointer cleared (**revoking the lateral edge** — G's further `query_session` calls are rejected in code), and the report is delivered under a `[Goal HALTED: …]` header instructing G to produce a halt diagnosis instead of more work.

7. Normal path: state persisted, report delivered to G via `querySession` under the deterministic header `[Goal round N/10 · elapsed 1h12m · no-progress 0/3]`. The body is capped at `limits.autoReportMax` (8,192 default) with a truncation marker pointing G at `get_session_output` — same convention as the sub-agent auto-report.

A fifth cap is enforced inside the tools rather than the delivery point: **delegated decisions** (G-answered forks) are capped at 5 per goal by `goal_decide`.

## G-only tools

Injected only for the `goal` agent; schemas in [dev/tools.md → Goal tools](../dev/tools.md#goal-tools). Every callback **re-reads goal state from the db** — never a cached copy — so a halt / pause / clear that landed while G was mid-turn is enforced on its very next tool call.

- `goal_context` — read the binding + counters. During `intake` it also embeds `workerRecent`: the worker's last 20 non-empty user/assistant messages (transcript `role=system` noise skipped), each truncated to 400 chars, 8K chars total budget applied newest-first, plus `workerMessageCount`. This is how G seeds the intake conversation without the user re-explaining — and without parsing a 150 KB session JSON (the dogfood failure that motivated embedding it). Running goals don't embed it; G works off delivered round reports.
- `goal_attach` — the hinge from intake conversation to running loop, callable from any channel (no button). Preconditions: status `intake` + `GOAL_SPEC.md` written. Stamps the spec hash, records W's token baseline, applies cap overrides pinned during intake, flips to `running`, and dispatches the round-1 kickoff to W.
- `goal_decide` — records a delegated decision as `decision-<n>.md` in the goal dir *before* relaying the answer; counts against the cap of 5.
- `goal_finish` — final acceptance: `running → done`, dissolves the binding; G then writes the final report as its reply (which must list every delegated decision).
- `query_session` (goal-scoped) — the lateral edge: only the bound worker is reachable; only while `running`; a `[Goal work order · round N/cap]` header is prepended in code.
- `get_session_output` (goal-scoped) — read the full latest-turn output of W or any session in W's tree (evidence gathering); works regardless of goal status.

## `/goal` verbs

All five verbs are builtin deterministic code (`SUBCOMMAND_ROUTES`, no backing skill) and **all gated `requiresAccess: full`, including `status`** — user ruling: goal mode drives an autonomous multi-round loop (dispatches work that writes files, runs shell checks, burns model budget), so no verb belongs to workspace-level callers. See [requirements/command.md](../requirements/command.md).

- `create [description]` — refuses while a goal is active (prints its status); the current session must be a root and not itself a G. Mints G, writes both halves of the binding, creates the goal dir, and kicks G's intake. The kick (and the user's inline description) is **persisted to G's UI transcript before dispatch** (`appendUserMessage` then `sendUserMessage`, mirroring the channel inbound path) — `sendUserMessage` alone feeds only the LLM context, which left G's transcript opening with tool noise after a reload. Returns `switchTo: G` so the surface lands in the intake conversation.
- `status` — prints the latest goal (any state) from the db: status, round/cap, elapsed, no-progress, delegated count, both session ids, halt reason if any.
- `pause` — running → paused, then **interrupts the whole formation**: `stopSession(W)` (cascades to W's subtree) + `stopSession(G)`. Status is written *first* so the aborted worker's own `finally` sees `paused` at the delivery point and skips the round. A worker left running would report later and re-kick a loop the user thought was dead.
- `resume` — paused → running, nudges G (append-then-send, same as create) to re-read spec + transcript and re-dispatch; returns `switchTo: G`.
- `clear` — any active state → `cleared`, back-pointer dropped, W + G stopped. The surface returns to W; the goal record stays on G's row as history.

## Deletion cascade (`dissolveGoalBindingsFor`)

`SessionManager.deleteSession` calls it with the full doomed-id list **before** the rows are removed — the goal record lives on G's row, so this is the last moment it can be read. Queries the db directly, never in-memory state:

- **Deleting G**: clear W's dangling back-pointer (otherwise the 🎯 badge and the overlay's field check would outlive the goal) and broadcast `goal:changed` with `status: 'cleared'` — G's row *was* the banner's data source, so no `writeGoalState` is possible or needed.
- **Deleting W**: mark the surviving G's goal `cleared` via `writeGoalState` (which broadcasts) — a goal without its worker is over; a stale `intake`/`running` record would keep the banner up forever.
- Terminal goals already dropped their back-pointer at the terminal transition — nothing to do.

## Restart semantics (`sweepActiveGoals`)

Continuation over death-handling: in-flight promises die with the process, goal state survives in the db. The SessionManager constructor (gated on `reconcileOrphansOnBoot` **and** the `.halo/runtime.lock` workspace claim — same ownership gate as the orphan reconcile) sweeps every goal at status `running` and delivers a deterministic nudge to G: *"server restarted, the in-flight round was lost; call goal_context, re-read GOAL_SPEC.md and your own transcript, re-dispatch."* Counters and caps were already in the db, so nothing is forgotten. `intake` needs no nudge (the user drives it); `paused` / `halted` / terminal goals stay put — a user-initiated pause still requires an explicit `/goal resume`.

## Admin surface & WS

- **`goal:changed`** is broadcast on every `writeGoalState` (and on the G-delete dissolve path) with `{goalSessionId, workerSessionId, status, round, maxRounds}`. The broadcast is **server-global with no workspace marker**; the admin re-fetches through the seed endpoint under its active project, which naturally filters cross-workspace events. See [ws.md](ws.md).
- **Seed endpoint** `GET /api/sessions/goal?projectId=` restores banner/lock state after a page reload (`cleared` returns `null` — a dismissed record, not a displayable state). See [dev/api.md](../dev/api.md#get-apisessionsgoalprojectidabs).
- **Banner** (`goal-banner.tsx`): workspace-level strip above the composer — intake / running (`round N/max`) / paused / halted / done states. Label click jumps to G, a `Worker →` button jumps to W (client-side navigation only); terminal states are dismissible, active ones are not (the lock they explain is still in force). Dismissal persists per-project in `localStorage` (`halo_goal_dismissed_<projectId>`) so it survives a page refresh; a new goal has a different `goalSessionId`, so the id-equality check naturally un-suppresses the banner for it.
- **Input lock** (`message-input.tsx`): while the open session is the bound worker of an `intake`/`running` goal, plain chat is blocked (the overlay would divert it anyway — typing there is misleading); slash commands still dispatch (`/goal pause · status · clear` are exactly what you'd run from there). Paused lifts the lock.
- **🎯 badge**: session lists render it off the `goalSessionId` field in `GET /api/sessions/logs` rows.
- **`switchTo` rebind**: `/goal create` / `resume` return `switchTo: G`; the WS handler rebinds the client's event listener and emits `session:switched`; the frontend then re-subscribes to get a disk-seeded snapshot so G's existing transcript renders. Details in [ws.md](ws.md#switchto-rebind--sessionswitched).

## Storage

No new database, no new files beyond the goal dir:

- G's `agent_sessions` row → `goal` JSON column; W's row → `goal_session_id` back-pointer.
- `<workspace>/.halo/goal/<goalId>/` — `GOAL_SPEC.md` (the contract; hash stamped at attach, tamper-checked every delivery) + `decision-<n>.md` per delegated fork. Verdicts live in G's session transcript (they're its replies).

## Design evolution

This document describes the shipped terminal state only. The full design rationale — the v1 (detached wrapper / goal.db) and v2 (in-session stop-gate) post-mortems, the "why an LLM loop-driver is acceptable" argument, judging-discipline details, and the user rulings from review — is archived in `docs/plans/loop-mode.md` (local-only, maintainer checkouts).

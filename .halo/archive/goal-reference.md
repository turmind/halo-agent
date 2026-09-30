# Goal Mode — Reference (archived)

> **Archived — not a current feature doc.** Goal mode's entry points are hidden and disabled by default; see [goal-mode.md](goal-mode.md) for the original design. This file preserves the tool / API / command / UI usage sections that used to live in `dev/tools.md`, `dev/api.md`, `requirements/command.md` and `requirements/chat.md`, verbatim except for link targets. Nothing here is bundled into the public docs.

## `/goal` command (was `requirements/command.md`)

Table row:

| Command | Verbs (access) |
|---|---|
| `/goal` | create \[description\] / status / pause / resume / clear — all built-in, **all full** (no skill fall-through; the `goal` agent is internal, not a skill). |

### `/goal` verbs

All five verbs are gated `requiresAccess: full` — **including `status`** (user ruling): goal mode drives an autonomous multi-round loop (the goal session dispatches work orders that write files, run shell checks, and burn rounds of model budget), so no verb is exposed to workspace-level callers.

- `create [description]` — start goal intake on the current session (which becomes the worker; must be a root session and not itself a goal session). Refuses while a goal is active — goals are serialized per workspace — printing the active goal's status instead. Returns `switchTo` to the new goal session so the surface lands in the intake conversation.
- `status` — print the latest goal (any state): status, round/cap, elapsed, no-progress counter, delegated decisions, both session ids, halt reason if any.
- `pause` — running → paused, then stop the worker (cascading to its subtree) **and** the goal session. Paused lifts the routing overlay: the user talks to the worker directly (manual takeover).
- `resume` — paused → running, nudges the goal session to re-read spec + transcript and re-dispatch; returns `switchTo` to the goal session.
- `clear` — tear down the binding from any active state; worker + goal session stopped, surface returns to the worker. The goal record stays on the goal session's row as history.

## Goal-mode banner (was `requirements/chat.md`)

When a goal is bound to the current session (see [command.md → `/goal`](goal-reference.md) / [design/goal-mode.md](goal-mode.md)), a strip above the composer shows status (intake / running round N/max / paused / halted / done); a label click jumps to the goal session, a `Worker →` button jumps back to the worker. Terminal states (done/halted) are dismissible — dismissal persists per-project in `localStorage` so it survives a page refresh; a new goal gets a different id and un-suppresses automatically. Active states (intake/running/paused) are not dismissible while the lock they explain is still in force.


The session sidebar rows also rendered a 🎯 badge off the `goalSessionId` field of `GET /api/sessions/logs` rows.

## `GET /api/sessions/goal` (was `dev/api.md`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions/goal?projectId=` | Latest goal binding for the workspace (goal-mode banner / input-lock seed) |

### GET `/api/sessions/goal?projectId=<abs>`

Source: `packages/server/src/routes/sessions.ts` (`findLatestGoal` in `agents/goal-mode.ts`)

Latest goal binding for the workspace — goals are serialized per workspace, so "the" goal is unambiguous. Refresh seed for the admin's goal banner / worker input lock: `goal:changed` WS pushes keep a live tab current, this endpoint restores state after a page reload. Returns `{ "goal": null }` when there is no goal or the latest one is `cleared` (a dismissed record, not a displayable state). See [design/goal-mode.md](goal-mode.md).

```json
// 200
{
  "goal": {
    "goalSessionId": "goal_mabc123",
    "workerSessionId": "sid_abc",
    "status": "running",        // intake | running | paused | halted | done
    "round": 3,
    "maxRounds": 50
  }
}
```

## Goal tools (was `dev/tools.md`)

Injected **only** for the built-in `goal` agent (G) — `session-agent-builder` swaps in this set (`buildGoalTools`, `agents/goal-mode.ts`) instead of the standard session bundle when the session's agent is `GOAL_AGENT_ID`. Every callback re-reads goal state from the workspace db (never a cached copy), so a halt / pause / clear that landed while G was mid-turn is enforced on its next tool call. See [design/goal-mode.md](goal-mode.md).

### goal_context

Load the goal binding: worker session id, goal dir, `GOAL_SPEC.md` path, caps, status, round, counters (`delegatedCount`/cap, `noProgress`, `startedAt`/`elapsed`). No arguments. Call first in every conversation and after any restart nudge.

During `intake` the result also embeds `workerRecent` — the worker's last 20 non-empty user/assistant messages (transcript `role=system` noise skipped, 400 chars each, 8K total budget applied newest-first) plus `workerMessageCount` — so G seeds the intake conversation without parsing transcript files. Running goals don't embed it (G works off delivered round reports; embedding on every call would burn tokens).

### goal_attach

The hinge from intake conversation to running loop. Preconditions: status `intake` and `GOAL_SPEC.md` written to the goal dir (missing → error naming the expected path). Stamps the spec sha256, records the worker's output-token baseline, applies cap overrides, flips to `running`, and dispatches the kickoff to the worker under a `[Goal work order · round 1/N]` header. Call exactly once, only after the user confirms the contract.

| Arg | Type | Required | Description |
|---|---|---|---|
| `kickoff` | string | yes | Round-1 work order, sent verbatim (header prepended by the platform) |
| `caps` | object | no | Overrides pinned during intake: `max_rounds` / `max_hours` / `max_tokens`; omitted fields keep defaults (10 rounds / 4h / no token budget) |
| `decision_policy` | string | no | One-line record of what kinds of forks the user delegated |

### goal_decide

Record a delegated decision — a fork G answered on the user's behalf because spec + scene made the answer clear. Writes `decision-<n>.md` to the goal dir **before** the answer is relayed; counts against a cap of 5 per goal (cap reached → error telling G to park the question to the user). Only while `running`.

| Arg | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | The fork the worker raised |
| `decision` | string | yes | What G decided |
| `rationale` | string | no | Why the contract/scene supports it |

### goal_finish

Final acceptance: `running → done`, dissolves the binding (clears the worker's back-pointer; the chat surface returns to the worker). G then writes the final report as its reply — it flows to the user and must list every delegated decision.

| Arg | Type | Required | Description |
|---|---|---|---|
| `summary` | string | yes | One-line result recorded in the goal state |

### query_session (goal-scoped)

G's **lateral edge**: same name as the standard session tool, different implementation — only the bound worker is reachable, only while `running` (any other status → `lateral edge revoked`), and a `[Goal work order · round N/cap]` header is prepended in code. Halting a goal revokes this edge, which is what makes runaway impossible.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Must be the bound worker session id |
| `message` | string | yes | The work order / relayed answer / steering update |

### get_session_output (goal-scoped)

Read the full latest-turn output of the worker or any session in the worker's subtree (evidence gathering — round reports are truncated at `limits.autoReportMax`). Scoped to the worker's tree; works regardless of goal status. Same `{ code, status, output, last_activity_at }` shape and tail-keeping truncation as the standard [get_session_output](../docs/dev/tools.md#get_session_output) — the goal wrapper only adds the tree check and passes `host.getSessionOutput` through.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Worker session id or a descendant (`worker>child`) id |

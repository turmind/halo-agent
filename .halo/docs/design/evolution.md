# Self-Evolution — Design

Let agents draft and validate improvements to their own prompt surface by learning from conversations.

## Architecture

```
                  /evo or pre-compact hook (user action)
                            ↓
                    enqueueEvoRun() (sync)
         mkdir runs/<id>/, snapshot source session + prompt surface
                            ↓
              evolution_runs: id → 'pending'
                            ↓
              server ticker (every 30s, stateless)
                   mark timeouts, spawn wrappers
                            ↓
      wrapper (detached Node process, per run/apply)
   ┌────────────────────────────────────────────────┐
   │   Phase A: __evo_agent__ drafts patch.md        │
   │   Phase B: wrapper dry-runs patched sandbox      │
   │   Phase C: __score__ rates lint/behavior/scope   │
   │                                                 │
   │   (Phase A'/B'/12 for apply: merge+regress+sync) │
   └────────────────────────────────────────────────┘
                            ↓
         evolution_runs: id → 'awaiting_review'
                   ↓ (admin approves)
         evolution_applies: id → 'pending'
                            ↓ (ticker spawns apply wrapper)
              wrapper merges patches, regress-tests
                            ↓ (phase 12 sync to main)
           evolution_applies: id → 'applied'
                evolution_runs: id → 'applied'
                            ↓
         SessionManager cold-start picks up new prompts
              next user message uses patched rules
```

All coordination via global db (`~/.halo/global/evo.db`). Wrapper heartbeats every 60s; ticker marks `running` → `timeout` if stale. Detached process model: server restart doesn't kill in-flight wrappers.

## Trigger and Enqueue Flow

### `/evo [hint]` (slash command)

User in chat:
```
/evo                        # evo runs on current root session
/evo answer is too verbose  # hint for what to focus on
```

Server flow (synchronous, ~10ms):

1. Refuse if user is not `full` access (not gated on `evolution.level`).
2. Resolve root session id (must be `parentId === null`).
3. Call `enqueueEvoRun()` from `/packages/server/src/evolution/enqueue.ts`:
   - mkdir `<ws>/.halo/evo/runs/<id>/`
   - Write `source-snapshot.json` (frozen `session.agent.messages`)
   - Write `tool-flow.md` (tool_result-stripped Markdown view for skimming)
   - Write `meta.json` (metadata: runId, triggerKind, sourceSession, userHint, createdAt)
   - Write `evo-context.json` (snapshot of prompt surface at trigger time: assembled system prompt, all prompt files, agent/skill listings)
4. INSERT `evolution_runs` row with `status='pending'`, `trigger_kind='note'` (internal trigger id keeps the old name; only the user-visible command was renamed to `/evo`).
5. Reply via `chat:system`: "📝 Queued for evaluation".

`evo-context.json` is authoritative state — the wrapper packs it into agent briefs verbatim, so evo/scorer never need `file_read` to inspect system-prompt files.

### Pre-compact hook

Inside `SessionManager.compactSession()`, **before** the compression LLM rewrites `session.agent.messages`:

1. Same checks (level=L1, root session, non-readonly user).
2. Snapshot the current messages → `enqueueEvoRun()` with `trigger='pre-compact'`.
3. INSERT `evolution_runs` row.
4. Continue with normal compact.

Order matters: snapshot first, compact second. Otherwise evo sees the already-compacted (summarized) message log, losing detail it should learn from.

## Ticker — Stateless Scheduler (every 30s)

Located: `/packages/server/src/evolution/ticker.ts`

Three jobs per pass:

1. **Mark timeouts**: `running` rows with heartbeat older than `runTimeoutMinutes` → `timeout`. Retry rows with `attempts < maxAttempts` back to `pending`; exhausted rows → terminal `timeout`.
2. **Start runs**: count current `running`, claim `pending` runs (oldest first, up to slot budget), spawn `evo-wrapper.js --mode=run --id=<X>`.
3. **Start applies**: same shape, but with per-workspace mutex (only one apply per workspace at a time, since apply reads **current** main to build sandbox).

Restart-safe: no in-memory state. On server reboot, ticker re-evaluates db on first tick — stale `running` rows timeout, pending rows continue to be picked up. Applies can resume mid-publish if they were in `syncing` state (heartbeat timeout was mid-phase-12).

## Wrapper Orchestration — Mode=Run (3-phase model)

Located: `/packages/server/src/evolution/evo-wrapper.ts` (compiled to `.js`, spawned by ticker)

The wrapper is the orchestrator; individual agents do focused work only. Every phase spawns a **fresh** cli session (`-n`) — no message history is inherited. The source conversation reaches evo/score as disk files (`tool-flow.md` for a fast skim, `source-snapshot.json` for the full record), with inline base64 images decoded to `images/` so the agents can `view_image` them; the briefs direct agents to write run-dir artifacts (patch.md, .skip.md, score.json) with absolute paths because relative tool paths resolve against the sandbox.

### Phase A — Draft

`spawn('halo', ['cli', '-a', '__evo_agent__', '-n', '-w', '<runDir>/sandbox', '<draft-brief>'])`

Agent writes:
- `patch.md` — Markdown with YAML frontmatter + body. Frontmatter includes `testScenario: { agentId, testMessage, originalMessage }` and `target: .halo/<path>`.
- One new file at `<runDir>/sandbox/.halo/<target>` with full patched contents.
- OR `.skip.md` (one-sentence reason) if no patch is worth proposing.

The `target` can be any file in the prompt surface — `INSTRUCTIONS.md`, the agent's `AGENT.md` / `agent.yaml`, a `skills/<id>/SKILL.md`, `prompts/<scope>/`, `INDEX.md` — routed by which file *owns* the failure (skill misuse → that SKILL.md, capability/model gap → agent.yaml, persona/scope → AGENT.md, cross-cutting rule → INSTRUCTIONS.md). AGENT.md carries the routing table; this de-biases the drafter from defaulting to INSTRUCTIONS.md just because its full text sits in the brief.

Sandbox is whitelist-cp from main workspace (only: `INSTRUCTIONS.md`, `INDEX.md`, `USER.md`, `agents/`, `prompts/`, `skills/`, `docs/`). Agent reads via `file_read`, writes only to `.halo/` subset.

### Phase B — Dry-run + Fix Loop

```
timeout 600 halo cli -a <patch.testScenario.agentId> -n -w <runDir>/sandbox \
  --access workspace <patch.testScenario.testMessage>
```

`--access workspace` masks `~/.aws`, `~/.ssh`, etc. (safety: test probe's behavior, not side effects).

Outcome:
- **Success** (exit 0 + non-empty stdout): save to `dry-run-output.txt`, proceed to phase C.
- **Failure**: save log, re-spawn `__evo_agent__` in fix mode with failure log inline. One corrective pass only (`FIX_BUDGET = 1`). If fix also fails, mark `failed` with reason "dry-run never succeeded".

Fix budget design:
- Two-pass (original + one fix) covers common failure modes (bad YAML, scope-too-aggressive test scenario).
- More loops look like old "edit prompt and retry" anti-pattern. If a patch needs >1 fix, reject it.

### Phase C — Score

`spawn('halo', ['cli', '-a', '__score__', '-n', '-w', '<runDir>/sandbox', '<score-brief>'])`

The score brief packs patch.md + dry-run-output.txt + meta.json + evo-context.json inline; the baseline conversation stays on disk (`tool-flow.md` / `source-snapshot.json`) and the brief directs the scorer to `file_read` it so behavior is graded against the actual baseline. Writes `score.json`:

```json
{
  "lint": 90,
  "behavior": 75,
  "scope": 80,
  "confidence": "high",
  "avg": 82,
  "notes": "…"
}
```

Dimensions (0-100, anchored at 50="neutral"):
- **lint**: patched files load cleanly (YAML valid, cross-refs resolve).
- **behavior**: dry-run output better than original assistant reply (baseline).
- **scope**: surgical (100) vs sweeping (0).
- **confidence**: scorer's own confidence (independent of numeric scores).

`avg = round((lint + behavior + scope) / 3)` — single sort key for admin UI.

Scorer is read+write only (`file_read` / `file_write` / `file_list` / `grep` / `glob`); no execution / no shell. Outputs only `score.json`. Same scorer agent reused at apply time (phase B') as regression gate.

## Wrapper Orchestration — Mode=Apply (merge + regress + sync)

After user approves N runs in the admin UI, `evolution_applies` row created with `status='pending'`.

### Phase A' — Merge

Wrapper builds **fresh sandbox** (whitelist-cp from **current main** workspace), then:

`spawn('halo', ['cli', '-a', '__apply_agent__', '-n', '-w', '<applyDir>/sandbox', '<merge-brief>'])`

Agent reads each source run's `patch.md` (latest version!), merges changes into sandbox. Respects platform override matrix (workspace replaces global wholesale for agents/, skills/, prompts/). Agent writes `apply.log` (audit trail), edits only under `sandbox/.halo/`.

**Success criteria** (checked in order):
1. cli exit code ≠ 0 → fail (`apply cli exited <code>`).
2. `<applyDir>/ABORT.md` exists → fail (`apply agent aborted: <first line, ≤300 chars>`). ABORT.md is the agent's only abort channel — the cli always exits 0 when the agent finishes a turn, so "exit non-zero on conflict" is not something an agent can do. On an irreconcilable merge conflict (or another dead end) it writes the diagnosis to ABORT.md; the wrapper checks the sentinel **before** the apply.log gate, so a conflicted merge can't publish just because apply.log also exists.
3. `apply.log` missing → fail (`apply agent didn't produce apply.log` — the agent likely bailed early).

The wrapper clears any stale ABORT.md (from a crashed previous attempt) at the start of the phase, before spawning the agent — otherwise a leftover sentinel would insta-fail the new attempt.

### Phase B' — Regress

For each source_run_id:

1. Read `testScenario` from source run's `patch.md`.
2. Run `timeout 600 halo cli -a <agentId> -n -w <applyDir>/sandbox <testMessage>` against merged sandbox.
3. Spawn `__score__` with regress-mode brief, write `regress/<runId>/score.json`.
4. Any score with `lint < 50` or `behavior < 50` → regression, abort with `failed`.

### Phase 12 — Final Sync (checkpointed)

Three substeps, two of them checkpointed:

1. **Preflight** (idempotent): walk sandbox, diff against main, snapshot pre-apply files to `history/apply-<id>/` with `MANIFEST.json`.
2. **Checkpoint**: set `evolution_applies.status='syncing'`. From here on, if wrapper crashes, ticker recovery resumes at step 3 (skip A'/B'/preflight to avoid re-running LLM phases).
3. **Publish** (dangerous): cp each changed file from sandbox to main.
4. Mark source_runs `applied`, finalize apply row `applied`.

Per-workspace mutex in ticker prevents two applies from racing on the same workspace — the assumption phase 12 leans on.

## Data on Disk

```
<ws>/.halo/evo/
  runs/<id>/
    meta.json                 # run metadata
    source-snapshot.json      # frozen session.agent.messages
    tool-flow.md              # tool_result-stripped Markdown skim
    evo-context.json          # prompt surface snapshot (from enqueue)
    images/<msgIdx>-<blockIdx>.<ext>  # decoded base64 images
    patch.md                  # __evo_agent__ writes (has testScenario frontmatter)
    .skip.md                  # evo wrote this → no patch proposed
    score.json                # __score__ writes (lint/behavior/scope/avg)
    dry-run-output.txt        # stdout from phase B dry-run
    dry-run-fail-<n>.log      # failure logs from dry-run attempts
    sub-cli.log               # tee'd stdout+stderr of every halo cli spawn
    sandbox/                  # working copy; .halo/ is whitelist-cp of main
  applies/<id>/
    meta.json
    sandbox/                  # cp from main at phase A', edited by agent
    apply.log                 # agent audit trail
    ABORT.md                  # apply agent's abort sentinel (merge conflict
                              # diagnosis; first line becomes failureReason)
    regress/<runId>/          # one per source run
      dry-run-output.txt
      score.json
  history/apply-<id>/         # rollback snapshot (NOT archived)
    MANIFEST.json             # which paths were overwritten
    <files>                   # pre-apply content
  archive/
    run-<id>.zip              # zipped after 14 days in terminal state
    apply-<id>.zip
```

`evo-context.json` format:

```json
{
  "agentId": "default",
  "assembledSystemPrompt": "<full text or null>",
  "promptFiles": [
    { "scope": "workspace", "path": "INSTRUCTIONS.md", "content": "..." },
    { "scope": "global", "path": "agents/default/AGENT.md", "content": "..." },
    ...
  ],
  "agents": [{ "id": "default", "scope": "global" }, ...],
  "skills": [{ "id": "tool-read", "scope": "global" }, ...]
}
```

Skill content NOT inlined (too large at scale); only listings. Both agents and skills include a `scope` tag (`workspace` | `global` | `builtin`).

## Archive and Retention

Located: `/packages/server/src/evolution/archive.ts`

Two-stage lifecycle (both orthogonal to `status`):

- **14 days after terminal status** (applied/rejected/skipped/failed/timeout): zip the run/apply dir to `archive/{run|apply}-<id>.zip`, delete original, set `archived_at = now()`. DB row stays.
- **30 days after `archived_at`**: delete zip and DB row outright.

Active rows (pending/running/awaiting_review/approved/syncing) never archived. `history/apply-<id>/` (rollback tree) never archived — kept cheap and discoverable.

Archive daemon runs at server boot (1 min delay) + daily. Idempotent.

## Integration with SessionManager

Each evo/score/apply agent is flagged `internal: true` in `agent.yaml`. SessionManager skips loading workspace platform prompts (USER.md, INSTRUCTIONS.md, INDEX.md, prompts/all|root|bootstrap) for internal agents — only their own AGENT.md + wrapper brief reaches the LLM. Reduces token cost and removes workspace-rule bleed-through.

After apply publishes to main, **no explicit session-release step needed**. SessionManager evicts every session from the in-memory cache as soon as its message turn finishes (`runSession`'s finally block: `saveAgentState` + `Map.delete`). Next message → `ensureSession` → `buildAgentInstance`, which re-reads `agent.yaml`, `INSTRUCTIONS.md`, `USER.md` from disk. So new prompts kick in on next turn for free; currently-running turns finish on old prompts (deliberate — aborting mid-conversation is worse than a few seconds of old rules).

## Key Files and Their Roles

| File | Lines | Purpose |
|---|---|---|
| `/packages/server/src/evolution/enqueue.ts` | 403 | Snapshot session + prompt surface at trigger time. Write runDir/, INSERT evolution_runs. Both `/evo` and pre-compact hook call this. |
| `/packages/server/src/evolution/ticker.ts` | 496 | Stateless 30s scheduler. Mark timeouts, claim pending, spawn wrappers. Per-workspace apply mutex. Broadcast status changes to admin UI. |
| `/packages/server/src/evolution/spawn.ts` | 36 | Real spawner: detached Node child running evo-wrapper.js. Override-able for testing. |
| `/packages/server/src/evolution/evo-wrapper.ts` | 2000+ | Wrapper orchestrator. 3-phase run mode (draft/dry-run/score). Apply mode (merge/regress/publish). Heartbeat every 60s. Handles Windows command-line limits via stdin briefs. |
| `/packages/server/src/evolution/archive.ts` | 275 | Archive job: 14d → zip + delete, 30d → purge. Runs daily + at boot. Idempotent. |

## Sandbox Model

Both run-mode and apply-mode spawn `halo cli -w <sandbox>`, never the real workspace. Sandbox is whitelist-cp of main (only prompt files + structure):

```
SANDBOX_WHITELIST = ['INSTRUCTIONS.md', 'INDEX.md', 'USER.md', 'agents', 
                      'prompts', 'skills', 'docs']
PUBLISH_WHITELIST = above minus 'docs'  # docs only for reference, not in prompts
```

Session rows, db, logs, memory — all intentionally excluded from sandbox. Avoids pollution and lets archive job sweep up all evo artifacts when retention fires.

## Settings Schema

```yaml
general:
  language: en-US          # BCP-47; also used for evo/score output language
  evolution:
    level: L0              # L0=disabled, L1=enabled
    max_concurrent_run: 1
    max_concurrent_apply: 1
    run_timeout_minutes: 12
    apply_timeout_minutes: 5
    max_attempts: 3        # retry budget per run/apply
    triggers:
      pre_compact: true
```

L0 = manual drafting only (`/evo`); L1 also enables pre-compact triggering. Defaults conservative; tune if machine handles more.

## Admin UI Integration

Top-level "Evolution" tab shows:

- **List**: evolution_runs + latest apply per run. Sortable by created_at / status / score.avg. Filterable by status. Joins runs+applies to show consolidated view.
- **Detail**: patch.md, score.json, test scenario, assembled brief context, diff against current target.
- **Approve**: Opens dialog, optional reviewer_hint. Creates evolution_applies row.
- **Reject**: Sets status='rejected'.
- **Retry**: Resets row to pending, requires new hint. Allowed from any terminal status except `applied`.
- **Manual Delete**: Removes artifacts (live dir + archive zip, whichever exists) + DB row immediately. Blocked on active rows (pending/running/approved/syncing).

Realtime updates via WebSocket (`evolution:run_changed`, `evolution:apply_changed` events). REST mutations broadcast directly; wrapper state changes broadcast at each ticker tick (15-30s latency).

## Crash Recovery and Restarts

**Server restart**: Ticker re-evaluates db on first pass. Old `running` rows timeout naturally; `pending` rows continue to be picked up. Applies in `syncing` state are treated as resume candidates — ticker clears heartbeat and spawns wrapper which sees `status='syncing'` on entry and skips LLM phases.

**Wrapper crash**: Heartbeat expires after `runTimeoutMinutes` (default 12min). If `attempts < maxAttempts`, ticker moves row back to `pending` for retry. For applies in `syncing`, row stays `syncing` and ticker spawns recovery wrapper that runs phase 12 publish only.

**Apply mid-publish crash**: Phase 12 preflight is idempotent; step 1 (diff + snapshot) is repeated harmlessly. Publish (`phaseApplyPublish`) is a simple file-by-file cp. If wrapper dies part-way through, main is half-applied, but `history/apply-<id>/` has the rollback. On recovery, wrapper re-runs publish (idempotent cp) to complete.

## Patches and Test Scenarios

`patch.md` is written by `__evo_agent__` in phase A. Natural-language description, **not** a diff. Frontmatter is structured (YAML):

```markdown
---
target: .halo/INSTRUCTIONS.md
testScenario:
  agentId: default
  originalMessage: "user's exact message from snapshot (baseline lookup)"
  testMessage: "clean self-contained probe (what dry-run uses)"
---

## What to change
…
## Why
…
```

**Two messages, two purposes**:
- `originalMessage`: scorer looks this up in source-snapshot.json to find the baseline assistant turn.
- `testMessage`: wrapper feeds this (clean probe) to dry-run sub-cli (fresh session, no prior context).

If they're identical (both clean), that's legal. Old patches wrote single `message` field; wrapper falls back to using it for both meanings.

## Scope Limits

- evo observes **root sessions only** (`parentId === null`). Sub-agent sessions don't trigger evo.
- evo is **invisible to conversation**: no user/assistant messages appended to source session log. One short `chat:system` line per `/evo`.
- Wrappers never modify `~/.halo/global/` directly. Apply uses copy-on-write: read global, write workspace override via file_write in sandbox, then sync to main.
- `/evo` is rejected for non-`full` users.

## Why This Design

- **Detached wrappers + stateless ticker**: Restart-safe, easy recovery, no in-process state to manage on crash.
- **Whitelist sandbox**: Prevents pollution, lets archive job sweep artifacts cleanly, no risk of accidentally modifying main during LLM phases.
- **3-phase run model**: Separates concerns (draft vs. dry-run vs. score), prevents "agent loops forever retrying fixes", bounds feedback loops.
- **Per-workspace apply mutex**: Prevents two applies from racing on sandbox build + main publish.
- **Checkpoint at syncing**: Lets apply resume mid-publish without re-running expensive LLM phases.
- **No session-release on apply**: SessionManager's per-turn eviction means new prompts "just work" on next turn for free.
- **`evo-context.json` packing**: Freezes prompt surface at trigger time so agents don't fetch files, and so evo/score/apply see identical context across restarts (no time-window races).

## Status Flow (Run Mode)

```
pending → running → [draft → dry-run → score] → awaiting_review
                              ↓ (fix)
                           awaiting_review
                                ↓ (approve)
                            approved → running (apply mode)
                                    [regress →
                                     publish]
                                        ↓
                                    applied

              OR: awaiting_review → rejected
              OR: running → timeout / failed / skipped
```

## Status Flow (Apply Mode)

```
pending → running → [merge → regress → publish] → applied

        OR: running → failed / timeout
        OR: running/syncing → syncing (resume path after crash)
                                 ↓ (ticker recovery)
                            running → [publish] → applied
```

# Self-Evolution

Frozen-design spec. Read the decision log at the bottom if a choice surprises you.

## Goal

Let an active workspace **learn from its own conversations** — when an agent
makes the same kind of mistake repeatedly, the user shouldn't have to remember
to fix the prompt. An evolution agent looks at the session, drafts a fix, runs
a sandbox dry-run to score it, and a separate apply agent merges approved
patches back. All under user review.

## Levels

Borrowing self-driving's L0-L5. Ship in order.

| Level | What it does | Status |
|---|---|---|
| **L0** | Fully manual. User edits prompt files themselves. | Already supported |
| **L1** | Human + LLM assist. `/note` and pre-compact trigger drafts; manual approve/reject; apply agent merges. | **MVP — this spec** |
| L2 | Partial auto-apply for high-score patches. | Future |
| L3 | Yaml/capability changes also auto-apply. | Future |
| L4 | Create/archive agents and skills. Curator pass. | Long-term |

L0 needs no code. L1 is what this spec covers. L2+ get a "Future levels" sketch.

---

# L1 MVP

## Three components

1. **Two hidden agents** in `~/.halo/global/agents/`:
   - `__evo_agent__` — drafts patches and runs dry-run scoring
   - `__apply_agent__` — merges approved patches into target files
   Both are normal Halo agents with `internal: true` so they don't appear in
   `list_agents`. They show up in admin's agent management for editing.

2. **Two queues in global db** (`evolution_runs`, `evolution_applies`)
   driven by a server-side ticker (every 30s). Ticker has zero in-memory state
   — looks at db status fields and timestamps.

3. **Per-task wrapper processes** that the ticker spawns. Each wrapper:
   - Runs as a Node child process (`packages/server/dist/evo-wrapper.js`)
   - Updates db heartbeat every 60s
   - Spawns the appropriate `halo cli -a __evo_agent__|__apply_agent__` to
     do the LLM work
   - Watches the cli's exit code and translates to db status
   - Owns its own evo-db handle (separate sqlite file at
     `~/.halo/global/evo.db`) — no need to call into the server process
     because the entire coordination surface (heartbeat, status flips,
     row claims) is just db writes

4. **Admin "Evolution" tab** for listing pendings, viewing patches, approving
   with optional reviewer hint, rejecting, and deleting finished runs
   (artifacts + DB row; blocked for in-flight states).

## File layout

```
<ws>/.halo/evo/
  runs/<id>/                  # one dir per evo run
    meta.json                 # { id, triggerKind, sourceSession, userHint, ... }
    source-snapshot.json      # session messages frozen at trigger time
    tool-flow.md              # tool_result-clipped view of the snapshot
    evo-context.json          # prompt surface at trigger time (see below)
    images/<msgIdx>-<blockIdx>.<ext>  # decoded image content blocks
    sandbox/                  # cp of workspace .halo, mutated by evo
    sub-cli.log               # tee'd stdout+stderr of every `halo cli`
                              # the wrapper spawned (draft/fix/dry-run/score)
                              # — single file, phase-headered for easy reading
    patch.md                  # evo agent writes
    score.json                # __score__ writes
    .skip.md                  # evo writes if no patch is worth landing
  applies/<id>/               # one dir per apply
    meta.json                 # source_run_ids, reviewer_hint
    sandbox/                  # apply agent works here, runs verification
    apply.log
    regress/<runId>/          # per-source-run regression scoring outputs
  history/apply-<id>/         # rollback snapshot before each apply
    MANIFEST.json             # which paths were overwritten/created
    <files>                   # the previous content of those paths
  archive/                    # archive job zips terminal runs/applies
    run-<id>.zip
    apply-<id>.zip
```

`pending/` directory is gone. Pending list comes from `SELECT * FROM
evolution_runs WHERE status='awaiting_review' AND archived_at IS NULL`
in the global db. Patch content comes from `runs/<id>/patch.md`.

`evo-context.json` (written by `enqueueEvoRun()` at trigger time) is the
authoritative snapshot of the source agent's prompt surface — assembled
system prompt, the workspace + global prompt files that go into every
agent's system prompt (INSTRUCTIONS.md, USER.md, INDEX.md, the source
agent's AGENT.md + agent.yaml, prompts/{all,root}/*), plus agent and
skill id listings. Skill content (SKILL.md, sibling resources like
wechat.md / telegram.md) is **not** inlined — listings only. The wrapper
packs `evo-context.json` into briefs so evo doesn't need `file_read` to
inspect the system-prompt files; for skills, it `grep`s / `file_read`s
on demand using the new size-limited tools. Format:

```json
{
  "agentId": "default",
  "assembledSystemPrompt": "<full text>",   // null if session was cold
  "promptFiles": [
    { "scope": "workspace", "path": "INSTRUCTIONS.md", "content": "..." },
    { "scope": "global", "path": "agents/default/AGENT.md", "content": "..." },
    { "scope": "global", "path": "prompts/all/TOOL_GUIDELINES.md", "content": "..." },
    ...
  ],
  "agents": [{ "id": "default", "scope": "global" }, ...],
  "skills": [{ "id": "create-agent", "scope": "builtin" }, ...]
}
```

`tool-flow.md` is a clipped Markdown view of `source-snapshot.json` for
fast skimming. User prose, assistant prose, and `tool_use` calls (with
abbreviated `input`) are kept verbatim; each `tool_result` is replaced
with a ~200-char peek plus the `is_error` flag. Sized to fit easily in
context even for long sessions where grep/shell dumps would dominate.
Evo reads this first to understand the *flow* (which tools ran in what
order, what the user said between turns, whether each call succeeded);
it falls back to the full `source-snapshot.json` (or its inherited
message history) only when a specific tool result actually matters.

`images/` holds decoded base64 image content blocks from
`source-snapshot.json` (top-level or nested in tool_result.content). Same
images visible to evo as vision blocks in inherited messages; the file
paths exist so a patch can keep an image as a prompt resource by
referencing the file. Video / audio / binary documents are not
extracted (Halo doesn't currently produce non-image content blocks).

`history/apply-<id>/` is the rollback safety net for `applied` runs and
is **not** archived by the retention job — kept cheap and discoverable.

`archive/` is created on demand by the archive daemon (see schema
section above for retention policy). Per-row run/apply dirs are zipped
in, then the original dirs removed.

## Global db schema

```sql
CREATE TABLE evolution_runs (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  status          TEXT NOT NULL,    -- pending | running | awaiting_review |
                                    -- approved | applied | rejected |
                                    -- skipped | failed | timeout
  trigger_kind    TEXT NOT NULL,    -- note | pre-compact
  source_session  TEXT NOT NULL,
  user_hint       TEXT,             -- /note text + reviewer hint (replaced on retry)
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  heartbeat_at    INTEGER,
  completed_at    INTEGER,
  applied_at      INTEGER,
  failure_reason  TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER            -- 14d after terminal: zip + clear
);

CREATE TABLE evolution_applies (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  status          TEXT NOT NULL,    -- pending | running | syncing | applied | failed | timeout
  source_run_ids  TEXT NOT NULL,    -- JSON array (one apply can fold N runs)
  reviewer_hint   TEXT,             -- constraints from approver
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  heartbeat_at    INTEGER,
  completed_at    INTEGER,
  failure_reason  TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER
);

CREATE INDEX idx_evo_runs_status   ON evolution_runs(status, created_at);
CREATE INDEX idx_evo_runs_ws       ON evolution_runs(workspace_path);
CREATE INDEX idx_evo_runs_archived ON evolution_runs(archived_at);
CREATE INDEX idx_evo_applies_status   ON evolution_applies(status, created_at);
CREATE INDEX idx_evo_applies_ws       ON evolution_applies(workspace_path);
CREATE INDEX idx_evo_applies_archived ON evolution_applies(archived_at);
```

### Archive lifecycle

`archived_at` is orthogonal to `status` — it tracks the disk-retention
state, not the run's outcome. Two stages:

1. **14 days after a row hits a terminal status** (`applied`, `rejected`,
   `skipped`, `failed`, `timeout` for runs; `applied`, `failed`, `timeout`
   for applies), the archive daemon zips the row's artifact dir into
   `<workspace>/.halo/evo/archive/{run|apply}-<id>.zip`, deletes the
   original dir, sets `archived_at = now()`. The DB row stays.
2. **30 days after `archived_at`**, the archive daemon deletes the zip
   and the DB row outright.

The daemon runs once at server boot (1 minute delay) and every 24 hours
thereafter. Active rows (pending / running / awaiting_review / approved /
syncing) are never archived. The `history/apply-<id>/` rollback tree is
NOT archived — it stays cheap to discover for `applied` runs that may
need rollback.

**Manual delete** (`DELETE /evolution/runs/:id`) is a third, time-independent
exit: it removes a run's artifacts (live run dir + archive zip, whichever
exists) and its DB row immediately, skipping both time gates. Same active-row
guard as archiving — `pending` / `running` / `approved` are rejected (409) so
a live wrapper or queued apply isn't pulled out from under. Artifact removal
goes through `removeRunArtifacts()` in `archive.ts`, which shares the path
layout with the archive/purge helpers. Applies have no manual-delete path —
they're consolidated under their source runs in the UI.

The default API + admin views (`GET /evolution/runs`) exclude archived
rows. A dedicated `GET /evolution/runs?archived=1` endpoint and
admin "Archived" filter let the user inspect them.

## Realtime updates — WS broadcast (no client polling)

The admin Evolution tab subscribes to `evolution:run_changed` and
`evolution:apply_changed` events on the existing `/ws` channel. Server
emits them at every state-change point:

- REST mutations (approve/reject/retry) → broadcast directly with the
  new status. Latency is "instant" from the user's keystroke. Delete
  broadcasts `evolution:run_changed` with `kind:'deleted'` (no status) —
  the sidebar drops the row, an open detail pane clears its selection.
- Wrapper child processes can't reach the parent's WSS handle, so the
  ticker (every 30s) diff'ies the db against an in-memory snapshot of
  last-seen statuses and broadcasts every change it finds. That covers
  `pending → running → awaiting_review/skipped/failed/timeout`
  transitions driven by the wrapper without any client poll.

Broadcast fan-out via `ws/broadcast.ts` to every connected admin socket.
Replaces an earlier `setInterval(refreshList, 5_000)` on every Evolution
tab — same UX, ~zero idle traffic.

## Triggers (L1)

### `/note [text]`

User in chat:

```
/note                            # evo runs on current root session
/note answer is too verbose      # hint for what to look at
```

Server flow (synchronous, completes in ~10ms):

1. Refuse if `level !== 'L1'` or user is `accessLevel === 'readonly'`.
2. Resolve current root session id (must be `parentId === null`).
3. mkdir `<ws>/.halo/evo/runs/<id>/`
4. Write `meta.json` and `source-snapshot.json` (deep clone of current
   `session.agent.messages`).
5. INSERT into `evolution_runs` with `status='pending'`, `user_hint=arg`.
6. Reply via `chat:system`: "📝 Queued for evaluation".

That's all that happens at trigger time. No LLM call yet. Ticker picks it up.

### Pre-compact

Inside `SessionManager.compactSession()`, **before the compression LLM call
mutates `session.agent.messages`**:

1. Same checks (level=L1, source session is root, etc.).
2. **Synchronously snapshot** the current messages — same as `/note` step 3-4:
   mkdir runs/<id>/, write `meta.json` + `source-snapshot.json` (deep clone
   of `session.agent.messages` taken right now, before compact starts).
3. INSERT `evolution_runs` row with `trigger_kind='pre-compact'`,
   `user_hint=null`, `status='pending'`.
4. Continue with normal compact.

Compact then proceeds asynchronously rewriting `session.agent.messages`,
which is fine — evo will analyze the snapshot, not the live array. Order
matters: snapshot first, compact second. Otherwise evo sees the
already-compacted (= summarized + truncated) message log, which loses the
detail we wanted evo to learn from.

The "free LLM cache" angle that pre-compact originally had is gone with
async — that's fine.

### Why not idle

User-active feedback loops are short and useful; idle is "user has left,
runs in dark, finds out hours later". Rejected.

## Ticker (server-side, every 30s)

Stateless. Just queries db.

```
1. Mark timeouts:
   UPDATE evolution_runs SET status='timeout', failure_reason='heartbeat lost'
     WHERE status='running' AND heartbeat_at < now - run_timeout_minutes * 60_000

   UPDATE evolution_applies SET status='timeout' (same condition)

2. Start runs:
   running = SELECT count(*) FROM evolution_runs WHERE status='running'
   slots = max_concurrent_run - running
   for each pending run (oldest first, up to slots):
     spawn('node', ['<server-dist>/evo-wrapper.js', '--mode=run', '--id=<X>'],
            { detached: true, stdio: 'ignore' })

3. Start applies (same pattern):
   spawn('node', ['<server-dist>/evo-wrapper.js', '--mode=apply', '--id=<Y>'])
```

Server doesn't track child processes in memory. If server restarts, the
ticker re-evaluates db state on first tick:

- `status='running'` rows with stale heartbeat → marked `timeout`
- Pending rows continue to be picked up

Wrappers detach from server — `--detach` so they survive server restarts.

## Wrapper (Node child process)

`packages/server/src/evo-wrapper.ts` (compiled to `.js`).

```ts
const { mode, id } = parseArgs()  // mode: 'run' | 'apply', id: <X>
const db = openGlobalDb()

await db.update(...).set({ status: 'running', started_at: now() }).where(eq(id, X))

// Heartbeat: every 60s
const hb = setInterval(async () => {
  await db.update(...).set({ heartbeat_at: now() }).where(eq(id, X))
}, 60_000)

// Spawn the cli
const cli = spawn('halo', [
  'cli',
  '-a', mode === 'run' ? '__evo_agent__' : '__apply_agent__',
  '-w', workspacePath,
  buildBrief(mode, id, ...)
], { stdio: ['ignore', logFile, logFile] })

cli.on('exit', async (code) => {
  clearInterval(hb)
  if (code === 0 && allOutputFilesExist()) {
    if (mode === 'run') {
      await db.update(...).set({ status: 'awaiting_review', completed_at: now() })
    } else {
      // apply post-processing, see "Apply post-processing" below
      await postApply(id)
    }
  } else {
    await db.update(...).set({ status: 'failed', failure_reason: ..., completed_at: now() })
  }
  process.exit(0)
})
```

> **Resolving the `halo` binary (cross-platform).** `resolveHaloCli()`
> returns bare `halo` on macOS/Linux but **`halo.cmd` on Windows**: the
> desktop installer drops `halo.cmd` (cli launcher) and `Halo.exe` (the
> GUI) into the same dir on PATH, and PATHEXT ranks `.EXE` above `.CMD`, so a
> bare `halo cli …` would launch the GUI — which relaunches the app and
> grabs the global `server.lock` instead of running the cli. Spawning a
> `.cmd` directly is rejected by Node ≥21.7 (EINVAL, CVE-2024-27980), so on
> Windows the child is routed through `cmd.exe /c`. Override the whole thing
> with `$HALO_CLI` for dev. The real code also passes the brief on **stdin**
> (not as the trailing argv element shown above) to dodge the Windows
> command-line length limit.
>
> On **macOS**, bare `halo` resolves via PATH to the launcher the "Install
> 'halo' Command" menu drops in `/usr/local/bin`. But a desktop app launched
> from Finder/Dock has only launchd's minimal PATH (no `/usr/local/bin`), so
> the spawn would `ENOENT`. The Electron main process (`desktop/src/main.cjs`
> `startServer()`) compensates by prepending the standard CLI dirs to the
> server child's `env.PATH` — see `dev/desktop-packaging.md`.

### Wrapper logs (two streams, both surfaced in admin)

The wrapper writes two log streams that the admin Evolution tab reads
back lazily on detail fetch:

- **`~/.halo/global/logs/evo/run-<id>.log`** — wrapper's own
  orchestration log. Phase headers, sub-cli command lines (last arg
  omitted to avoid leaking the whole brief), exit codes, finalize
  decisions. Cheap, always present once the wrapper starts.

- **`<runDir>/sub-cli.log`** — `stdout` + `stderr` of every `halo cli`
  the wrapper spawned (draft, fix, dry-run, score), tee'd live to disk
  in a single file with `=== <ts> Phase ... ===` markers between
  sections. A single tail covers the whole run end-to-end. Captures the
  inner cli's actual error messages (e.g. Anthropic API rejections) that
  used to be buried in a 2 KB stderr-tail dump only emitted on non-zero
  exit. The wrapper still keeps the in-memory stdout for `dry-run-output.txt`
  on success — tee writes are additive, not redirective.

GET `/api/evolution/runs/:id` returns both as `wrapperLog` /
`subCliLog`. The admin detail panel renders them as collapsible
`<pre>` blocks (default open under 4 KB, collapsed otherwise) for both
successful and failed runs — successful runs benefit from seeing how
long each phase took / whether the fix budget was used; failed runs
need them to diagnose why.

### Apply post-processing

After the apply cli exits 0:

1. Walk `applies/<id>/sandbox/.halo/` and find files that differ from main
   `<ws>/.halo/`. Those are what the apply agent decided to write.
2. Snapshot the changed paths from main `<ws>/.halo/` → `history/<ts>--apply-<X>/`.
   (Snapshot now, after we know what changed — saves space vs blanket cp at
   wrapper start.)
3. Copy each changed file from sandbox to main. Use Node `fs/promises`,
   not `rsync` or `cp` (cross-platform).
4. UPDATE `evolution_applies status='applied'`.
5. UPDATE all source_run_ids' `evolution_runs` rows to `status='applied'`.

That's it. **No "release in-memory sessions" step** — Halo's session
lifecycle makes it unnecessary. See [Session lifecycle: cold-start per
turn](#session-lifecycle-cold-start-per-turn) for the full picture, but
the short version: every session is evicted from the SessionManager
cache as soon as its current message turn finishes. The next turn runs
`buildAgentInstance` from scratch, which re-reads `agent.yaml` +
`INSTRUCTIONS.md` + `USER.md` from disk. So the just-applied changes
take effect on the next turn for free, and currently-running turns
finish on the old prompts (deliberate — aborting a user mid-conversation
would be a worse experience than a slight prompt-change delay).

If sandbox doesn't exist or has no changes (apply agent decided nothing was
worth writing): mark `complete` anyway with a note in `failure_reason`. The
runs are still marked `applied` since the user's intent was satisfied (no
change needed).

If cli exits non-zero or in-sandbox tests failed: main workspace is
untouched (apply agent wrote only to sandbox). Just mark `failed`.

## Platform override matrix (reference for evo / score)

Both `__evo_agent__` and `__score__` need to reason about how prompt files
load at runtime — what evo writes ends up in a workspace, and the scorer
needs to know whether that workspace file actually overrides the global
one. This is the canonical reference; AGENT.md files for both agents
include the same table.

| File / dir | Override rule |
|---|---|
| `INSTRUCTIONS.md` | Workspace `<ws>/.halo/INSTRUCTIONS.md` **fully suppresses** the global one. Subdirectory `INSTRUCTIONS.md` files (under `<ws>/<sub>/.halo/`) layer additively on top of the workspace root. |
| `agents/<id>/` | **Whole-folder override.** Workspace `<ws>/.halo/agents/<id>/` exists → serves the agent entirely (both `AGENT.md` and `agent.yaml`), global folder ignored, no per-file fallback. |
| `skills/<id>/` | **Whole-folder override.** Workspace `skills/<id>/` replaces the global skill wholesale — `SKILL.md` + every sibling resource. |
| `prompts/all/`, `prompts/root/`, `prompts/bootstrap/` | **Whole-folder override.** If the workspace scope directory exists at all, the entire global directory for that scope is ignored. |
| `USER.md` | Workspace replaces global. |

**The whole-folder trap** (applies to `agents/`, `skills/`, `prompts/`
alike): if a patch creates a workspace folder containing only the one file
it edited, every *other* file the global folder had becomes invisible at
runtime. To override one file inside such a folder, the patch must `cp` the
entire global folder first. The sharpest case is an `agents/<id>/` left
with only `AGENT.md` — `agent.yaml` is gone, so the agent has no model
config. Mention this explicitly in any patch that touches a whole-folder
target.

Implementation: agent/skill folder resolution in
`packages/server/src/agents/agent-loader.ts` (`agentSourceDir`,
`skillSourceDir`), AGENT.md in `prompts/md-loader.ts` (`resolveMdPaths`),
prompt scopes in `prompts/system-prompts.ts` (`resolvePromptsDir`).
Behavior is whole-folder "first match wins" not per-file merge.

## What the agents see

### Run mode is split across THREE wrapper-orchestrated phases

The wrapper, not the agent, drives the whole `mode=run` lifecycle. Three
phases each spawn a fresh `halo cli` for one job; the wrapper owns all
the sub-cli invocations against the sandbox so individual agents can't
"go off-script" by retrying with edited prompts.

```
Phase A (draft):  halo cli -a __evo_agent__  -n -w <runDir>/sandbox  "<draft brief>"
Phase B (dry-run, retry-on-error):
                  halo cli -a <triggeringId> -n --access workspace -w <runDir>/sandbox "<testMessage>"
                  on failure:
                  halo cli -a __evo_agent__  -n -w <runDir>/sandbox  "<fix brief + error log>"
Phase C (score):  halo cli -a __score__      -n -w <runDir>/sandbox  "<score brief>"
```

All phases run inside `<runDir>/sandbox/` (whitelist-cp of the user
workspace's prompt surface), so no agent_sessions rows or evo state
ever touch the user's real workspace db.

Three structural points apply across the phases:

1. **Snapshot reading via on-disk files (no session inheritance).**
   Each phase spawn is a fresh `-n` session. The drafter / fix / scorer
   read context from disk via `file_read`:
   - `<runDir>/source-snapshot.json` — full rawMessages (the source
     conversation)
   - `<runDir>/tool-flow.md` — clipped view, ~200-char peeks per
     tool_result with the `is_error` flag (read this first to skim)
   - `<runDir>/evo-context.json` — the prompt surface at trigger time,
     packed into the brief verbatim so the drafter doesn't have to
     re-read prompt files

   No internal session is staged, no `agent_sessions` row is written
   anywhere. The drafter and scorer are stateless across runs, and
   their stdout / stderr land in `<runDir>/sub-cli.log` for review.

   Earlier iterations of this design pre-staged the snapshot's
   rawMessages into a global internal-sessions JSON file and resumed
   the agent via `cli -s evo_<runId>` so the LLM "inherited" the full
   conversation. That worked for Anthropic-to-Anthropic flows but
   needed a sanitizer pipeline (thinking-block stripping, dangling
   tool_use repair, role-alternation merge, etc.) to make
   cross-provider rawMessages legal Anthropic input. The whole edifice
   was deleted in favor of `-n` + on-disk reads — same information
   reaches the agent, no replay-shape constraints to satisfy, no
   staged session to garbage-collect.

   And because all phase-A/A-fix/C invocations also `-w <runDir>/sandbox`
   instead of the user workspace, any incidental writes (e.g. a future
   internal agent that creates a sub-session) land in the sandbox's
   brand-new db, which gets discarded with the runDir.

2. **Prompt surface packed into the brief, plus on-demand reading.** The
   wrapper bakes the **system-prompt files** into the brief at trigger
   time (captured by `enqueueEvoRun()` into `<runDir>/evo-context.json`)
   so the agents never have to fetch them: the assembled system prompt
   the source agent was running under, every workspace + global
   INSTRUCTIONS.md / USER.md / INDEX.md, the source agent's AGENT.md /
   agent.yaml, prompts/all/*, prompts/root/*, plus id-only listings of
   every agent and skill in the workspace. Skill content (SKILL.md and
   sibling resource files) is **not** inlined — at scale that would blow
   up the brief regardless of which skill the patch actually touches.

   For everything not in the brief, both agents have a read-only toolkit
   they can use on demand: `file_read` (with offset/limit + 2 MB cap),
   `grep`, `glob`, `file_list`. Typical pattern: `glob` or `grep` to
   locate a specific SKILL.md → `file_read` it → reason → write the
   patch. The size guards keep this safe — pre-guard, a single
   `file_read` of an oversized file could consume tens of thousands of
   tokens.

   Writing toolkit:
   - **evo**: `file_write`, `file_edit` (write `patch.md` + sandbox
     target file; iterate on patch.md inline if needed). No
     `shell_exec` — evo doesn't execute anything; the dry-run is run by
     the wrapper, not by evo.
   - **scorer**: `file_write` only (writes `score.json`). No
     `file_edit` / `shell_exec` — the scorer is read-only on the
     workspace, write-only on `score.json`.

3. **Image dump.** Before phase A spawns, the wrapper walks the snapshot
   `rawMessages`, decodes every `type:'image'` content block (top-level
   or nested in tool_result.content) to
   `<runDir>/images/<msgIdx>-<blockIdx>.<ext>`. Brief includes a manifest
   listing each path with role / msgIdx / media_type / size / adjacent
   text. The same images are visible to the agent as vision blocks in
   message history; the file paths exist for the rare case where a patch
   needs to keep an image as a prompt resource.

   Video / audio / binary documents are NOT extracted — Halo currently
   has no `view_video` / `view_audio` tool, and snapshots therefore
   don't carry such blocks. Brief carries a generic "Non-text media note"
   instructing the agent to skip the run if the patch logically depends
   on understanding media internals it can't see.

#### Phase A — `__evo_agent__` drafts

The brief packs everything; AGENT.md describes the procedure.

```
You are running as the Evolution drafter (mode: DRAFT).

Run id: <X>
Workspace: <ws>
Working dir: <runDir>
Trigger: note | pre-compact
Reviewer hint: <if set>

Your conversation history is the triggering agent's full message log.
Scroll back to inspect what the user wanted, what the agent did, and
where it diverged. The current prompt surface follows.

[evo-context.json rendered:
   - assembled system prompt
   - prompt file dump (workspace + global)
   - agent + skill listing]

[image manifest, if any images extracted]

[non-text media note]

=== Task ===
Decide what change in the prompt surface above would help next time.
Three shapes, in order of preference: rewrite an existing rule;
tighten / reorganize what's there; or, only when neither applies, add
a new rule.

Sandbox path: <runDir>/sandbox

When you have a change worth making, write `patch.md` (frontmatter + body)
and one new file at `<runDir>/sandbox/.halo/<target>` with the full new
contents.

When the conversation has no signal, or your patch logically requires
understanding media you can't see, write `<runDir>/.skip.md` with a one
or two sentence reason. .skip.md is the LAST file you write — wrapper
checks it after patch.md, takes it as your final word.

[language clause]
```

The agent has only `file_list` and `file_write`. It can't `file_read` the
sandbox, but the brief already has every prompt file content; the only
reason `file_list` exists is to verify a sandbox subdirectory before
writing into it.

#### Phase B — wrapper runs the dry-run, calls evo back to fix on error

```
timeout 180 halo cli -a <patch.testScenario.agentId>
                       -n --access workspace
                       -w <runDir>/sandbox
                       "<patch.testScenario.testMessage>"
```

`--access workspace` is critical: bwrap masks `~/.aws`, `~/.ssh`,
`~/.kube`, `~/.docker`, `~/.gnupg`, `~/.halo/secrets` so a probe
mentioning AWS / cloud / system credentials can't actually fire side
effects. File and shell ops inside the sandbox itself are unaffected.
Same `--access workspace` is used in apply mode's regression dry-runs.

Outcomes:
- **Exit 0 + non-empty stdout:** save to `<runDir>/dry-run-output.txt`,
  proceed to phase C.
- **Anything else** (non-zero, empty, timeout): save the failure detail to
  `<runDir>/dry-run-fail-<n>.log`, then re-spawn `__evo_agent__` resuming
  the SAME `evo_<runId>` session with a **fix brief**. The fix brief
  inlines the failure log content (no `file_read` needed). The agent
  remembers its own draft from the resumed messages and decides what to
  change. After it exits, the wrapper retries the dry-run.

`FIX_BUDGET = 1` — exactly one corrective pass. If the second attempt
still fails, the run is marked `failed` with
`failure_reason='dry-run never succeeded'`. We deliberately don't loop:
- Two-pass shape (original + one corrective edit) covers the common
  failure modes (bad yaml, malformed frontmatter, scope-too-aggressive
  test scenario) without spiralling.
- More than one fix tends to look like the old "edit prompt and retry"
  anti-pattern — if a patch can't be made dry-run-clean in one
  corrective edit, it's signal that the patch should be rejected, not
  iterated on.

#### Phase C — `__score__` scores

The brief packs everything; the scorer has only `file_write`.

```
You are running as the Evolution scorer.

Run id: <X>
Workspace: <ws>
Working dir: <runDir>

Your conversation history is the original conversation the patch was
drafted from. The current prompt surface and patch context follow.

[evo-context.json rendered]

=== patch.md ===
[full content]

=== dry-run-output.txt ===
(stdout from the wrapper running the patched sandbox against
testScenario.testMessage. Two execution constraints to keep in mind:
 1. Sandbox runs under --access workspace, so AWS / system-credential
    operations are expected to fail with "Unable to locate credentials".
    Score on what KIND of response the agent gave, not on whether
    external side effects fired.
 2. Inline images are visible vision blocks; video / audio / binary
    documents are not. Patches whose value depends on media internals
    naturally show low-signal dry-runs and that's correctly reflected
    in `confidence: low` rather than punished via behavior score.)
[full content]

=== meta.json ===
[full content]

=== Task ===
From patch.md frontmatter, take testScenario.originalMessage and find the
assistant turn that immediately followed it in your message history —
that's the baseline. Compare baseline to dry-run-output.txt, rate lint /
behavior / scope, write `<runDir>/score.json`.

[language clause for the "notes" field]
```

Splitting drafter vs scorer means the scorer doesn't have ego attached to
the patch. The same scorer is reused at apply time (phase 11) to validate
the merged sandbox before main is touched.

#### Why `halo cli` and not `start_session`?

`start_session` reuses the parent session's SessionManager state — the
sub-agent reads prompts from the real workspace, not the sandbox, so the
patch never actually loads. `halo cli -w <sandbox>` runs in its own
process and reads `<sandbox>/.halo/` as the workspace, so the patch is
genuinely live in the test.

#### Brief design — consequence framing, not negation

The briefs and the AGENT.md files for `__evo_agent__` / `__score__` /
`__apply_agent__` use **consequence/affordance language** rather than
imperative or negation phrasing:

- "Reading the README first anchors your questions" not "Don't open with
  questions"
- "Padding dilutes directness" not "Don't pad"
- "Edits outside `<applyDir>/` would corrupt main workspace" not "Never
  edit outside `<applyDir>/`"

The reasoning: imperative ("do X") and negation ("don't X") are weaker
LLM signals than statements of consequence; the model treats negations
especially poorly because the X token still elevates that action's
probability. **Hard constraints belong in the tool layer**, not the
prompt — the evo agent literally cannot run `halo cli` because
`shell_exec` isn't in its tool set, so the prompt doesn't need to say
"do NOT spawn halo cli". Same for "don't write score.json" (no
`file_write` outside the sandbox is enforced by sandbox path validation,
not prompt).

What stays as prompt-level guidance: style preferences, work shape,
optional / discretionary boundaries that benefit from the agent reasoning
about edge cases.

Mode-specific bits:
- **Draft brief** carries `Trigger`, optional `Reviewer hint` (replaces
  `User hint` on retry — see retry policy below).
- **Fix brief** carries `Fix attempt: 1/1` and the failure log content
  inline (no separate `file_read`).
- **Score brief** is the largest because it inlines patch.md +
  dry-run-output.txt + meta.json + the prompt surface.

### Apply mode is wrapper-orchestrated, mirrors run mode

Same shape as `mode=run`: wrapper drives, agents do focused work,
`__score__` is reused as a regression gate. Key difference is the
wrapper, not the apply agent, builds the sandbox **and** runs the
per-source-run validation loop (the apply agent only merges).

```
Phase A' (merge):    halo cli -a __apply_agent__ -n -w <ws>      "<merge brief>"
Phase B' (regress):  for each source_run_id Xi:
                       halo cli -a <patch.testScenario.agentId> -n -w <applyDir>/sandbox \
                         "<patch.testScenario.testMessage>"
                       halo cli -a __score__ -n -w <ws>      "<regress brief for Xi>"
                     all scores OK → proceed to sync (phase 12)
                     any score regresses → mark apply failed, main untouched
```

#### Apply working dir

```
<ws>/.halo/evo/applies/<applyId>/
  meta.json                    # { source_run_ids: [...], reviewer_hint }
  sandbox/.halo/             # built by wrapper from main <ws>/.halo/, edited by apply agent
  regress/<runId>/             # one dir per source run, written by phase B'
    dry-run-output.txt
    score.json
  apply.log
```

The apply sandbox is **separate** from any evo run sandbox:

- A reviewer can approve N runs into a single apply, so we'd have to
  combine N evo sandboxes anyway. Cleaner to start fresh.
- `patch.md` may have been edited by the reviewer between approve time
  and apply time — apply must read the *latest* patch.md.
- The main workspace may have changed during review (other apples
  applied, user edits). Apply should be based on **current** workspace
  state, not the evo run's frozen sandbox.

#### Phase A' — `__apply_agent__` merges into a wrapper-built sandbox

The **wrapper**, before spawning the apply agent, does the same
whitelist cp evo's phase A does — but from the **current main
workspace** into `<applyDir>/sandbox/.halo/`. Apply agent walks into
that pre-built sandbox.

```
Your job: merge N approved evolution patches into the apply sandbox.
You do NOT run dry-runs and you do NOT score the merged result —
the wrapper handles both, separately, using __score__.

Apply id: <Y>
Working dir: <ws>/.halo/evo/applies/<Y>/
source_run_ids: [X1, X2, ...]
Reviewer hint (may be empty): <text>

Steps:
1. Read meta.json (source_run_ids + reviewer_hint).
2. For each source_run_id Xi, file_read <ws>/.halo/evo/runs/Xi/patch.md.
   Use the **latest** version — the reviewer may have edited it after
   approving.
3. Look at the wrapper-built sandbox at <applyDir>/sandbox/.halo/.
   Note which target files are present and their current content
   (which is the latest main-workspace content, not evo's frozen
   snapshot).
4. Apply each patch's changes to sandbox/.halo/<target>:
   - file_edit / file_write within the sandbox only.
   - Respect the platform override matrix (see above) — if a patch
     wants to change a file that currently lives only in
     ~/.halo/global/, you MUST materialize the workspace override
     first. For whole-folder targets (agents/<id>/, skills/<id>/,
     prompts/<scope>/), copy the *entire global folder* before editing
     one file — otherwise the workspace folder's mere existence
     suppresses every other file the global folder had (an agents/<id>/
     with only AGENT.md loses agent.yaml → no model config). For the
     single-file overrides (INSTRUCTIONS.md, USER.md), copy that file in
     first, then edit.
   - When two patches touch the same target, merge by intent: read both
     bodies, decide what the combined edit should look like. Don't try
     a textual diff merge.
   - reviewer_hint is a hard constraint that overrides individual
     patches: if it says "only apply X, skip Y", you skip Y entirely.
   - If patches are genuinely contradictory and reviewer_hint doesn't
     resolve it, write the conflict to apply.log and exit non-zero —
     the reviewer needs to split the apply.
5. Exit 0 once the sandbox reflects all approved + reconciled
   changes. The wrapper takes over from here.
```

#### Phase B' — wrapper runs per-source regression check via `__score__`

For each source run id `Xi`, the wrapper:

1. Reads `<ws>/.halo/evo/runs/Xi/patch.md` to get
   `testScenario.{agentId, testMessage, originalMessage}`.
2. Spawns `timeout 180 halo cli -a <agentId> -n -w
   <applyDir>/sandbox "<testMessage>"`.
3. Saves stdout to `regress/Xi/dry-run-output.txt`.
4. Spawns `__score__` with a regress-mode brief pointing at
   `regress/Xi/`. Scorer reads patch.md, the new dry-run output, and
   source-snapshot.json — same procedure as phase 9C but in apply
   context. Writes `regress/Xi/score.json`.

A regression is **any score.json** with `behavior < 50` (clearly worse
than baseline) or `lint < 50` (patched config doesn't load cleanly).
Thresholds live in `general.evolution.apply_regression_*` settings
(future); start with hardcoded 50/50.

If all source runs pass the regression check → wrapper proceeds to
phase 12 (final sync to main). If any regresses → wrapper marks
`evolution_applies status='failed'`, main workspace untouched, source
runs stay `approved` so the user can split or edit and try again.

## Patch file (`runs/<id>/patch.md`)

Written by `__evo_agent__` in phase A. Natural-language description, NOT
a diff. The frontmatter is structured (the wrapper parses it for the
dry-run; the scorer parses it for baseline lookup); the body is for
human review.

```markdown
---
target: .halo/INSTRUCTIONS.md
testScenario:
  agentId: default
  originalMessage: "做成csv文件"
  testMessage: "做一个 CSV 存到 /tmp/x.csv，含中文表头，给 Mac Excel 用"
---

## What to change
…
## Why
…
```

Frontmatter keys stay English (they're contract — wrapper / scorer parse
them). Body is in the user's language (`general.language`).

### `testScenario` — two messages, two purposes

| Field | Used by | Constraint |
|---|---|---|
| `agentId` | wrapper (dry-run) + scorer (frontmatter parse) | id of the **triggering agent** from `source-snapshot.json` |
| `originalMessage` | scorer | verbatim user message from `rawMessages` — the assistant turn that follows it is the "before" baseline |
| `testMessage` | wrapper | clean self-contained probe **drafted by evo** to surgically exercise the patched rule. Should not depend on prior conversation context. |

Why split them:
- The wrapper's dry-run sub-cli is a fresh session with no prior turns —
  so the probe must be self-contained ("做一个含中文的 csv" works; "做成
  csv文件" needs a table from earlier in the chat that the sub-agent
  doesn't have).
- The scorer needs to compare *the patched agent's reply on the probe*
  against *the original agent's reply on the original message* — which
  means it needs the original text, verbatim, to find the right baseline
  turn in the snapshot.
- If `testMessage` and `originalMessage` happen to be identical clean
  probes, the drafter may write the same string twice — that's allowed.
  Most snapshot turns aren't clean probes, so they differ in practice.

Back-compat: older patches (before the split) wrote a single `message`
field. The wrapper falls back to using it for both meanings. New runs
should always use the two-field shape.

`score` is **not** in the frontmatter — it lives only in `score.json`,
written by the scorer in phase C. Older runs may have a stale `score:`
block from before this split; the wrapper / UI ignore it.

The apply agent reads this whole markdown and decides how to actually merge
it. There's no `operation: append/replace` field — the apply agent makes that
call.

## Score (`runs/<id>/score.json`)

Written by `__score__` in phase C — never by the drafter. Splitting
drafter and scorer is the whole reason patches don't get inflated by the
agent that proposed them.

```json
{
  "lint": 90,
  "behavior": 75,
  "scope": 80,
  "confidence": "high",
  "avg": 82,
  "notes": "Sandbox sub-agent gave a more specific answer with citations. Minor risk of being too prescriptive on edge cases."
}
```

Each dim is 0-100. Anchor each at 50 = "neutral / no signal" so the
scorer doesn't default to all-50 when unsure.

- **lint** (0-100): did the patched prompt files load cleanly when the
  wrapper ran the dry-run? yaml valid, cross-refs resolve, no contradictions
  with sibling files.  100 = clean, 50 = unclear, 0 = patched config didn't
  load at all (dry-run failed even after fix attempts).
- **behavior** (0-100): is the dry-run output (in `dry-run-output.txt`)
  better than the original assistant reply that followed
  `testScenario.message` in the snapshot? 100 = clearly better, 50 =
  indistinguishable / mixed, 0 = clearly worse.
- **scope** (0-100): surgical (100) vs sweeping (0). Touching one workspace
  file with 3 lines = high; rewriting an agent's whole AGENT.md = low.
- **confidence** (low/medium/high): scorer's own confidence in the call.
  Independent of the numeric scores — confidence "high" with all 50s is
  legal ("I'm sure this is a wash").

`avg = round((lint + behavior + scope) / 3)` — single 0-100 number for
sorting in the admin UI. Future L2 thresholds use this + confidence.

The same scorer is reused at apply time (phase 11): after the apply agent
merges N approved runs into a sandbox, the wrapper invokes the scorer
again on each source run's `testScenario` to confirm the merged sandbox
still produces the improvement (regression gate before main is touched).

## Admin Evolution tab

A top-level tab. Shows:

- **List**: rows from `evolution_runs` joined with `evolution_applies`
  (latest per source_run). Sortable by created_at, status, score.
  Filterable by status; default views exclude archived rows.
- **Status filters** (sidebar buttons): `all`, `awaiting_review`,
  `pending`, `running`, `approved`, `applied`, `skipped`, `rejected`,
  `failed`, `timeout`, `archived`. The `archived` filter is a special
  pseudo-status: it triggers `GET /evolution/runs?archived=1` (different
  endpoint param, returns the archived list); all other filters operate
  on the active list.
- **View**: opens patch.md, score.json, test scenario, the assembled
  brief context (so the reviewer can see what the agents saw), diff
  against current target.
- **Approve** (visible when status=`awaiting_review`): opens dialog with
  optional reviewer_hint textarea. On submit:
  - UPDATE evolution_runs status='approved'
  - INSERT evolution_applies (source_run_ids=[X], reviewer_hint, status='pending')
- **Reject** (awaiting_review): UPDATE evolution_runs status='rejected'.
- **Add hint** (awaiting_review): UPDATE evolution_runs.user_hint += text.
  Status unchanged. Memo for the apply agent; doesn't trigger anything.
- **Retry** (awaiting_review + every terminal status except `applied`
  and `archived`): opens dialog with required hint textarea. On submit:
  - UPDATE evolution_runs SET status='pending', attempts=0,
    started_at=NULL, heartbeat_at=NULL, completed_at=NULL,
    failure_reason=NULL, user_hint=<new hint>
  - Ticker picks it up on the next pass and re-spawns the wrapper.
  Hint is required — same input + no new direction would just reproduce
  the same output. Replaces user_hint (not append) because the new run
  is a fresh attempt.

  Endpoint: `POST /api/evolution/runs/:id/retry { hint }`. Refuses
  retry on `running` (would race the live wrapper) or `pending` (already
  queued).

The user can also edit `runs/<id>/patch.md` directly (file_edit) before
approving — apply agent re-reads at apply time.

Multiple approvals on the same target: each Approve creates an
independent `evolution_applies` row, runs serially. Future "batch
apply" UI can group N approved runs into one apply row.

## Settings

```yaml
general:
  language: en-US              # en-US | zh-CN (BCP-47); globalOnly
  evolution:
    level: L0                  # L0 | L1
    max_concurrent_run: 1
    max_concurrent_apply: 1
    run_timeout_minutes: 5
    apply_timeout_minutes: 5
    max_attempts: 3            # how many times the ticker may try to spawn a wrapper
    triggers:
      pre_compact: true
```

L0 = disabled. L1 = enabled. Defaults are conservative; adjust if your
machine handles more.

`/note` is always available when level=L1. Not in settings as a toggle.

### `general.language` (system-wide)

Stored as a BCP-47 region tag. Single source of truth — the toolbar
language switcher in the admin UI reads and writes the same value.
Internal agents (`__evo_agent__`, `__score__`, future `__apply_agent__`)
skip platform prompts (see [Internal-agent isolation](#internal-agent-isolation))
so they wouldn't otherwise know what language the user prefers; the
wrapper resolves this setting and threads it into every brief it builds.

`config.language` collapses BCP-47 to the simpler `'en' | 'zh'` shape
that the rest of the codebase already speaks (see `i18n.ts`'s `Lang`
type). New region tags would need a small map update there if we ever
add `ja-JP` etc.

## Retry

Two flavors of retry — one automatic (heartbeat-driven), one reviewer-driven.

### Automatic (heartbeat timeout)

Both `evolution_runs` and `evolution_applies` carry an `attempts` column.
Each `pending → running` claim atomically bumps `attempts += 1`.

When heartbeat times out:
- `attempts < max_attempts` → flip back to `pending` (clear started_at /
  heartbeat_at) so the next tick re-claims it (with attempts += 1 again).
- `attempts >= max_attempts` → terminal `timeout` with
  `failure_reason: 'gave up after N attempts'`.

A permanently broken task burns at most `max_attempts` wrapper attempts
before stopping, instead of looping forever.

### Reviewer-driven (admin Retry button)

`POST /api/evolution/runs/:id/retry { hint }` resets the row:

```sql
UPDATE evolution_runs
   SET status='pending', attempts=0,
       started_at=NULL, heartbeat_at=NULL, completed_at=NULL,
       failure_reason=NULL, user_hint=<new hint>
 WHERE id=:id
```

Allowed from any terminal status (`failed`, `timeout`, `skipped`,
`rejected`, `awaiting_review`); refused on `running` (race with live
wrapper) or `pending` (already queued).

The hint is required — empty hint means same input + same context, which
just reproduces the previous output. Hint replaces `user_hint` (not
append) because the new run is a fresh attempt against new direction;
the appended-memo path is `/hint` (separate endpoint, status unchanged).

Retry on `applied` is intentionally not allowed — the patch already
landed in main; producing another patch over the same source needs a
new `/note` to anchor against the post-apply baseline.

Retry doesn't bump a "retry counter" anywhere — the user can retry as
many times as they want. The reasoning: rate-limiting reviewer-driven
retries would push a frustrated user to delete-and-recreate the row,
which is more work and less observable.

## Internal-agent isolation

Agents flagged `internal: true` in their `agent.yaml` (`__evo_agent__`,
`__score__`, future `__apply_agent__`) are **platform tooling, not
workspace assistants**. They should not inherit any workspace context:
no `INSTRUCTIONS.md`, no `USER.md`, no `INDEX.md`, no
`prompts/all|root|bootstrap`. Only their own `AGENT.md` plus the brief
the wrapper hands them.

Why:
- **Token budget**: snapshots can run 100KB+; loading another 5–20KB of
  workspace platform prompts on top is dead weight.
- **Behavior bleed**: workspace rules like "Be concise" or persona-shaping
  prompts make the drafter / scorer second-guess procedure that's
  supposed to be deterministic.
- **Cross-workspace consistency**: an evo run launched from workspace A
  vs. workspace B should behave the same way; loading workspace prompts
  would tilt evo toward whatever rules the *current* workspace happens
  to have.

Implementation: `SessionManager.startSession` checks `yamlConfig.internal
=== true` and zeroes out `mdContents.{userMd, globalInstructions,
workspaceInstructionsChain, projectIndex, needsBootstrap}` plus
`systemPrompts.{bootstrap, all, root}` before composing the system
prompt. Internal agents still get tools, model config, prompt caching
etc. — only the platform-md surface is suppressed.

## Session lifecycle: cold-start per turn

This is a Halo-platform fact that the entire phase 12 design depends
on. Worth pinning here because misunderstanding it leads to
over-engineering (e.g. building a "release all sessions on apply"
hook that turned out to be unnecessary).

### How `SessionManager` actually caches sessions

`SessionManager.sessions` is a `Map<sessionId, AgentSession>` of
**currently-mid-message** sessions only. The cache lifecycle is:

1. User message arrives → `ensureSession(id)`:
   - if id is in the Map → return that AgentSession
   - else → load metadata from sqlite + load saved messages from
     `<ws>/.halo/sessions/<agentId>/<id>.json` + run
     `buildAgentInstance` (which reads `agent.yaml`, `INSTRUCTIONS.md`,
     `USER.md`, all `prompts/` from disk) → put result in the Map
2. Run the LLM turn (model call + tool calls + assistant reply)
3. `runSession`'s finally block calls `releaseSession(id)`:
   - persist message log to disk (`saveAgentState`)
   - **delete from the in-memory Map**
4. Session is now back to "only on disk". Next message → step 1 again.

So **between user messages, no session is in memory**. Each turn is a
cold start: re-read all prompt files, build a fresh `ModelRuntime`
instance, run, save, evict.

### What this means for evo / apply

The natural consequence: **any change to `agent.yaml`, `INSTRUCTIONS.md`,
`USER.md`, or `prompts/**` takes effect on the very next user message**,
without any cache-invalidation work from the rest of the system.
Phase 12 of evo apply just needs to copy the sandbox files into main —
the prompts kick in for free on the next turn, in every channel
(wechat, telegram, web, TUI, cli, sub-agent `start_session`).

In-flight sessions (LLM call running right now when phase 12 cp lands)
finish on the *old* prompts — also correct: aborting a user
mid-conversation to make a prompt change visible 200ms earlier would be
a worse trade.

### Implications

- No "release sessions on apply" hook needed in phase 12.
- No cross-process coordination between wrapper and server for prompt
  invalidation — the in-memory cache simply doesn't live long enough
  for staleness to matter.
- A wrapper can be a fully detached process (its own evo-db handle, no
  shared state with server) without any caching consequences.
- Server restart is a no-op for users — every "lost" session was about
  to be released anyway, and gets restored from disk on the next turn.

### Inverse: what does NOT take effect immediately

A handful of things ARE cached for the lifetime of the server process,
not per-turn:

- The `models/<provider-id>.yaml` registry (loaded once at server boot;
  see `loadModelsRegistry` in `config.ts`). Editing one of these
  requires a server restart.
- The `general` settings schema (cached at boot). Same — restart for
  schema additions, though *values* in `settings.yaml` are mtime-watched
  and pick up live.
- Compiled tool registries inside individual `SessionManager`s
  (workspace tools list). Today these are static, not user-tunable
  beyond the `tools:` array in `agent.yaml`, which IS picked up
  per-turn.

If a future feature adds long-lived in-memory state that needs to
respond to evo apply, *that's* when an explicit invalidation hook
would be worth designing — not for prompt files, which already work.

## Constraints / safety

- Evo only observes **root sessions** (`parentId === null`). Sub-agent sessions
  don't trigger evo on their own.
- Evo is **invisible to the conversation**: no `user`/`assistant` messages
  appended to source session log. One short `chat:system` line per `/note`.
- Wrappers detach from server — server restart doesn't kill in-flight
  evaluations. Heartbeat-based timeout cleans up if a wrapper crashes.
- `/note` is rejected for `accessLevel === 'readonly'` users.
- Wrappers never modify `~/.halo/global/` directly — only the workspace's
  `.halo/` (via copy-on-write inside the apply agent).
- The `__evo_agent__` and `__apply_agent__` are normal agents — they can be
  modified by users (or by themselves via evo, like any other agent). User
  approves their own self-modifications.

## Implementation order

Status legend: ✅ done · 🔄 in progress · ❌ not started.

1. ✅ Settings schema (`level`, max_concurrent, timeouts, triggers)
2. ✅ Global db: `evolution_runs`, `evolution_applies` tables (`~/.halo/global/evo.db`)
3. ✅ Hidden agent infrastructure: `internal: true` field; filter in
   `list_agents` / `query_agent` / `start_session`; admin API surfaces it;
   admin sidebar shows them in a separate "Internal" section
4. ✅ Seed `__evo_agent__` and `__apply_agent__` agent.yaml + AGENT.md
   placeholders (full procedure in `AGENT.md` is still TODO — see step 9)
5. ✅ `/note` slash command — writes `runs/<id>/{meta,source-snapshot}.json` and INSERTs a `pending` row in `evolution_runs`. Hidden from `/help` when level≠L1 or user is readonly.
6. ✅ Pre-compact hook in `SessionManager.selfCompactSession()` — snapshots
   the session log + INSERTs `pending` row before the compaction LLM rewrites
   messages. Gated on `evolution.level=L1` + `triggers.pre_compact=true` +
   root sessions only. Helper extracted to `evolution/enqueue.ts` and reused
   by `/note`.
7. ✅ Server-side ticker (every 30s) — heartbeat timeout, atomic claim,
   `attempts` retry budget, placeholder spawner
8. ✅ Evo wrapper (Node) — mode=run. Spawns `halo cli -a __evo_agent__ -n
   -w <ws> "<brief>"`, heartbeats every 60s, translates exit code +
   patch.md/score.json existence into terminal db status
9. ✅ Wrapper-orchestrated 3-phase run mode (replaces the original "agent
   does everything" approach because Opus 4.7 wouldn't honour soft rules
   like "exactly one sub-cli call"):
   - **Phase A** — `__evo_agent__` drafts only: reads snapshot + current
     prompts, builds sandbox (whitelist), applies draft, writes patch.md
     with `testScenario` frontmatter (double field —
     `originalMessage` for scorer baseline lookup, `testMessage` for
     wrapper dry-run), exits. Does NOT run dry-runs or score itself.
   - **Phase B** — wrapper runs the dry-run: `timeout 180 halo cli -a
     <agentId> -n -w <sandbox> "<testScenario.testMessage>"`. On failure
     calls `__evo_agent__` back in fix mode with the error log + a "fix
     only, do NOT run" brief; one corrective pass (`FIX_BUDGET=1`).
     Successful dry-run stdout lands in `<runDir>/dry-run-output.txt`.
   - **Phase C** — `__score__` (separate agent, no shell_exec) reads
     patch.md + dry-run output + source-snapshot.json, writes
     score.json. Locates "before" baseline in snapshot via
     `testScenario.originalMessage`. No file edits beyond score.json.
     Reused at apply time as the regression gate.
   - **Internal-agent isolation**: agents flagged `internal: true`
     (evo, score, future apply) skip USER.md / INSTRUCTIONS.md /
     INDEX.md / prompts/all|root|bootstrap. Only their own AGENT.md +
     wrapper brief reaches the LLM. Reduces token cost and removes
     workspace-rule bleed-through.
   - **Language wiring**: wrapper resolves `general.language`
     (BCP-47) → `langHint` (`English` / `简体中文`), threads it into all
     three briefs as an *imperative* `Output language: write …` clause
     (passive `User language: …` headers were ignored by the LLM).
     Frontmatter keys / yaml schema stay English regardless.
   - **Whitelist sandbox cp**: only `INSTRUCTIONS.md / agents / prompts
     / skills` are copied into `<runDir>/sandbox/.halo/`. Other
     directories (sessions, db, logs, channels) are workspace state that
     the dry-run sub-cli rebuilds from scratch.
   - Backend route `readScoreAvg` reads `score.json` directly. Stale
     `score:` blocks in older patch.md frontmatter are ignored.
10. ✅ Admin Evolution tab UI (list / view / approve / reject). New top-level
    tab `Evolution` (Sparkles icon) renders a two-pane list+detail. Backend
    routes at `/api/evolution/runs` (list/detail) + `/approve` / `/reject` /
    `/hint`. Approve queues a pending `evolution_applies` row; nothing
    actually merges yet — that's phase 11/12.
11. ✅ Apply wrapper (Node) + `__apply_agent__/AGENT.md`, two sub-phases
    that mirror evo's run mode:
    - **Phase A' — merge**: wrapper builds a fresh sandbox by whitelist-cp
      from the **current main workspace**, then spawns
      `__apply_agent__` to merge all approved patches into it. Apply
      agent reasons over the platform override matrix (same knowledge
      as evo) so workspace-replaces-global cases (INSTRUCTIONS.md /
      AGENT.md / agent.yaml) get the whole-global-file copied first,
      and `prompts/<scope>/` adds copy the entire global directory
      first. reviewer_hint is a hard cap on what the agent will apply.
      Apply agent writes `apply.log` (audit trail) and edits
      `<applyDir>/sandbox/.halo/...` only.
    - **Phase B' — regress**: wrapper, NOT the agent, loops over
      `source_run_ids`. Per run: parses `testScenario` from the run's
      patch.md, runs `timeout 180 halo cli -a <agentId> -n -w
      <applyDir>/sandbox "<testMessage>"`, saves stdout to
      `regress/<runId>/dry-run-output.txt`, then spawns `__score__` to
      write `regress/<runId>/score.json`. `lint < 50` or `behavior <
      50` in any score → mark apply `failed`. All scores OK → continue
      to phase 12.
    - **Main workspace stays untouched throughout phase 11** — only
      `<applyDir>/sandbox/` holds the merged state.
12. ✅ Final sync. After phase B' all scores pass, the wrapper splits
    phase 12 into three checkpointed steps:
    - **Preflight**: walk sandbox, diff against main, snapshot pre-apply
      state of changed paths to `history/apply-<id>/` (with
      `MANIFEST.json`). Idempotent — on a resume, MANIFEST + history
      backup are skipped (the originals are already correct).
    - **Checkpoint**: write `evolution_applies.status='syncing'` BEFORE
      the dangerous step. From here on, a wrapper crash leaves the row
      in 'syncing' state; the ticker picks it up and respawns a wrapper
      that takes a resume branch (skipping all LLM-heavy phases A'/B').
    - **Publish**: cp each `changed` file from sandbox to main. Crash
      mid-cp is the only "real" failure mode — main may be half-applied,
      but `history/apply-<id>/` has the rollback material and the resume
      path will retry the cp (idempotent).

    On success: mark each `source_run_id` in `evolution_runs` as
    `applied` (with `applied_at` timestamp), then mark the apply row
    `applied`. **No "release in-memory sessions" step** — see
    [Session lifecycle](#session-lifecycle-cold-start-per-turn).

All 12 phases shipped. The L1 MVP loop now closes end-to-end:
`/note` or pre-compact → ticker spawns evo wrapper → patch.md +
score.json → reviewer approves in admin → apply wrapper merges +
regress-tests via `__score__` → phase 12 cps to main with history
snapshot → next user turn picks up the new prompts.

---

# Future levels

Sketches.

## L2

- Auto-apply patches with `score.avg >= 80 && confidence == 'high'` AND
  target ∈ {INSTRUCTIONS.md, custom prompts}. Same wrapper, just bypasses
  manual approve step (creates `evolution_applies` directly).
- Settings: `auto_apply_threshold: 80`, per-target opt-in flags.

## L3

- New patch kinds for yaml mutations (`tool-rewire`, `skill-rewire`).
- Idle trigger added.

## L4

- `agent-create`, `skill-create`, `archive` kinds.
- Curator periodic invocation that consolidates pending pile + active
  prompts.

---

# Decision log

- **Why L0/L1 ladder?** Each level has consistent risk profile; user mental
  model is simple ("I'm at L1").
- **Why ship L1 first?** Need real accept/reject data before automating
  anything.
- **Why a ticker, not server-internal scheduler with in-memory state?**
  Restart-safe; failure modes are simple (everything reads db).
- **Why heartbeat in wrapper, not in cli session?** Cli session focused on
  the LLM work — adding "must update db every minute" is a distraction.
  Wrapper is the right place for liveness.
- **Why two hidden agents instead of one?** They have different skills and
  different prompts. evo is "analyst + critic"; apply is "merger + validator".
  Splitting keeps each focused.
- **Why patch.md is natural-language, not a diff?** Multiple approvals merge
  better when the apply agent can reason about intent, not bytes.
- **Why apply agent writes to sandbox first, not directly?** Validation gate
  before main workspace gets touched. Test fails → main untouched. No
  half-applied state.
- **Why wrapper does the file sync, not the apply agent?**
  apply agent's job is to decide *what* the new state should look like.
  Wrapper does mechanical "publish the result". Cleaner separation.
- **Why no `releaseAllSessions` step in phase 12?** Halo's session
  cache is per-turn, not long-lived: `runSession`'s finally block
  releases the session as soon as its message turn finishes
  (`saveAgentState` + `Map.delete`). The next turn — channel reply,
  web reload, /new — runs `ensureSession` → `buildAgentInstance`,
  which re-reads `agent.yaml` + `INSTRUCTIONS.md` + `USER.md` from disk.
  So the just-applied changes pick up automatically on the next turn,
  for free, without anyone having to call a release hook.
  Currently-running turns finish on the old prompts — also the right
  behavior, because aborting a user mid-conversation would be a worse
  experience than a few seconds of "old rules apply to in-flight
  message". See [Session lifecycle: cold-start per turn](#session-lifecycle-cold-start-per-turn).
- **Why source-snapshot.json at trigger time?** User keeps chatting; live
  read would see moving target. Freezing the input is the easiest correctness
  guarantee.
- **Why no idle trigger?** User isn't there to react; pending appears later
  with no context recall. `/note` + pre-compact cover the live cases.
- **Why no hash check at apply time?** Apply agent rebuilds the file from
  current state + patch intent. The patch isn't a diff that can stale —
  it's an instruction the agent re-applies fresh.
- **Why allow evo to modify itself?** Same as software updates: blocking
  forever creates more harm than the rare bad self-edit. User reviews.
- **Why per-process wrappers vs in-server async?** Crash isolation; can
  add concurrency without server thread issues; survives server restart.

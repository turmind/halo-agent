# Agent Tool Reference

Agents have two tool categories: workspace tools (files, shell, search) and session tools (managing other sessions). Workspace tools are enabled by name in `agent.yaml`'s `tools` list; the session-tool bundle is granted automatically by a non-empty `team` (see [Session tools](#session-tools)).

## Workspace tools

File: `packages/server/src/tools/workspace-tools.ts`

> **Path resolution**: `file_read` / `file_write` / `file_edit` / `file_list`'s `path` argument resolves as: relative → workspace root; absolute → as-is; `~/` → home. The actual reachable set depends on the session's access level (see "Access level" below).

### file_read

Read file content.

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | yes | File path (relative / absolute / `~/`) |
| offset | integer | no | 1-based line to start at (default 1) |
| limit | integer | no | Number of lines to return (default 2000) |

Returns: string (`cat -n` format, 1-based line-number prefix per line). Files over 2 MB read without an explicit `offset`/`limit` range are **rejected** — grep to locate the section first, or page through with `offset`+`limit`.

### file_write

Write a file (creates parent dirs on demand).

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | yes | File path |
| content | string | yes | Content |

### file_edit

Replace a string in a file (exact match).

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | yes | File path |
| old_string | string | yes | The exact text to find |
| new_string | string | yes | The replacement |

### view_image

Read an image file and return it as a vision content block. Supports png/jpg/jpeg/gif/webp, max 5 MB.

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | yes | Image file path |

Returns: image content block (base64-encoded) for multimodal processing.

**Vision gating**: this tool is only injected into the agent's tool list when the underlying model declares `capabilities.image: true` in its provider manifest. For text-only models (DeepSeek and others), `view_image` is silently dropped at `createWorkspaceTools()` time so the model never sees it — calling it would otherwise produce a 400 from the provider.

### file_list

List directory entries. Output uses emoji prefixes (`📁` / `📄`). Skips `node_modules` and `.git`.

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | no | Directory path (default: workspace root) |
| recursive | boolean | no | Walk the whole subtree (default: false). DFS so entries stay grouped by parent. Capped at 500 entries — past that, a `[truncated]` line is appended and the agent is steered to `glob` instead. |

### shell_exec

Run a shell command. Full shell access.

| Arg | Type | Required | Description |
|---|---|---|---|
| command | string | yes | Shell command |

Timeout 600 s (`HALO_SHELL_TIMEOUT`). Max output 5 MB. The tool description surfaces the effective timeout to the agent and advises backgrounding (`nohup … &` + log polling) for longer tasks.

**Windows output encoding.** The Windows path (`sandbox.ts`) prepends `chcp 65001` so cmd built-ins (`echo`, …) emit UTF-8, then captures raw bytes (`encoding: 'buffer'`) and decodes them strict-UTF-8 with a GBK fallback. This is because native Win32 console tools (`ipconfig`, `systeminfo`, …) ignore `chcp` and still emit the OEM code page (GBK/CP936 on zh-CN); decoding such bytes as UTF-8 produced mojibake. The strict-UTF-8 attempt passes genuine UTF-8 through untouched and only falls back to GBK when the bytes aren't valid UTF-8 (GBK double-byte sequences almost always aren't). mac/Linux are unaffected (UTF-8 throughout).

### grep

Regex content search. Returns `file:line:content`.

| Arg | Type | Required | Description |
|---|---|---|---|
| pattern | string | yes | Regex |
| path | string | no | Search dir or a single file (default: workspace root) |
| include | string | no | Glob-like filename filter, e.g. `*.ts`, `*.{ts,tsx}`, or a comma-separated list `*.ts,*.tsx` |
| max_results | number | no | Max matching lines (default 50) |

Skips: `node_modules` / `.git` / `.next` / `dist` / `.halo` / binary files.

### glob

Find files by glob.

| Arg | Type | Required | Description |
|---|---|---|---|
| pattern | string | yes | Glob, e.g. `**/*.ts`, `src/**/*.tsx` |
| path | string | no | Starting dir (default: workspace root) |

Returns paths relative to workspace root, alphabetically. Same skip list as grep.

### web_fetch

HTTP request.

| Arg | Type | Required | Description |
|---|---|---|---|
| url | string | yes | URL |
| method | string | no | HTTP method (default GET) |
| headers | object | no | Optional request headers |

Timeout 10 s. Max body 50 KB (truncated if larger). Returns status + content-type + response body.

## Security

### Access level (per-session, dynamic)

Each session carries `accessLevel: 'readonly' | 'workspace' | null` (persisted in `agent_sessions.access_level`). Sub-sessions inherit their parent's access level. Access level is re-evaluated on every user message — if the channel account's access level has changed, the agent instance is rebuilt with the new tool set and sandbox config.

| Level | DB value | Tools (with bwrap) | Tools (without bwrap) | Sandbox |
|---|---|---|---|---|
| `null` (full) | `full` | All 9 tools | All 9 tools | None |
| `workspace` | `workspace` | All 9 tools | All 9 tools | bwrap: workspace rw, sensitive paths hidden |
| `readonly` | `readonly` | All 9 tools | file_read, view_image, file_list, grep, glob (5 tools) | bwrap: workspace ro, sensitive paths hidden |

`view_image` is additionally gated on `capabilities.image` (see its section above). Models without vision support get the same lists minus `view_image` — so a non-vision model on `readonly` ends up with 4 tools, not 5.

Enforcement layers:
1. **OS sandbox (bwrap)**: `--ro-bind / /` mounts the entire filesystem read-only, then configurable overlays hide sensitive paths (`--tmpfs` for directories, `--ro-bind /dev/null` for files). Workspace level adds `--bind` (rw) for the workspace directory. `--tmpfs /tmp` provides isolated writable temp per invocation. Tool execution uses `execFileAsync` (not shell) to prevent escape. Error messages are sanitized to strip sandbox internals — the agent never sees bwrap flags or mount details.
2. **Tool filtering (bwrap fallback only)**: when bwrap is unavailable, `createWorkspaceTools()` returns a reduced 5-tool set for readonly (no file_write, file_edit, shell_exec, web_fetch). Workspace retains all tools.
3. **App-level path validation (bwrap fallback only)**: `assertPathAllowed()` validates every path against workspace + `~/.halo/global/`; `shell_exec` is blocked entirely without bwrap for non-full sessions.

Dependency: `bubblewrap` (`apt install bubblewrap`) on Linux. Without it, only layers 2 + 3 are active.

### Sandbox hidden paths

Sensitive directories and files are hidden from workspace/readonly sessions via bwrap overlays. Paths that don't exist on the filesystem are silently skipped.

Configured in `settings.yaml` under `general.sandbox`:

| Setting | Default | Method |
|---|---|---|
| `hidden_dirs` | `~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker,~/.config/gh,~/.halo/global/internal-sessions,~/.halo/global/logs` | `--tmpfs` overlay (empty directory) |
| `hidden_files` | `~/.npmrc,~/.bash_history,~/.gitconfig,~/.git-credentials,~/.netrc,~/.halo/global/{evo,cron}.db` + their `-wal`/`-shm` files | `--ro-bind /dev/null` (empty file) |
| `writable_dirs` | (empty) | `--bind` read-write — for external CLIs that keep local state (e.g. `~/.kiro`); not applied to readonly sessions |

Changes take effect immediately — `config.ts` reads settings.yaml via an mtime-watched lazy cache, so the next `shell_exec` reads the latest values. These keys are `globalOnly` in the schema — a workspace `settings.yaml` cannot override them, since they define the security boundary agents run inside.

`/tmp` is not in the hidden list — it receives a standalone `--tmpfs` mount for process isolation (each bwrap invocation gets its own empty `/tmp`), not for hiding secrets.

Per-channel defaults:
- **Web** — inherits account's `access_level` (default `full`)
- **Telegram** — inherits account's `access_level` (default `readonly`)
- **WeChat** — inherits account's `access_level` (default `readonly`)

### Binary file detection
`grep` and `glob` read the first 512 bytes looking for a null byte and skip binaries.

### Tool result budget
The orchestrator truncates tool results over 8000 chars and appends a `[Content truncated]` hint telling the agent to use `grep` for a targeted search.

## Session tools

Session management tools for agents. **Not enabled by name** — the whole bundle (the eight tools below) is granted automatically the moment an agent declares a **non-empty `team`** in `agent.yaml`; an absent/empty `team` means no delegation (no session tools, no roster). Listing these under `tools:` has no effect. The `team` ids also scope who's reachable via `start_session` / `query_agent`. See [agent roster](../design/prompt-system.md#agent-roster).

**Own-tree scoping**: the five tools that take an existing `session_id` — `query_session`, `interrupt_session`, `stop_session`, `archive_session`, `get_session_output` — only act on sessions in the **caller's own session tree** (same root id, i.e. the same left-most `>` segment). A `session_id` from an unrelated tree is refused with `{"code": 1, "error": "session <id> not found"}` (phrased as not-found so it doesn't leak whether a foreign session exists). This keeps a multi-user/multi-channel shared workspace — where one `SessionManager` holds every user's trees — from letting one agent stop / archive / read another user's sessions. In-tree parent ↔ child ↔ sibling coordination is unaffected. See [session.md → By-id tool scoping](../design/session.md#by-id-tool-scoping).

### start_session

Start a sub-agent session asynchronously. When the sub-agent finishes, its **wrap-up reply** (the closing summary — not the mid-task progress narration) is auto-delivered back to the caller's conversation. A long summary is **cut head-kept / tail-dropped** at `limits.autoReportMax` (default 8,192 chars, settings `general.limits.auto_report_chars`) with a `[Report truncated: N chars total, showing first M. Use get_session_output("<id>") for the full result.]` marker — so the caller can tell a short answer from a cut-off one, and knows the **tail** is what's missing. Call `get_session_output` for the full untruncated reply. (Before 0.1.5 the auto-report concatenated every text segment of the turn, including mid-task filler.)

**Arguments**

| Arg | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent ID (e.g. `"coder"`) |
| `message` | string | yes | Task description |
| `system_prompt_context` | string | no | Extra context prepended to the initial message |
| `title` | string | no | Session title shown in the admin sidebar. When omitted, auto-generated from the task message (first 60 chars of `description`). |
| `working_dir` | string | no | Sub-agent's focus directory (absolute or workspace-relative; default: project root). It's persistent session identity (stored in the DB, restored on resume), so the directory-chain `.halo/INSTRUCTIONS.md` along the path root→dir is baked into the sub-agent's **system prompt every turn** (it never forgets the directory's rules), and the prompt is tagged with this focus. Does **not** change where tools run. |

**Output (JSON string)**

- Success: `{"code": 0, "session_id": "<childSessionId>"}`
- Unknown agent: `{"code": 1, "error": "agent \"<id>\" not found..."}`
- Depth exceeded: `{"code": 1, "error": "Maximum nesting depth (N) reached..."}`
- Working dir invalid: `{"code": 1, "error": "working_dir \"...\" is outside the workspace"}` (or does-not-exist / not-a-directory)

UI note: the `agent_start` event this emits carries both a 200-char `text` preview (parent-side rendering) and the full un-truncated brief as `fullText`, which seeds the sub-session log's opening user message — so viewing the child session shows the complete task brief (`system_prompt_context` + `message`), not a cut-off preview. See [session.md → Event routing](../design/session.md#event-routing).

### session_list

List direct child sessions of the current session and their status.

No arguments. Returns JSON:

```json
{
  "code": 0,
  "sessions": [
    {
      "id": "root>sid_xxx",
      "agentId": "coder",
      "agentName": "Coder",
      "title": "Implement login page",
      "description": "Implement login page",
      "status": "running",
      "createdAt": 1714000000000
    }
  ],
  "count": 1
}
```

`status`: `running` / `idle` / `stopped`. Archived sessions are excluded.

`title` is the human-assigned label (set by renaming the session in the admin
sidebar), read from the per-session jsonl log so it matches what the UI shows.
It falls back to `description` (the `start_session` task summary) when no title
was set, so the field is never empty — lets a caller dispatch work by title.

### query_session

Send a message to another session. Idle = immediate run, busy = queued + soft interrupt. Reply is delivered asynchronously.

| Arg | Type | Required | Description |
|---|---|---|---|
| `target_session_id` | string | yes | Target session ID |
| `message` | string | yes | Message content |

**Busy = soft interrupt (merge-answer parity)**: when the target is busy, `query_session` enqueues the message **and** requests a soft interrupt (same as a user message arriving mid-turn) — the in-flight turn unwinds after its current tool, then every message that landed alongside it drains as **one merged turn**. So a sub-agent asked two questions while busy answers them **together**, not one-by-one — matching how root folds two user messages. No message is dropped. (Before 0.1.4 a busy `query_session` was pure no-interrupt enqueue, which made sub-agents reply one question at a time.)

**Queue cap (backpressure)**: when the target is busy, `query_session` is rejected with `{"code": 1, "error": "...message queue is full (N/max)..."}` once the target's queued **agent-sourced** messages reach `session.maxQueueSize` (default 256, settings `general.session.max_queue_size`). The cap counts **only agent→agent entries** — user messages share the same queue but are immune to backpressure (a human can't hand-type up to the cap, and counting them would let user chatter consume the agents' budget). `interrupt_session` is a deliberate action and bypasses the cap entirely.

### interrupt_session

Equivalent to `query_session` **plus an immediate abort** of the in-flight turn. The message is enqueued and traced right away (exactly like `query_session`); aborting then makes the queue drain **now** rather than after the current turn finishes, so the enqueued message is folded into the very next merged turn. The abort is hard — it propagates to `shell_exec` and SIGTERMs a command mid-execution (contrast the soft interrupt `query_session` and a busy user message trigger, which wait for the current `tool_result`). For a **compound** command (`sleep 60 && …`) under `full` access, the kill reaches the real worker because the command runs as a **process-group leader** and the whole group is signalled — before 0.1.4 the abort only hit the wrapping `/bin/sh`, leaving the worker to orphan and run to completion (which made `interrupt_session` look like it didn't interrupt). See [session.md → Process-group kill on abort](../design/session.md#process-group-kill-on-abort). Conversation history is preserved (repaired, not discarded), and `interrupt_session` bypasses the `query_session` queue cap.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to interrupt |
| `message` | string | yes | Message to run after interruption |

### stop_session

Abort the current task of a running session. Any queued messages are **not** dropped — they are folded into the conversation history before the abort, so nothing said while the session was busy is lost. The session stays usable — later `query_session` calls continue the conversation.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to stop |

### archive_session

**Cascade** archive a session and every descendant. Aborts running work, clears queued messages. Archived sessions disappear from `session_list` and cannot be reached by `query_session`. Only use it when the whole subtree is done.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to archive |

### get_session_output

Read the **complete, untruncated** text of an agent session's reply to its **most recent message** — the full response spanning every step taken for that message (one message can drive many steps: narration → tool calls → more narration), which is more than the possibly-cut auto-report. Scoped to that one message's reply, not the session's whole history. Excludes tool calls/results and thinking — those only ever stream to the UI, never into the output.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to read |

Implementation: a turn (one `runAgentTurn`, processing one inbound message) accumulates text into **two** per-turn buffers, both reset at the turn's start:

- `session.output` — **all** assistant text of the turn (mid-task filler + wrap-up). This is what `get_session_output` returns and what is persisted to disk.
- `session.finalOutput` — **only** the wrap-up reply (text emitted when `stopReason !== 'tool_use'`, flagged by the agent-loop `final` event field). This feeds the auto-report to the parent (`tryReportToParent`), falling back to `session.output` when the turn ended without a closing message.

In-memory sessions return `session.output`; released sessions read the `output` field from `.halo/sessions/{agentId}/{sid}.json`. `get_session_output` never truncates — only the auto-report does (see [start_session](#start_session)). (Split introduced in 0.1.5; before that both reads shared one `session.output`.)

### query_agent

Get an agent's full details: AGENT.md, model config, tools, skills. Use it before `start_session` to decide if an agent fits. Team-gated: an agent can only inspect agents on its own roster (the `team` whitelist — see [agent roster](../design/prompt-system.md#agent-roster)); querying a non-team agent is rejected.

| Arg | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent to query |

### activate_skill

**Auto-injected — not declared in `agent.yaml tools`.** Generated by `createSkillTool()` whenever the YAML lists `skills`. Disabled skills (per workspace DB `disabled_items` table) are excluded from injection.

| Arg | Type | Required | Description |
|---|---|---|---|
| `skill_id` | string | yes | Skill to activate |

Returns: full SKILL.md content (body + resource files list). For progressive disclosure — the system prompt only contains skill metadata (name + description); the agent calls this tool on demand.

## Goal tools

Injected **only** for the built-in `goal` agent (G) — `session-agent-builder` swaps in this set (`buildGoalTools`, `agents/goal-mode.ts`) instead of the standard session bundle when the session's agent is `GOAL_AGENT_ID`. Every callback re-reads goal state from the workspace db (never a cached copy), so a halt / pause / clear that landed while G was mid-turn is enforced on its next tool call. See [design/goal-mode.md](../design/goal-mode.md).

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

Read the full latest-turn output of the worker or any session in the worker's subtree (evidence gathering — round reports are truncated at `limits.autoReportMax`). Scoped to the worker's tree; works regardless of goal status.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Worker session id or a descendant (`worker>child`) id |

## Self-review tool

### draft

**Opt-in self-review.** Declare `draft` in `agent.yaml`'s `tools:` to give an agent a way to critique its own answer before committing. Built by `createDraftTool()` (`tools/draft-tool.ts`); no global switch — agents that don't list it never see it.

| Arg | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | The complete draft answer. Required and must be non-empty |

The tool **description is deliberately plain** — "Submit a draft answer for self-review; returns a checklist that critiques the draft." It does NOT say *when* to call it (no "call this for complex questions / when unsure"). An earlier version that did embed such self-referential guidance made some models (notably GPT-5.x) thrash. Steering toward *using* draft belongs in the agent's prompt files (the bundled `default` agent's AGENT.md says "hold your answers to a high standard… don't reply off the cuff" — it lives in AGENT.md because the yaml `system_prompt` is only a fallback when the MD layer is empty), not in the tool description. Empty `content` is rejected with an error **without consuming a draft round**.

**Why it exists:** the agent loop only makes another model call when the model emits a `tool_use` block. A plain-text answer (`end_turn`) is single-pass — `thinking` runs *before* the answer in the same call, so the model never gets to look at its *finished* answer and revise it. `draft` closes that gap without touching the loop: the model writes its answer into `content` (materialised into the conversation as a `tool_use` block — uncapped, never echoed back), and the tool_result hands back an adversarial review checklist (framed as a hostile reviewer: list every factual claim and tag its source, verify the unverified ones with tools *now*, check directness/tone, flag gaps). The next model call then critiques that now-concrete draft and either revises (calls `draft` again) or writes the final answer.

**Bounded by a per-turn counter**, not a prompt instruction (which would just be context noise). After 3 drafts in one turn the tool soft-lands: it stops returning the checklist and tells the model to finalise. The counter lives in the tool's closure; `SessionManager.runAgentTurn` calls the tool's `reset()` at the top of every turn-attempt (so a retry gets a fresh budget). The agent instance is reused across turns, so without this reset the budget would leak across the whole session.

**Scope note:** `draft` improves answers the model *knows* it should be careful about (it must choose to call the tool). It can't catch over-confident answers where the model doesn't realise it's wrong — that gap needs a post-turn judge (out of scope here).

## Tool assignment

Workspace tools are enabled strictly by name in `agent.yaml`'s `tools` list:

```yaml
tools:
  - file_read
  - shell_exec
skills:
  - code-review    # auto-injects activate_skill
```

Tools not listed are not injected. Session/delegation tools do **not** go in `tools:` — they ride on a non-empty `team` (see [Session tools](#session-tools) above). `activate_skill` is auto-injected whenever the YAML lists `skills` (no need to put it in `tools`).

There is **no implicit default tool set**: `filterTools()` (in `agent-loader.ts`) returns only the tools whose names appear in `agent.yaml`'s `tools:` list. If the field is absent or empty, the agent has zero workspace tools. The admin UI's "Create agent" form scaffolds a fresh agent with an empty `tools: []` for the same reason — fill it in deliberately. The `default` agent's bundled `agent.yaml` lists the common set (`file_read` / `file_write` / `file_edit` / `view_image` / `file_list` / `shell_exec` / `grep` / `glob` / `web_fetch`) that most agents will want, plus `draft` (see Self-review tool above); copy that line if you're starting from scratch.

## Config

| Config key | Default | Purpose |
|---|---|---|
| `timeout.shellExec` | 600,000 ms | Shell command timeout |
| `timeout.webFetch` | 10,000 ms | HTTP timeout |
| `limits.shellOutputBuffer` | 5 MB | Shell output buffer |
| `limits.webFetchMaxBody` | 50 KB | web_fetch body cap |
| `limits.grepDefaultMax` | 50 | Default grep result cap |
| `limits.toolResultMax` | 8,000 chars | Tool result truncation threshold |

Defined in `packages/server/src/config.ts`.

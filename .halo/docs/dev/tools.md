# Agent Tool Reference

Agents have two tool categories: workspace tools (files, shell, search) and session tools (managing other sessions). Enable them by name in `agent.yaml`'s `tools` list.

## Workspace tools

File: `packages/server/src/tools/workspace-tools.ts`

> **Path resolution**: `file_read` / `file_write` / `file_edit` / `file_list`'s `path` argument resolves as: relative → workspace root; absolute → as-is; `~/` → home. The actual reachable set depends on the session's access level (see "Access level" below).

### file_read

Read file content.

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | yes | File path (relative / absolute / `~/`) |

Returns: string.

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

Timeout 120 s (`HALO_SHELL_TIMEOUT`). Max output 5 MB.

**Windows output encoding.** The Windows path (`sandbox.ts`) prepends `chcp 65001` so cmd built-ins (`echo`, …) emit UTF-8, then captures raw bytes (`encoding: 'buffer'`) and decodes them strict-UTF-8 with a GBK fallback. This is because native Win32 console tools (`ipconfig`, `systeminfo`, …) ignore `chcp` and still emit the OEM code page (GBK/CP936 on zh-CN); decoding such bytes as UTF-8 produced mojibake. The strict-UTF-8 attempt passes genuine UTF-8 through untouched and only falls back to GBK when the bytes aren't valid UTF-8 (GBK double-byte sequences almost always aren't). mac/Linux are unaffected (UTF-8 throughout).

### grep

Regex content search. Returns `file:line:content`.

| Arg | Type | Required | Description |
|---|---|---|---|
| pattern | string | yes | Regex |
| path | string | no | Search dir (default: workspace root) |
| include | string | no | Glob-like filename filter, e.g. `*.ts`, `*.{ts,tsx}` |
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
| `hidden_dirs` | `~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker` | `--tmpfs` overlay (empty directory) |
| `hidden_files` | `~/.npmrc,~/.bash_history,~/.gitconfig` | `--ro-bind /dev/null` (empty file) |

Changes take effect immediately — `config.ts` reads settings.yaml via an mtime-watched lazy cache, so the next `shell_exec` reads the latest values. A workspace-level `settings.yaml` can override these the same way it overrides any other key (no global-scope lock).

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

Session management tools for agents. Enable them by name in `agent.yaml`'s `tools`.

### start_session

Start a sub-agent session asynchronously. When the sub-agent finishes, its **wrap-up reply** (the closing summary — not the mid-task progress narration) is auto-delivered back to the caller's conversation. A long summary is **cut head-kept / tail-dropped** at `limits.autoReportMax` (default 8,192 chars, settings `general.limits.auto_report_chars`) with a `[Report truncated: N chars total, showing first M. Use get_session_output("<id>") for the full result.]` marker — so the caller can tell a short answer from a cut-off one, and knows the **tail** is what's missing. Call `get_session_output` for the full untruncated reply. (Before 0.1.5 the auto-report concatenated every text segment of the turn, including mid-task filler.)

**Arguments**

| Arg | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent ID (e.g. `"coder"`) |
| `message` | string | yes | Task description |
| `system_prompt_context` | string | no | Extra context prepended to the initial message |
| `working_dir` | string | no | Sub-agent's focus directory (absolute or workspace-relative; default: project root). On the sub-agent's **first turn**, the directory-scoped `.halo/INSTRUCTIONS.md` along the path root→dir is injected, and the prompt is tagged with this focus. Does **not** change where tools run. |

**Output (JSON string)**

- Success: `{"code": 0, "session_id": "<childSessionId>"}`
- Unknown agent: `{"code": 1, "error": "agent \"<id>\" not found..."}`
- Depth exceeded: `{"code": 1, "error": "Maximum nesting depth (N) reached..."}`
- Working dir invalid: `{"code": 1, "error": "working_dir \"...\" is outside the workspace"}` (or does-not-exist / not-a-directory)

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
      "description": "Implement login page",
      "status": "running",
      "createdAt": 1714000000000
    }
  ],
  "count": 1
}
```

`status`: `running` / `idle` / `stopped`. Archived sessions are excluded.

### query_session

Send a message to another session. Idle = immediate run, busy = queued + soft interrupt. Reply is delivered asynchronously.

| Arg | Type | Required | Description |
|---|---|---|---|
| `target_session_id` | string | yes | Target session ID |
| `message` | string | yes | Message content |
| `scope` | string | no | Workspace-relative directory whose `.halo/INSTRUCTIONS.md` (root→dir path) is injected into **this message only** — one-shot, doesn't persist to the target's later turns, doesn't change where tools run |

**Busy = soft interrupt (merge-answer parity)**: when the target is busy, `query_session` enqueues the message **and** requests a soft interrupt (same as a user message arriving mid-turn) — the in-flight turn unwinds after its current tool, then every message that landed alongside it drains as **one merged turn**. So a sub-agent asked two questions while busy answers them **together**, not one-by-one — matching how root folds two user messages. No message is dropped. (Before 0.1.4 a busy `query_session` was pure no-interrupt enqueue, which made sub-agents reply one question at a time.)

**Queue cap (backpressure)**: when the target is busy, `query_session` is rejected with `{"code": 1, "error": "...message queue is full (N/max)..."}` once the target's queued **agent-sourced** messages reach `session.maxQueueSize` (default 256, settings `general.session.max_queue_size`). The cap counts **only agent→agent entries** — user messages share the same queue but are immune to backpressure (a human can't hand-type up to the cap, and counting them would let user chatter consume the agents' budget). `interrupt_session` is a deliberate action and bypasses the cap entirely.

### interrupt_session

Equivalent to `query_session` **plus an immediate abort** of the in-flight turn. The message is enqueued and traced right away (exactly like `query_session`); aborting then makes the queue drain **now** rather than after the current turn finishes, so the enqueued message is folded into the very next merged turn. The abort is hard — it propagates to `shell_exec` and SIGTERMs a command mid-execution (contrast the soft interrupt `query_session` and a busy user message trigger, which wait for the current `tool_result`). For a **compound** command (`sleep 60 && …`) under `full` access, the kill reaches the real worker because the command runs as a **process-group leader** and the whole group is signalled — before 0.1.4 the abort only hit the wrapping `/bin/sh`, leaving the worker to orphan and run to completion (which made `interrupt_session` look like it didn't interrupt). See [session.md → Process-group kill on abort](../design/session.md#process-group-kill-on-abort). Conversation history is preserved (repaired, not discarded), and `interrupt_session` bypasses the `query_session` queue cap.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to interrupt |
| `message` | string | yes | Message to run after interruption |
| `scope` | string | no | Workspace-relative directory whose `.halo/INSTRUCTIONS.md` (root→dir path) is injected into the re-run message only (one-shot; doesn't change where tools run) |

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

### list_agents

List every available agent (global + workspace). Disabled agents (per workspace DB `disabled_items` table) and internal agents (`internal: true` in agent.yaml — e.g. self-evolution agents) are excluded. No arguments, returns JSON.

### query_agent

Get an agent's full details: AGENT.md, model config, tools, skills. Use it before `start_session` to decide if an agent fits.

| Arg | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent to query |

### activate_skill

**Auto-injected — not declared in `agent.yaml tools`.** Generated by `createSkillTool()` whenever the YAML lists `skills`. Disabled skills (per workspace DB `disabled_items` table) are excluded from injection.

| Arg | Type | Required | Description |
|---|---|---|---|
| `skill_id` | string | yes | Skill to activate |

Returns: full SKILL.md content (body + resource files list). For progressive disclosure — the system prompt only contains skill metadata (name + description); the agent calls this tool on demand.

## Self-review tool

### draft

**Opt-in self-review.** Declare `draft` in `agent.yaml`'s `tools:` to give an agent a way to critique its own answer before committing. Built by `createDraftTool()` (`tools/draft-tool.ts`); no global switch — agents that don't list it never see it.

| Arg | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | The complete draft answer. Required and must be non-empty |

The tool **description is deliberately plain** — "Submit a draft answer for self-review; returns a checklist that critiques the draft." It does NOT say *when* to call it (no "call this for complex questions / when unsure"). An earlier version that did embed such self-referential guidance made some models (notably GPT-5.x) thrash. Steering toward *using* draft belongs in the agent's `system_prompt` (e.g. the bundled `default` agents say "hold your answers to a high standard… don't reply off the cuff"), not in the tool description. Empty `content` is rejected with an error **without consuming a draft round**.

**Why it exists:** the agent loop only makes another model call when the model emits a `tool_use` block. A plain-text answer (`end_turn`) is single-pass — `thinking` runs *before* the answer in the same call, so the model never gets to look at its *finished* answer and revise it. `draft` closes that gap without touching the loop: the model writes its answer into `content` (materialised into the conversation as a `tool_use` block — uncapped, never echoed back), and the tool_result hands back an adversarial review checklist (framed as a hostile reviewer: list every factual claim and tag its source, verify the unverified ones with tools *now*, check directness/tone, flag gaps). The next model call then critiques that now-concrete draft and either revises (calls `draft` again) or writes the final answer.

**Bounded by a per-turn counter**, not a prompt instruction (which would just be context noise). After 3 drafts in one turn the tool soft-lands: it stops returning the checklist and tells the model to finalise. The counter lives in the tool's closure; `SessionManager.runAgentTurn` calls the tool's `reset()` at the top of every turn-attempt (so a retry gets a fresh budget). The agent instance is reused across turns, so without this reset the budget would leak across the whole session.

**Scope note:** `draft` improves answers the model *knows* it should be careful about (it must choose to call the tool). It can't catch over-confident answers where the model doesn't realise it's wrong — that gap needs a post-turn judge (out of scope here).

## Tool assignment

Workspace tools are enabled strictly by name in `agent.yaml`'s `tools` list:

```yaml
tools:
  - file_read
  - shell_exec
  - start_session
  - session_list
  - query_session
skills:
  - code-review    # auto-injects activate_skill
```

Tools not listed are not injected. `activate_skill` is auto-injected whenever the YAML lists `skills` (no need to put it in `tools`).

There is **no implicit default tool set**: `filterTools()` (in `agent-loader.ts`) returns only the tools whose names appear in `agent.yaml`'s `tools:` list. If the field is absent or empty, the agent has zero workspace tools. The admin UI's "Create agent" form scaffolds a fresh agent with an empty `tools: []` for the same reason — fill it in deliberately. The `default` agent's bundled `agent.yaml` lists the common set (`file_read` / `file_write` / `file_edit` / `view_image` / `file_list` / `shell_exec` / `grep` / `glob` / `web_fetch`) that most agents will want, plus `draft` (see Self-review tool above); copy that line if you're starting from scratch.

## Config

| Config key | Default | Purpose |
|---|---|---|
| `timeout.shellExec` | 120,000 ms | Shell command timeout |
| `timeout.webFetch` | 10,000 ms | HTTP timeout |
| `limits.shellOutputBuffer` | 5 MB | Shell output buffer |
| `limits.webFetchMaxBody` | 50 KB | web_fetch body cap |
| `limits.grepDefaultMax` | 50 | Default grep result cap |
| `limits.toolResultMax` | 8,000 chars | Tool result truncation threshold |

Defined in `packages/server/src/config.ts`.

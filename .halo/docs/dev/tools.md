# Agent Tool Reference

Agents have two tool categories: workspace tools (files, shell, search) and session tools (managing other sessions). Workspace tools are enabled by name in `agent.yaml`'s `tools` list; the session-tool bundle is granted automatically by a non-empty `team` (see [Session tools](#session-tools)). A third, opt-in set — [Relay tools](#relay-tools) — reaches sessions in *other* workspaces on the same server.

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

Replace a string in a file (exact match). Fails when `old_string` is empty, identical to `new_string`, not found, or (without `replace_all`) found more than once.

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | yes | File path |
| old_string | string | yes | The exact text to find |
| new_string | string | yes | The replacement |
| replace_all | boolean | no | Replace every occurrence (default: false) |

### view_image

Read an image file and return it as a vision content block. Supports png/jpg/jpeg/gif/webp.

| Arg | Type | Required | Description |
|---|---|---|---|
| path | string | yes | Image file path |

Returns: a text line (`Image loaded: <path> (<media type>, <KB>, md5: …)`) plus an image content block (base64-encoded) for multimodal processing.

Processing before the bytes go out — only the payload changes, the file on disk is never touched:

- **Decode check**: png/jpeg/gif are decoded with jimp first. A corrupt or truncated file returns an error and is not sent, because a bad image block in history makes every later request fail. webp has no jimp codec and skips this check.
- **Media type from bytes**: `media_type` is taken from the file's magic bytes, not its extension, so a JPEG saved as `.png` is labeled correctly.
- **Downscale**: when the base64 is over 5 MB (Anthropic's per-image limit) or the long edge is over 1568 px, the long edge is scaled to 1568 and the image is re-encoded as JPEG, starting at q82 and stepping down until it fits.
- **Large PNG → JPEG** (1.4.4): an opaque PNG over 256 KB is re-encoded as JPEG q82 and sent that way if it comes out smaller. This matches the admin upload path, which sends every attachment as JPEG. The image stays in history and is re-sent with every later request, and PNG renders are often 5–15× their JPEG size. Example: 31 Blender renders at 896×896 went from 24.3 MB to 1.4 MB; the largest was 86 KB. Transparent PNGs (JPEG would lose the alpha channel), PNGs of 256 KB or less, and flat-color PNGs that don't shrink are sent as-is. The result line then reads `— sent as jpeg q82, <KB> KB, to keep the conversation payload small`.

How many images history can hold in total is capped separately at the session level — see [design/session.md → History image budget](../design/session.md#history-image-budget).

**Vision gating**: this tool is only injected into the agent's tool list when the underlying model declares `capabilities.image: true` in its provider manifest (or the agent's `model.image` in `agent.yaml` overrides it). For text-only models (DeepSeek and others), `view_image` is silently dropped at `createWorkspaceTools()` time so the model never sees it — calling it would otherwise produce a 400 from the provider.

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

Timeout 120 s (`HALO_SHELL_TIMEOUT`). Max output 5 MB. The tool description surfaces the effective timeout to the agent and advises backgrounding (`nohup … &` + log polling) for longer tasks.

**Windows output encoding.** The Windows path (`sandbox.ts`) prepends `chcp 65001` so cmd built-ins (`echo`, …) emit UTF-8, then captures raw bytes (`encoding: 'buffer'`) and decodes them strict-UTF-8 with a GBK fallback. This is because native Win32 console tools (`ipconfig`, `systeminfo`, …) ignore `chcp` and still emit the OEM code page (GBK/CP936 on zh-CN); decoding such bytes as UTF-8 produced mojibake. The strict-UTF-8 attempt passes genuine UTF-8 through untouched and only falls back to GBK when the bytes aren't valid UTF-8 (GBK double-byte sequences almost always aren't). mac/Linux are unaffected (UTF-8 throughout).

### grep

Regex content search. Returns `file:line:content`.

| Arg | Type | Required | Description |
|---|---|---|---|
| pattern | string | yes | Regex |
| path | string | no | Search dir or a single file (default: workspace root) |
| include | string | no | Glob-like filename filter, e.g. `*.ts`, `*.{ts,tsx}`, or a comma-separated list `*.ts,*.tsx` |
| max_results | number | no | Max matching lines (default 50) |

Skips: `node_modules` / `.git` / `.next` / `dist` / binary files. `.halo/` itself IS walked (it holds the agent's knowledge base — memory/, docs/, INSTRUCTIONS.md, skills/); only its machine-generated subtrees `sessions/ logs/ evo/ tmp/ assets/ canvas/` are skipped, and only when the direct parent is `.halo` — a project's own `logs/` or `tmp/` is still searched.

### glob

Find files by glob.

| Arg | Type | Required | Description |
|---|---|---|---|
| pattern | string | yes | Glob, e.g. `**/*.ts`, `src/**/*.tsx` |
| path | string | no | Starting dir (default: workspace root) |

Returns paths relative to workspace root, alphabetically; stops collecting at 5,000 matches. Same skip list as grep.

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

Each session carries `accessLevel: 'readonly' | 'workspace' | null` (persisted in `agent_sessions.access_level`). Sub-sessions inherit their parent's access level. Access level is re-evaluated on every user message — if the channel account's access level has changed, the agent instance is rebuilt with the new tool set and sandbox config. In the admin, the level comes from the chat-input selector: the `chat` WS frame carries `accessLevel`, and `handleChat` applies it on the idle path (`'full'`, or any level on a host without an OS sandbox → `null`; a message queued behind a running turn keeps the level that turn was built with).

| Level | DB value | Tools (with OS sandbox) | Tools (without) | Sandbox |
|---|---|---|---|---|
| `null` (full) | `NULL` | All 9 tools | All 9 tools | None (rm guard still applies) |
| `workspace` | `workspace` | All 9 tools | All 9 tools | workspace rw, sensitive paths + workspace runtime state hidden |
| `readonly` | `readonly` | All 9 tools | file_read, view_image, file_list, grep, glob (5 tools) | workspace ro, sensitive paths + workspace runtime state hidden |

`view_image` is additionally gated on `capabilities.image` (see its section above). Models without vision support get the same lists minus `view_image` — so a non-vision model on `readonly` ends up with 4 tools, not 5.

OS sandbox backend per platform — `getSandboxBackend()` in `sandbox.ts` returns `'bwrap' | 'seatbelt' | null` after the boot probe (`initBwrapCheck()`), logged at startup as `[Server] OS sandbox: …` and exposed as `sandbox` on `GET /api/health`:

| Platform | `shell_exec` | File tools | Dependency |
|---|---|---|---|
| Linux | bwrap | bwrap | `bubblewrap` (`apt install bubblewrap`); the probe runs a real sandboxed no-op, so an install that can't create namespaces (Ubuntu 24.04 AppArmor userns restriction) counts as unavailable |
| macOS | Seatbelt (`/usr/bin/sandbox-exec -p <profile>`) | in-process, behind `assertPathAllowed` | none — ships with macOS (Apple marks it deprecated, but it's present on every release). The probe runs `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` |
| Windows | none | none | — see below |

Enforcement layers:
1. **OS sandbox**
   - **bwrap (Linux)**: `--ro-bind / /` mounts the entire filesystem read-only, then configurable overlays hide sensitive paths (`--tmpfs` for directories; files are covered by `--ro-bind ~/.halo/.sandbox-empty <file>`, a zero-byte file created on demand — **not** `/dev/null`, whose bind reads as EACCES inside bwrap and makes git abort on `~/.gitconfig`). Workspace level adds `--bind` (rw) for the workspace directory. `--tmpfs /tmp` provides isolated writable temp per invocation. `--clearenv` + a minimal `PATH` / `HOME` / `TERM`.
   - **Seatbelt (macOS)**: `buildSeatbeltProfile()` emits `(allow default)` → `(deny file-write*)` → `(allow file-write*)` for the workspace + `writable_dirs` + `/private/tmp`, `/private/var/folders`, `/dev` (readonly: temp dirs and `/dev` only) → `(deny file-read* file-write*)` on every hidden path (global lists + workspace-relative set; `subpath` for dirs, `literal` for files). Later rules win in SBPL, so the final hidden deny overrides the write allow. Paths are realpath'd (Seatbelt matches `/private/tmp`, not `/tmp`). The child gets a minimal env with `GIT_CONFIG_GLOBAL=/dev/null` and `NPM_CONFIG_USERCONFIG=/dev/null` so git / npm don't trip over the denied `~/.gitconfig` / `~/.npmrc`. Unlike bwrap there's no private `/tmp` — writes there persist.
   - Both backends pass the host git identity (`git config --global user.name/user.email`, read once at boot) as `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so `git commit` works with `~/.gitconfig` hidden. Nothing else from the host git config crosses over.
   - Tool execution uses `execFileAsync` / `spawn` (not shell) to prevent escape. Error messages are sanitized to strip sandbox internals — the agent never sees bwrap flags or mount details.
   - When a non-full `shell_exec` fails with a write-denial (`Read-only file system` / `Operation not permitted` / `Permission denied` / `EROFS` / `EPERM`), the tool result gets a `[Sandbox] This session runs at "<level>" access: …` hint telling the agent to ask the user to switch to Full in the chat input box, rather than retrying variations.
2. **Tool filtering (no OS sandbox only)**: when `getSandboxBackend()` is `null`, `createWorkspaceTools()` returns a reduced 5-tool set for readonly (no file_write, file_edit, shell_exec, web_fetch). Workspace retains all tools.
3. **In-process path validation**: `assertPathAllowed()` gates every file-tool path whenever the file tools don't run inside bwrap (macOS always; Linux without bwrap). Same rules as the OS sandbox: **read** anywhere except the hidden sets (global + workspace-relative), **write** only to the workspace (minus the hidden set) and `writable_dirs`, readonly never writes. Paths are realpath'd first, so a symlink is judged by its target. Without any OS sandbox, `shell_exec` is blocked entirely for non-full sessions.

On Linux without bwrap only layers 2 + 3 are active.

#### rm guard

`assertRmSafe(command, workspaceRoot)` runs before every `shell_exec` at **every** access level (full included) on every platform except Windows — the OS sandbox limits where writes land, but not a mistyped `rm -r` inside the writable area. It refuses an `rm` / `rmdir` whose target resolves to:
- `/`, `$HOME`, `~/.halo`, the workspace root, or any parent of those
- a system directory or its direct child (`/etc`, `/usr`, `/var`, `/home`, `/opt`, … plus macOS `/Applications`, `/Library`, `/System`, `/Users`, `/Volumes`, `/private`)
- `/tmp`, `/private/tmp`, `/root` themselves (their children are ordinary deletes — `/root` is `$HOME` in most containers)

Parsing: the command is split into simple commands on unquoted `;` `&` `|` newline, quotes stripped, heredoc bodies skipped (they're data being written, not commands). Leading wrappers / keywords (`sudo`, `env`, `xargs`, `nohup`, `time`, `if`/`then`/`do`/`while`, `VAR=…` assignments) are skipped to find the real command; `cd` earlier in the line moves the base for relative targets (default base = workspace root). `~`, `$HOME`, `$PWD` / `$(pwd)` expand; any other variable or substitution expands to empty — its value when unset, which is how `rm -rf "$DIR/"` goes wrong. A glob meaning "everything in X" (`*`, `.*`, `**`) is judged by X; narrower globs (`*.log`) pass. A block throws `[Sandbox] rm blocked: "<word>" resolves to <path>, which is <reason>. Name the specific files or subdirectories to delete instead.` It's a heuristic against mistakes, not a parser — `eval`, `bash -c "…"`, scripts and command substitution aren't followed.

**Windows has no sandbox.** There is no bwrap / Seatbelt equivalent, so `sandbox.ts` (`normalizeOptsForPlatform`) promotes every non-full call to `full` before it reaches layer 1 or layer 3 — `assertPathAllowed()` returns immediately without checking the workspace boundary or the hidden-path lists, and the rm guard is skipped (cmd syntax, no `rm`). Only layer 2 (tool filtering) survives, because `getSandboxBackend()` is always `null` there. The admin's access-level selector reads `sandbox: null` from `/api/health` and locks itself to Full. Net effect on Windows:

| Level | Effective behavior on Windows |
|---|---|
| `full` | Unchanged |
| `workspace` | **Same as `full`** — all 9 tools, `shell_exec` runs unsandboxed, file tools can read/write any path the halo process can |
| `readonly` | 5 read-only tools (no write / shell / fetch), but **no path boundary** — `file_read` / `grep` / `glob` can reach anything on disk, including `~/.halo/secrets/` and `.halo/sessions/` |

This is a known, unfixed gap (not a bug in a specific route): don't hand out `workspace` / `readonly` channel tokens on a Windows-hosted server expecting isolation — treat them as `full` and `read-anything` respectively. Fixing it properly needs a Windows path-boundary check in `assertPathAllowed` and a Windows equivalent of the shell sandbox, neither of which exists yet.

### Sandbox hidden paths

Sensitive directories and files are hidden from workspace/readonly sessions via bwrap overlays / Seatbelt deny rules (and the same lists gate `assertPathAllowed` for in-process file tools). Under bwrap a hidden file reads as empty and a hidden dir as an empty directory; under Seatbelt both are denied outright. Paths that don't exist on the filesystem are silently skipped. Two categories coexist:

**Global lists (built-in + configurable extras)** — credentials and cross-workspace state. The built-in lists are code constants in `sandbox.ts` (`DEFAULT_HIDDEN_DIRS` / `DEFAULT_HIDDEN_FILES`, the single source) and are always included in the effective lists (which apply to workspace/readonly sessions only — Full sessions skip the sandbox entirely); `settings.yaml` `general.sandbox.hidden_dirs` / `hidden_files` hold extra entries that are **appended** (deduped) — they never replace the built-ins, so a built-in entry cannot be removed from the list in settings. `config.ts` `resolveSandboxPaths()` builds the effective lists for both the server and the CLI:

| Setting | Built-in (always included) | Method |
|---|---|---|
| `hidden_dirs` | `~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker,~/.config/gh,~/.halo/global/internal-sessions,~/.halo/global/logs` | bwrap `--tmpfs` overlay (empty directory); Seatbelt `subpath` deny |
| `hidden_files` | `~/.npmrc,~/.bash_history,~/.gitconfig,~/.git-credentials,~/.netrc,~/.halo/global/{evo,cron,runs}.db` + their `-wal`/`-shm` files | bwrap `--ro-bind ~/.halo/.sandbox-empty` (reads as empty); Seatbelt `literal` deny |
| `writable_dirs` | (empty) | bwrap `--bind` read-write / Seatbelt write allow — for external CLIs that keep local state (e.g. `~/.kiro`); not applied to readonly sessions |

Changes saved through the settings API (admin Settings page, `PUT` / `PATCH` / `DELETE /api/settings`) take effect immediately — the save fires `onSettingsChange`, which re-reads the lists into `sandbox.ts` (`setSandboxHiddenPaths`), so the next tool call uses them. A hand edit of `settings.yaml` is not watched for these keys: it applies at the next restart or the next API save. These keys are `globalOnly` in the schema — a workspace `settings.yaml` cannot override them, since they define the security boundary agents run inside.

**Workspace-relative set (hardcoded)** — the workspace's own runtime state, which holds other channels'/users' conversations on a shared workspace. Code constants in `sandbox.ts` (`WORKSPACE_HIDDEN_DIRS` / `WORKSPACE_HIDDEN_FILES`), deliberately not settings: this is a security boundary (a config edit must not be able to open it), and the entries are workspace-relative while the settings lists are absolute/`~` paths.

| Constant | Entries | Method |
|---|---|---|
| `WORKSPACE_HIDDEN_DIRS` | `.halo/sessions` (session transcripts), `.halo/logs`, `.halo/evo` (run dirs contain full source-session snapshots) | `--tmpfs` overlay / Seatbelt `subpath` deny |
| `WORKSPACE_HIDDEN_FILES` | `.halo/halo.db` + `-wal`/`-shm` (sqlite `agent_sessions` rows) | `--ro-bind ~/.halo/.sandbox-empty` / Seatbelt `literal` deny |

The rest of `.halo/` (INSTRUCTIONS.md, INDEX.md, docs/, memory/, skills/, agents/, prompts/, tmp/, canvas/, settings.yaml) stays readable — it's workspace knowledge agents need to work. `full` sessions bypass the sandbox entirely and see everything.

`/tmp` is not in the hidden list — under bwrap it receives a standalone `--tmpfs` mount for process isolation (each invocation gets its own empty `/tmp`), not for hiding secrets. Seatbelt has no mount namespace, so on macOS `/tmp` is the real one and writes to it persist.

Per-channel defaults: every channel session (Web, Telegram, Slack, Feishu, WeCom, WeChat) inherits its account's `access_level` — `full` → full, `workspace` → workspace, `readonly` / `observer` → readonly — and new accounts default to `readonly` (DB column default, `insertAccount` fallback and the admin create forms). Level sources for every entry point (admin, cron, cli, relay, goal, sub-agents): [guide/delegation-and-access.md](../guide/delegation-and-access.md#where-a-sessions-level-comes-from).

### Binary file detection
`grep` reads the first 512 bytes of each file looking for a null byte and skips binaries (`glob` matches paths only and never opens files).

### Tool result budget
The orchestrator truncates tool results over 8000 chars and appends a `[Content truncated]` hint telling the agent to use `grep` for a targeted search. `activate_skill` results are exempt — a SKILL.md body is instructions, not data, and the built-in cron / self skills exceed 8K.

## Session tools

Session management tools for agents. **Not enabled by name** — the whole bundle (the eight tools below) is granted automatically the moment an agent declares a **non-empty `team`** in `agent.yaml`; an absent/empty `team` means no delegation (no session tools, no roster). Listing these under `tools:` has no effect. The `team` ids also scope who's reachable via `start_session` / `query_agent`. See [agent roster](../design/prompt-system.md#agent-roster). `activate_skill` and `continue_task` at the end of this section are **not** part of the team-gated bundle — the former is gated on `skills`, the latter is unconditional.

**Own-tree scoping**: the five tools that take an existing `session_id` — `query_session`, `interrupt_session`, `stop_session`, `archive_session`, `get_session_output` — only act on sessions in the **caller's own session tree** (same root id, i.e. the same left-most `>` segment). A `session_id` from an unrelated tree is refused with `{"code": 1, "error": "session <id> not found"}` (phrased as not-found so it doesn't leak whether a foreign session exists). This keeps a multi-user/multi-channel shared workspace — where one `SessionManager` holds every user's trees — from letting one agent stop / archive / read another user's sessions. In-tree parent ↔ child ↔ sibling coordination is unaffected. See [session.md → By-id tool scoping](../design/session.md#by-id-tool-scoping).

### start_session

Start a sub-agent session asynchronously. When the sub-agent finishes, its **wrap-up reply** (the closing summary — not the mid-task progress narration) is auto-delivered back to the caller's conversation. A long summary is **cut head-kept / tail-dropped** at `limits.autoReportMax` (default 8,192 chars, settings `general.limits.auto_report_chars`) with a `[Report truncated: N chars total, showing first M. Use get_session_output("<id>") for the full result.]` marker — so the caller can tell a short answer from a cut-off one, and knows the **tail** is what's missing. Call `get_session_output` for the rest — it keeps the tail when it has to cut, so the two are complementary. (Before 0.1.5 the auto-report concatenated every text segment of the turn, including mid-task filler.)

**Arguments**

| Arg | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent ID (e.g. `"coder"`) |
| `message` | string | yes | The brief (goal + done criteria, decisions made in the conversation, known facts, boundaries, verification commands — see the tool description) |
| `system_prompt_context` | string | no | Extra context prepended to the initial message |
| `title` | string | no | Session title shown in the admin sidebar. When omitted, auto-generated from the task message (first 60 chars of `description`). |
| `working_dir` | string | no | Sub-agent's focus directory (absolute or workspace-relative; default: project root). It's persistent session identity (stored in the DB, restored on resume), so the directory-chain `.halo/INSTRUCTIONS.md` along the path root→dir is baked into the sub-agent's **system prompt every turn** (it never forgets the directory's rules), and the prompt is tagged with this focus. Does **not** change where tools run. |

**Output (JSON string)**

- Success: `{"code": 0, "session_id": "<childSessionId>"}`
- Unknown agent: `{"code": 1, "error": "agent \"<id>\" not found..."}`
- Agent outside the caller's `team`: `{"code": 1, "error": "agent \"<id>\" is not in your team..."}`
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
      "parentId": "root",
      "agentId": "coder",
      "agentName": "Coder",
      "description": "Implement login page",
      "status": "running",
      "accessLevel": null,
      "goalSessionId": null,
      "createdAt": 1714000000000,
      "updatedAt": 1714000005000,
      "stoppedAt": null,
      "archivedAt": null,
      "title": "Implement login page",
      "exchangeCount": 1,
      "contextTokens": 12345,
      "totalOutputTokens": 678
    }
  ],
  "count": 1
}
```

`status`: `running` / `idle` / `stopped`. Archived sessions are excluded.

Each entry is the session's `SessionInfo` row. `title` is the human-assigned
label (set by renaming the session in the admin sidebar) mirrored onto the row
from the session file, so it matches what the UI shows. It falls back to
`description` (the `start_session` task summary) when no title was set, so the
field is never empty — lets a caller dispatch work by title.

### query_session

Send a message to another session. Idle = immediate run, busy = queued + soft interrupt. Reply is delivered asynchronously.

| Arg | Type | Required | Description |
|---|---|---|---|
| `target_session_id` | string | yes | Target session ID |
| `message` | string | yes | Message content |

**Busy = soft interrupt (merge-answer parity)**: when the target is busy, `query_session` enqueues the message **and** requests a soft interrupt (same as a user message arriving mid-turn) — the in-flight turn finishes its current batch of tool calls and unwinds before its next model call, then every message that landed alongside it drains as **one merged turn**. So a sub-agent asked two questions while busy answers them **together**, not one-by-one — matching how root folds two user messages. No message is dropped. (Before 0.1.4 a busy `query_session` was pure no-interrupt enqueue, which made sub-agents reply one question at a time.)

**Queue cap (backpressure)**: when the target is busy, `query_session` is rejected with `{"code": 1, "error": "...message queue is full (N/max)..."}` once the target's queued **agent-sourced** messages reach `session.maxQueueSize` (default 256, settings `general.session.max_queue_size`). The cap counts **only agent→agent entries** — user messages share the same queue but are immune to backpressure (a human can't hand-type up to the cap, and counting them would let user chatter consume the agents' budget). `interrupt_session` is a deliberate action and bypasses the cap entirely.

### interrupt_session

Equivalent to `query_session` **plus an immediate abort** of the in-flight turn. The message is enqueued and traced right away (exactly like `query_session`); aborting then makes the queue drain **now** rather than after the current turn finishes, so the enqueued message is folded into the very next merged turn. The abort is hard — it propagates to `shell_exec` and SIGTERMs a command mid-execution (contrast the soft interrupt `query_session` and a busy user message trigger, which wait for the current tool batch to finish). Of a cut parallel batch, the call that was running gets the do-not-retry `[tool execution interrupted …]` result and the calls that never started get a "was not run … safe to re-issue" result. For a **compound** command (`sleep 60 && …`) under `full` access, the kill reaches the real worker because the command runs as a **process-group leader** and the whole group is signalled — before 0.1.4 the abort only hit the wrapping `/bin/sh`, leaving the worker to orphan and run to completion (which made `interrupt_session` look like it didn't interrupt). See [session.md → Process-group kill on abort](../design/session.md#process-group-kill-on-abort). Conversation history is preserved (repaired, not discarded), and `interrupt_session` bypasses the `query_session` queue cap.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to interrupt |
| `message` | string | yes | Message to run after interruption |

### stop_session

Abort the current task of a running session. Any queued messages are **not** dropped — they are folded into the conversation history before the abort, so nothing said while the session was busy is lost. The session stays usable — later `query_session` calls continue the conversation. Refused with `{"code": 1}` (no stop) when `session_id` is the caller's own session or one of its ancestors — the stop would wait on the very turn making the call; to end its own work an agent just finishes its turn.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to stop |

### archive_session

**Cascade** archive a session and every descendant. Aborts running work, clears queued messages. Archived sessions disappear from `session_list` and cannot be reached by `query_session`. Only use it when the whole subtree is done. Refused with `{"code": 1}` (nothing archived) when `session_id` is the caller's own session or one of its ancestors, for the same reason as `stop_session`.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to archive |

### get_session_output

Read the text of an agent session's reply to its **most recent message** — the full response spanning every step taken for that message (one message can drive many steps: narration → tool calls → more narration), which is more than the possibly-cut auto-report. Scoped to that one message's reply, not the session's whole history. Excludes tool calls/results and thinking — those only ever stream to the UI, never into the output.

| Arg | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session to read |

**Output (JSON string)**: `{ "code": 0, "status": "running" | "idle" | "stopped", "output": "...", "last_activity_at": "<ISO>" | null }`. `status` is `running` while a turn is in flight (`promise !== null`), `stopped` when the row carries `stopped_at` (sub-agent reported / user stopped), otherwise `idle`. `last_activity_at` is the wall-clock time of the turn's most recent text / `tool_call` / `tool_result` event (reset to `null` at each turn start) — together with `status` it tells the caller whether a long-running session is still alive or has silently stalled. Unknown / out-of-tree id → `{"code": 1, "error": "session <id> not found"}`.

**Truncation keeps the tail.** When `output` exceeds `limits.toolResultMax` (minus 500 chars of envelope headroom) it is cut **head-first** with a `[Output truncated: N chars total, showing LAST M. Earlier text omitted.]` marker up front — the conclusion lives at the end, and the generic head-keep tool-result cap used to eat exactly that (plus the trailing JSON fields). The auto-report's cut is the opposite (head-kept, see [start_session](#start_session)), so the two are complementary: report shows the opening, `get_session_output` shows the ending. (Before 1.2.0 the tool returned the bare output string with no status and the generic head-keep truncation.)

Implementation: a turn (one `runAgentTurn`, processing one inbound message) accumulates text into **two** per-turn buffers, both reset at the turn's start:

- `session.output` — **all** assistant text of the turn (mid-task filler + wrap-up). This is what `get_session_output` returns and what is persisted to disk.
- `session.finalOutput` — **only** the wrap-up reply (text emitted when `stopReason !== 'tool_use'`, flagged by the agent-loop `final` event field). This feeds the auto-report to the parent (`tryReportToParent`), falling back to `session.output` when the turn ended without a closing message.

In-memory sessions return `session.output` / `session.lastActivityAt`; released sessions read the `output` / `lastActivityAt` fields from `.halo/sessions/{agentId}/{sid}.json` (both written by `saveAgentState`). (Split introduced in 0.1.5; before that both reads shared one `session.output`.)

### query_agent

Show an agent's name, description, model, tool list and skill descriptions — enough to decide whether it fits before `start_session`. Does not include AGENT.md (read `.halo/agents/<id>/AGENT.md` for behavior rules). Team-gated: an agent can only inspect agents on its own roster (the `team` whitelist — see [agent roster](../design/prompt-system.md#agent-roster)); querying a non-team agent is rejected.

| Arg | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent to query |

### activate_skill

**Auto-injected — not declared in `agent.yaml tools`.** Generated by `createSkillTool()` whenever the YAML lists `skills`. Disabled skills (per workspace DB `disabled_items` table) are excluded from injection.

| Arg | Type | Required | Description |
|---|---|---|---|
| `skill_id` | string | yes | Skill to activate |

Returns: full SKILL.md content (body + resource files list). For progressive disclosure — the system prompt only contains skill metadata (name + description); the agent calls this tool on demand.

### continue_task

**Built-in for every agent — the one truly unconditional tool** (`activate_skill` is gated on `skills`, session tools on `team`; not declared in `agent.yaml tools`). Wired in `session-agent-builder` (`buildContinueTaskTool`, next to the session bundle). No parameters.

Call it when the current turn was started by an interruption (a user / parent message landed while the agent was working) and the interrupted task is **not** finished: after the current reply ends, `drainQueue` pushes a synthetic `[System] You called continue_task: … resume it now` user turn (traced as a `user` row, `report: true`) and runs one more turn. Only effective in a turn that followed an interrupt — in a normal turn it returns `not_interrupted` and sets nothing (kicks ≤ interrupts). The flag lasts one turn: a second interrupt before the kick resets it and the model is told to call again if still needed. An esc / `/interrupt` (abort without a new message) never kicks; Stop / delete / archive clear it; a callback landing after Stop gets `code: 1` (`no_turn`). The description asks the model to write its reply to the interrupting message **first**, then call the tool. At turn end, whenever another turn follows (the kick, or a message already queued) and the turn was an answer (`continue_task` called, or a natural end_turn), the turn's whole text is forwarded as an **interim report** when the interrupting message came from the parent (sub-agent → `[Interim report · status: still running] …` via `query_session`, no `stoppedAt`) or from a relay caller (root → `[Relay interim report · … · status: still running]`) — the final auto-report / relay report still follows once. The same applies to the opening turn when a follow-up is already queued by the time it ends.

Returns: `{ code: 0, message }` on `set` / `not_interrupted`, `{ code: 1, error }` on `no_turn`. Design in [design/session.md → continue_task](../design/session.md#message-queue-and-drain).

## Relay tools

File: `packages/server/src/agents/relay.ts` (`buildRelayTools`). Design notes in [design/relay.md](../design/relay.md).

Cross-**workspace** dispatch on the same server: a "secretary" agent in workspace S hands a message to a session in workspace D and gets the result pushed back when D is done, no polling. Everything is in-process via the server's `SessionManagerRegistry` (`setRelayRegistry` in `index.ts`) — no HTTP, no tokens. The CLI / TUI never set the registry, so there every relay tool returns `{"code": 1, "error": "relay is not available in the CLI / TUI — it only runs inside halo server. This is permanent for this runtime, not a temporary outage: do not retry. …"}` — the message goes on to point the user at the admin UI / an IM or Web channel, or `halo tui -w <workspace path>` on the target workspace.

**Enabling**: opt-in by the single name `relay_send` in `agent.yaml`'s `tools:` — `session-agent-builder` sees that name and injects the whole set (`relay_send` / `relay_interrupt` / `relay_stop` / `relay_read` / `relay_list`), the other four names are not recognised on their own. **Full-access sessions only** (`accessLevel === null`): a `workspace` / `readonly` session listing `relay_send` gets nothing, because the tools reach into other workspaces' sqlite and session trees. The admin Agents tool picker shows one `relay_send` chip whose description names the whole set (`GET /agent-configs/tools` builds it from `buildRelayTools` against a dummy target).

**Common arguments** (every tool except `relay_list`, where it is optional): `workspace` — absolute path of the target workspace on this server (realpath'd; must contain `.halo/`, else `{"code": 1, "error": "not a halo workspace (no .halo/): …"}`); `session_id` — session id inside that workspace.

**Scope**: the target may be the caller's **own** workspace too — there is no "must be different" check, so relay doubles as a `query_session` without the own-tree scoping (any root session, not just the caller's tree). Reports are only delivered for **root** targets (`parentId === null`); a `parent>child` id receives the message but its wrap-up goes to its parent, never back to the caller.

### relay_send

Dispatch a message to a session in another workspace. Creates the session if `session_id` does not exist there (root session, agent `agent_id` or the target workspace's default agent, description `Relay: <first 60 chars>`), stamps the target row's `reply_to` with `{ workspace: <caller ws>, sessionId: <caller session> }`, appends the raw message to the target's UI transcript and sends it prefixed `[channel: relay | from: <caller ws>]\n\n<message>` — so the target agent knows the message came from another workspace's agent, not the admin UI, and doesn't echo the tag. Busy target → the message is **queued + soft interrupt** (same as `query_session` / a user message mid-turn: the current batch of tool calls finishes, then the queue drains as one merged turn), so follow-ups and corrections ride the same tool. Returns immediately. When `workspace` is the caller's own workspace, a `session_id` naming the caller itself or one of its ancestors is refused (`{"code": 1}`, nothing sent, `reply_to` untouched) — its report would come back into the caller's own tree; other sessions in the same workspace are fine.

| Arg | Type | Required | Description |
|---|---|---|---|
| `workspace` | string | yes | Target workspace path |
| `session_id` | string | yes | Target session id (created if missing) |
| `message` | string | yes | The message to deliver |
| `agent_id` | string | no | Agent to create the session with when it does not exist yet; default = the target workspace's default agent |

Returns `{ "code": 0, "workspace": "<realpath>", "session_id": "…", "state": "running" | "queued" }`.

**Report delivery**: when the target root's turn ends **and its subtree is quiet** (no active children in the db, empty message queue — the same gate `tryReportToParent` uses, so a nested dispatch tree reports exactly once, at the end), `deliverRelayReport` (fourth hook in `runSession`'s finally) appends + sends into the caller session:

```
[Relay report · workspace <target ws> · session <id> · status: completed]

<target's finalOutput || output>
```

Body capped at `limits.autoReportMax` (head-kept) with a `[Report truncated: N chars total. Use relay_read("<ws>", "<id>") for the full text.]` marker. A turn killed by an unrecoverable error carries `· status: aborted]` in the header and is prefixed `[RELAY TARGET ABORTED: … Error: <text> … Re-send with relay_send to let it resume.]` **before** the cap so it can't be sliced off. When the error is an account problem (401/402/403, bad key, no balance), the closing hint instead says it is a model account / credential / balance / permission problem in the target workspace: retrying or re-sending fails the same way, so fix its model configuration (or tell the user to) and do not resume it with `relay_send` until then. `reply_to` is cleared **before** sending: one dispatch → one report, a failed delivery can't double-fire on the next turn end, and a user chatting directly in the department workspace afterwards never pings the secretary.

**Interim report**: if a busy target answers a follow-up `relay_send` in a turn that another turn follows — it called `continue_task` to resume what it was doing, or a further relay message was already queued when the answer ended (also on the opening turn), or the target was waiting on its own sub-agents when asked and the run ended on the answer with a sub-agent still running — the answer is delivered right away as

```
[Relay interim report · workspace <ws> · session <id> · status: still running] This is an interim reply — the session is still working; its final [Relay report] follows when done. Do not treat this as the result.

<the turn's whole text, capped at limits.autoReportMax>
```

**without** clearing `reply_to` — so the final report still arrives once. Match on the `[Relay report` / `[Relay interim report` prefixes or the `status:` field, never on the trailing sentence. Only relay-prefixed messages trigger it; a user chatting directly in the department workspace never does. Details in [design/relay.md → Interim report](../design/relay.md#interim-report-continue_task).

### relay_interrupt

`relay_send` **plus a hard abort** of the target's in-flight turn — `interrupt_session` semantics across workspaces: the message is enqueued first, and if the target was busy (`state === 'queued'`) its turn is aborted immediately (propagates to `shell_exec`, SIGTERMs the process group) so the drain picks the message up now instead of after the current step. Enqueue-then-abort order matters: the finally never sees an empty queue and so never fires a spurious relay report. Idle target → behaves exactly like `relay_send` (`interrupted: false`). Unlike `relay_send` it does **not** create a missing session (`{"code": 1, "error": "session not found"}`) — there is nothing to interrupt. Use it when the target is heading the wrong way and waiting for its current step is not acceptable; for ordinary follow-ups prefer `relay_send`. Same own-workspace self / ancestor refusal as `relay_send`.

| Arg | Type | Required | Description |
|---|---|---|---|
| `workspace` | string | yes | Target workspace path |
| `session_id` | string | yes | Target session id (must exist) |
| `message` | string | yes | The message the target runs after the abort |

Returns `{ "code": 0, "workspace", "session_id", "state": "running" | "queued", "interrupted": boolean }`.

### relay_stop

Cascades `stopSession` on the target session and its sub-agents. If the target was mid-turn the caller still receives a relay report describing where it was cut off (the stop ends the turn → finally → `deliverRelayReport`, with the partial trace as body). When `workspace` is the caller's own workspace, a `session_id` naming the caller itself or one of its ancestors is refused (`{"code": 1}`, no stop) — same rule as `stop_session`; the same id in another workspace is a different session and stops normally.

| Arg | Type | Required | Description |
|---|---|---|---|
| `workspace` | string | yes | Target workspace path |
| `session_id` | string | yes | Target session id (must exist) |

### relay_read

The target workspace's [get_session_output](#get_session_output) — same `{ code, status, output, last_activity_at }` shape and tail-keeping truncation. Use it to check on progress or to fetch the full text after a truncated relay report.

| Arg | Type | Required | Description |
|---|---|---|---|
| `workspace` | string | yes | Target workspace path |
| `session_id` | string | yes | Target session id |

### relay_list

List a workspace's **root** sessions — most recently active first, capped at 100, archived rows excluded — so the caller can find an existing session to `relay_send` into (instead of minting a new id every time) or see what a department is currently working on. `workspace` is optional and defaults to the caller's own workspace, which makes it a `session_list` for roots you don't own (the standard `session_list` only shows your direct children).

| Arg | Type | Required | Description |
|---|---|---|---|
| `workspace` | string | no | Workspace path; omit for the current workspace |

Returns `{ "code": 0, "workspace": "<realpath>", "sessions": [{ id, agentId, agentName, title, status, createdAt, updatedAt }], "count": N }`. `title` falls back to `description` like `session_list`; `status` follows the list semantics (`running` when the root itself or any live child is mid-turn, `stopped` when the row is stamped, else `idle`).

## Tool assignment

Workspace tools are enabled strictly by name in `agent.yaml`'s `tools` list:

```yaml
tools:
  - file_read
  - shell_exec
skills:
  - code-review    # auto-injects activate_skill
```

Tools not listed are not injected. Session/delegation tools do **not** go in `tools:` — they ride on a non-empty `team` (see [Session tools](#session-tools) above). `activate_skill` is auto-injected whenever the YAML lists `skills` (no need to put it in `tools`), and `continue_task` is auto-injected for **every** agent unconditionally (see [continue_task](#continue_task)). The relay set is the one name-gated bundle: listing `relay_send` alone brings `relay_interrupt` / `relay_stop` / `relay_read` / `relay_list` with it, full-access sessions only (see [Relay tools](#relay-tools)).

There is **no implicit default tool set**: `filterTools()` (in `agent-loader.ts`) returns only the tools whose names appear in `agent.yaml`'s `tools:` list. If the field is absent or empty, the agent has zero workspace tools. The admin UI's "Create agent" form scaffolds a fresh agent with an empty `tools: []` for the same reason — fill it in deliberately. The `default` agent's bundled `agent.yaml` lists the common set (`file_read` / `file_write` / `file_edit` / `view_image` / `file_list` / `shell_exec` / `grep` / `glob` / `web_fetch`) that most agents will want; copy that line if you're starting from scratch.

## Config

| Config key | Default | Purpose |
|---|---|---|
| `timeout.shellExec` | 120,000 ms | Shell command timeout |
| `timeout.webFetch` | 10,000 ms | HTTP timeout |
| `limits.shellOutputBuffer` | 5 MB | Shell output buffer |
| `limits.webFetchMaxBody` | 50 KB | web_fetch body cap |
| `limits.grepDefaultMax` | 50 | Default grep result cap |
| `limits.toolResultMax` | 8,000 chars | Tool result truncation threshold (`activate_skill` exempt) |

Defined in `packages/server/src/config.ts`.

# Storage Protocol

Defines the persisted-data format for every Halo surface. Format changes must respect the compatibility rules in this doc.

## Directory layout

```
~/.halo/                              # Global (user-level)
├── global/                            # Non-sensitive config + data
│   ├── INSTRUCTIONS.md                # Global instructions (injected into every agent)
│   ├── USER.md                        # User profile (bootstrap-generated)
│   ├── prompts/                       # User-editable system prompts (externalised)
│   │   ├── bootstrap/BOOTSTRAP.md     # First-run guidance
│   │   ├── all/                       # Every agent (TOOL_GUIDELINES.md, TOOL_SHELL[.windows].md, WORKSPACE_CONVENTIONS.md, RUNTIME.md)
│   │   └── root/                      # Root agent only (DELEGATION.md, WORKSPACE_MEMORY.md)
│   ├── agents/<id>/
│   │   ├── agent.yaml                 # Agent config
│   │   └── AGENT.md                   # Agent personality
│   ├── models/                        # Model registry, bundled — one file per provider, overwritten on template refresh
│   │   └── <providerId>.yaml          # e.g. aws-bedrock-claude-invoke.yaml
│   ├── models.d/                      # Hub-installed provider yamls (`/extension models`); never touched by seeding
│   │   └── <providerId>.yaml          # merged with models/ by revision (see Model registry format)
│   ├── skills/<id>/
│   │   └── SKILL.md                   # Skill definition (frontmatter + body)
│   ├── internal-sessions/             # Internal-agent sessions (`__evo_agent__`, `__score__`, `__apply_agent__`)
│   │   ├── halo.db                    #   their agent_sessions rows — global so they don't pollute any workspace's halo.db
│   │   └── <agentId>/<seg>.ui.jsonl …  #   same files as a workspace session (see Session files)
│   ├── evo.db                         # Cross-workspace evolution queue (evolution_runs + evolution_applies)
│   ├── cron.db                        # Cross-workspace cron jobs + run history (cron_jobs + cron_runs; schema in design/cron.md, migrations below)
│   ├── runs.db                        # Run ledger: (workspace, session_id) rows for server-driven runs in flight; steady state empty (running_sessions)
│   ├── a2a.db                         # A2A: inbound tasks, push configs + outbox, outbound dispatches (see design/a2a.md)
│   ├── extensions/<id>/               # Installed Canvas preview extensions (halo-extension.json + bundle)
│   ├── stt-models/                    # On-device STT model files, downloaded on demand (see design/stt-local.md)
│   │   ├── sense-voice-zh-en-ja-ko-yue-2024-07-17/   # model.int8.onnx + tokens.txt (in-progress downloads: <file>.part)
│   │   └── silero-vad-v4/silero_vad.onnx
│   ├── logs/                          # Runtime logs (server.log)
│   │   ├── evo/                       # Per-evo-run wrapper logs
│   │   └── cron/                      # Per-cron-run cli stdout/stderr (30-day retention)
│   ├── server.lock                    # Single-instance pid lock
│   └── .template-version              # Template-seed marker (used by ensureHaloHome)
├── secrets/                           # Sensitive files (not mounted into sandbox)
│   ├── settings.yaml                  # Global settings (API keys, credentials)
│   ├── config.yaml                    # System config (admin password, server settings)
│   ├── a2a-remotes.yaml               # A2A remote list (server-wide, full-only; see design/a2a.md)
│   ├── server.env                     # Env snapshot for the systemd user unit (600), rewritten by `halo server start -d` / `restart`
│   └── channels/
│       └── channels.db                # Channel accounts DB

~/.config/systemd/user/halo.service   # Outside ~/.halo: the user unit `halo server start -d` writes on Linux with systemd

<workspace>/.halo/                    # Workspace-level (overrides same-name global configs)
├── USER.md                             # Optional, overrides global
├── INSTRUCTIONS.md                    # Project-level instructions (overrides global INSTRUCTIONS.md)
├── INDEX.md                            # Project overview + doc index (always injected)
├── agents/<id>/                       # Workspace agent (overrides same-id global)
├── skills/<id>/
├── prompts/                            # System prompts (directory-level override of global)
│   ├── bootstrap/                     # Overrides ~/.halo/global/prompts/bootstrap/ if present
│   ├── all/                           # Overrides ~/.halo/global/prompts/all/ if present
│   └── root/                          # Overrides ~/.halo/global/prompts/root/ if present
├── sessions/<agentId>/                # Session files: <seg>.ui.jsonl, <seg>.raw.jsonl, <seg>.ui.arch.<N>.<h>.jsonl.gz
├── memory/                             # Project memory (dated entries)
├── canvas/self.html                   # Agent's visual face — platform-owned, force-copied on every open (design/express-self.md)
├── goal/<goalId>/                     # Retained legacy goal-mode artifacts (GOAL_SPEC.md + decision-<n>.md); existing goals unchanged
├── logs/
├── evo/                                # Self-evolution per-workspace artifacts
│   ├── runs/<id>/                     #   per-evaluation: source-snapshot.json, tool-flow.md,
│   │                                  #   evo-context.json, sandbox/, patch.md, score.json,
│   │                                  #   sub-cli.log, optional .skip.md
│   ├── applies/<id>/                  #   per-apply: meta.json, sandbox/, regress/<runId>/, apply.log
│   ├── history/apply-<id>/            #   pre-apply rollback snapshot (MANIFEST.json + the overwritten files)
│   └── archive/                       #   zipped runs/applies past the retention window
├── tmp/                                 # Agent scratch files (logs, downloads, intermediate artifacts) — convention from TOOL_GUIDELINES
├── assets/<channel>/inbound/<accountId>/<date>/  # Inbound media per channel (image/voice/video/file)
├── runtime.lock                       # Workspace runtime ownership marker (pid) — see below
├── halo.db                           # Per-workspace sqlite (sessions metadata, disabled-items)
├── a2a.db                            # AgentCore mode only: A2A tasks + push outbox (instead of ~/.halo/global/a2a.db) — design/agentcore.md
├── runs.db                           # AgentCore mode only: the run ledger (instead of ~/.halo/global/runs.db)
├── agentcore.lease                   # AgentCore mode only: single-writer heartbeat lease file
└── docs/                               # Project docs (requirements/design/dev/test/plans)
```

**When `.halo/` is created.** `ensureWorkspaceHalo()` (`init.ts`) creates `sessions/ agents/ skills/ logs/ memory/ canvas/ tmp/ evo/{runs,applies,history}` and copies in `canvas/self.html`. It runs each time a directory is opened as a workspace: `POST /api/fs/workspace/resolve` (the admin folder picker), channel account binding, `/workspace switch`, and every `SessionManagerRegistry.getOrCreate()` / `getWorkspaceDb()` call. `halo.db` appears the first time the workspace db is opened. `runtime.lock` appears when the server first claims the runtime. Read-only list routes (`GET /api/sessions/logs`, `GET /api/agent-configs`) call `hasWorkspaceHalo()` first. For a directory with no `.halo/` they return an empty or global-only list, so a list request never turns a directory into a workspace. The cron form's path field used to scaffold every real directory the user typed through. Show routes use `registry.peek()` for the same reason (see [halo-city.md](halo-city.md)). Any new read-only route that takes a workspace path should do the same.

Precedence: workspace > global, **at folder granularity**. For the same id, a workspace `agents/<id>/` or `skills/<id>/` folder entirely replaces the global one — every file in it, no per-file fallback to global (a workspace agent folder with only `AGENT.md` loses the global `agent.yaml`). Same whole-folder rule for `prompts/{bootstrap,all,root}/` (workspace scope directory replaces the global one). INSTRUCTIONS.md is the single-file exception: workspace root suppresses global.

### Path constructors

All `.halo/...` path math goes through `packages/server/src/paths.ts` (e.g. `wsHaloDir(ws)`, `wsEvoRunDir(ws, runId)`, `globalInternalSessionFile(agentId, seg)`, `cronLogFile(runId)`). Treat `paths.ts` as the canonical reference for the layout above; if the layout changes, update `paths.ts` first and call sites follow.

Most builders are workspace-rooted (`ws*`), but the evo tree also needs the
layout *inside* one run/apply dir, so four builders take the **artifact dir**
instead of `(workspace, id)`: `evoSandboxDir(artifactDir)`,
`evoSandboxHaloDir(artifactDir)`, `evoRegressDir(applyDir)`,
`evoRegressRunDir(applyDir, runId)`. Run mode and apply mode lay their sandbox
out identically inside their own dir, which is why one signature serves both.
They replaced ~40 inline `path.join(ws, '.halo', 'evo', …)` sites across
archive / enqueue / evo-wrapper / ticker / routes; `test/paths-evo-equivalence.test.ts`
pins them against the old literals.

### Workspace runtime lock

`<workspace>/.halo/runtime.lock` — a pid marker that records which process owns this workspace's *runtime* (gates `reconcileOrphansOnBoot`; see [session.md](session.md#boot-reconcile-of-crash-orphans-reconcileorphansonboot)). It exists because `~/.halo/global/server.lock` can't arbitrate the case of two servers with different `HALO_HOME` sharing one workspace — the ownership marker has to live in the shared resource itself. Implementation: `packages/server/src/agents/workspace-runtime-lock.ts`.

Protocol (single-machine scope; NFS / cross-host explicitly out):
- **Claim** = `O_EXCL` create with own pid; first claimer owns the runtime.
- **EEXIST** → read the holder pid and probe with `kill(pid, 0)`. Holder alive (`EPERM` counts as alive — false-dead is the dangerous direction) → return false, caller skips reconcile. Holder is own pid → already owned.
- **Dead / unreadable holder** → stale takeover via write-tmp + atomic rename (keeps the path existent at all times, so a third comer always sees *some* holder).
- **Release on graceful exit**: `gracefulShutdown` calls `releaseWorkspaceRuntime` per workspace, which unlinks the file only when it holds *our own* pid (a file another live process owns or took over is left alone). A crash / SIGKILL leaves the file and converges on the "pid dead → next boot takes over" path, so correctness never depends on the exit hook having run — the release only keeps a reboot-recycled pid from reading as a live holder.

Bias is deliberate: pid reuse can read a stale pid as "alive," which only costs one missed cleanup round; a false-dead could stop another process's live sessions. Full race analysis in the file's header comment.

**`HALO_BADGE=DEV` servers never claim.** dev and prod serve the same workspaces, so prod (any other badge, or none) owns the lock outright: a DEV server (`config.server.ownsWorkspaceRuntimes === false`) builds its registry with `reconcileOrphansOnBoot: false`, skips the run-ledger eager sweep, and has channel route restore build the SessionManager directly. It never creates, rewrites or takes over `runtime.lock`, and runs no boot cleanup. Two costs: orphans left by a dev crash stay until prod's next restart cleans them, and a prod restart stamps the sub-sessions dev is running in a shared workspace stopped. That is what prod ownership means.

## Session files (2.0)

Directory: `.halo/sessions/{agentId}/` (internal agents: `~/.halo/global/internal-sessions/{agentId}/`). `{seg}` = the session id's leaf segment (`fileSegment(id)`: the part after the last `>`).

| File | Content | Write mode |
|---|---|---|
| `{seg}.ui.jsonl` | UI records (below), no header | append; atomic rewrite (tmp + rename) on archive / `replaceMessageLog` / `deleteExchange` / a write by another process |
| `{seg}.raw.jsonl` | one model message (`AnthropicMessage`) per line; user text blocks start with the `[<iso>] ` arrival stamp — strip it (`stripTurnStamp`) before matching against the UI log | append; atomic rewrite on any non-append change (compaction, repair edit, image trim, `deleteExchange`) |
| `{seg}.ui.arch.{N}.{h}.jsonl.gz` | archived UI messages (merged), one per line, gzip, oldest-first; `N` from 1, `h` = first 12 hex of sha1(first message id) | written once (tmp + rename), immutable |

No file ends in `.json` (the test-chat routes in `routes/agent-configs.ts` still list / bulk-delete `*.json`, so sessions created on 2.0 don't appear there — known limitation). A crashed atomic write can leave `<file>.tmp.<pid>.<ms>`; readers ignore it, session delete removes it.

**No metadata in files.** agentId = directory, leaf id = file name, archive count = committed segment files; full id, parent, agent name, created / updated, `title`, `exchange_count`, `context_tokens`, `total_output_tokens`, `output`, `last_activity_at` = the session's [`agent_sessions`](#tables) row. `source` (explorer / delegated) is derived from the parent.

### `ui.jsonl` records

```
{"t":"add","id":"<row id>","u"?:1,"m":<SessionMessage>}   append a row ("u":1 = main user turn)
{"t":"patch","id":"<row id>","m":<SessionMessage>}          replace that row, position kept
{"t":"inflight","id":"<row id>","m"?:<shell>,"from":k,"blocks":[ContentBlockEntry…]}
```

`id` leads every record, so a reader gets the first row's id from the first few KB without parsing a multi-MB line (the archive commit check).

Merge rule: rows in `add` order; `patch` replaces by id. `inflight` describes the one in-flight assistant: same id as the previous inflight record → `contentBlocks = previous.slice(0, from) ++ blocks`, `m` (shell: content, timestamp, agentName, taskId) only when it changed; a different id starts a fresh one. An `add` with the inflight id retires it. An inflight not retired at EOF (crash, or a mid-turn read by another process) is appended as the last row. It is not add-then-patch because rows (tool_call / tool_result / usage) keep landing *before* the streaming assistant, and a whole-message patch per write would rewrite every tool output of the turn each time (quadratic); the block delta writes each block's final form about once.

A last line that doesn't parse or has no trailing newline (torn write) is dropped by the reader; the next write is then a full rewrite.

### Archive segments

Written at a turn end when the active `ui.jsonl` exceeds `ARCHIVE_SIZE_THRESHOLD` (5 MB): segment `N` = committed count + 1 holds everything except the newest main exchange (a compaction summary row is never a cut point), then `ui.jsonl` is atomically rewritten with the kept exchange — **that rename is the commit**. Committed count = segment files numbered 1..k, minus the highest when its `h` matches the active file's first row id (the rewrite never landed). Deleting a session deletes every file of it by directory listing, never by a count. Design + read path in [session.md](session.md#ui-log-archiving).

### Migration from 1.x

1.x kept a session in one `{seg}.json` (`messages` + `rawMessages` + a header: title, counts, tokens, `archiveCount` / `archivedUserCount`, `output`, `lastActivityAt`) with segments `{seg}.arch.{N}.json.gz`. Only `sessions/legacy-migrate.ts` reads them:

- **Automatic (2.0 only, removed in 2.1).** The lowest-level log open (`session-log.ts` `openLog`), which every reader and writer goes through, on ENOENT checks for `{seg}.json` without `{seg}.ui.jsonl` and converts. Disk state, not memory, makes it once per session.
- **Command** `halo sessions migrate v1 v2` (stays long-term): every session of a workspace plus the global internal ones; refuses while a live process holds the workspace's `runtime.lock`; prints `migrated / cleaned / skipped / failed`, exit 1 on any failure.
- **Order**: `raw.jsonl` → committed segments (n ≤ header `archiveCount`) → db back-fill (the row's NULL columns from the header; an internal session gets its global row) → `ui.jsonl` (**the commit**) → read back through the 2.0 readers and compare counts and first / last ids → delete the 1.x files (`.json`, every `arch.*.json.gz` except a committed one that couldn't be read, `.json.tmp.*`). A failed check removes the new files and keeps the 1.x ones. A crash before the commit converts again on the next open; between commit and delete the command finishes it ("cleaned", after checking the 1.x history is an id-prefix of the 2.0 one).
- **Downgrade**: a migrated session has no `.json` any more, so 1.x shows it empty (its row stays), as it does sessions created on 2.0.

### SessionMessage

The type definitions (`SessionMessage`, `ContentBlockEntry`, `ToolCallEntry`, `MessageType`) now live in `packages/core/src/protocol/session-message.ts` (`@turmind/halo-core/protocol`), shared by server and admin; `server/src/sessions/session-types.ts` re-exports them and keeps the server-only helpers (`messageToolCalls`, `SessionFileData`).

```typescript
type MessageType =
  | 'user' | 'assistant'
  | 'tool_call' | 'tool_result'
  | 'usage' | 'context'
  | 'agent_start' | 'agent_done'
  | 'notification'

interface SessionMessage {
  // Required
  id: string                     // "m_{timestamp36}_{counter36}"
  type?: MessageType             // optional for backward compat (inferMessageType)
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number              // Unix ms
  agentName?: string

  // Optional scope
  taskId?: string                // Sub-agent task ID

  // assistant-only
  toolCalls?: ToolCallEntry[]    // READ-ONLY legacy — no longer written (see below)
  contentBlocks?: ContentBlockEntry[]

  // tool_call-only
  toolName?: string
  toolInput?: unknown
  toolOutput?: unknown
  durationMs?: number

  // usage-only
  turnId?: string                // LLM call UUID
  usage?: {
    inputTokens, outputTokens, totalTokens
    cacheReadInputTokens, cacheWriteInputTokens?
    ttftMs?, e2eMs?, thinkingEffort?
  }
  modelId?: string

  // context-only (not persisted)
  systemPrompt?: string

  // Transient (not persisted)
  streaming?: boolean

  // Soft delete (deleteExchange) — greyed out in the UI, removed from raw context
  deleted?: boolean

  // user row holding a compaction summary (emitted mid-turn) — never an archive cut point
  compactSummary?: boolean
}
```

### ToolCallEntry

```typescript
interface ToolCallEntry {
  name: string
  input: string                  // formatted summary
  output?: string
  durationMs?: number
  toolUseId?: string             // provider tool_use id — pairs result↔call, dedups reconnect replays (absent on old sessions)
}
```

### ContentBlockEntry

Keeps the interleaved order of text and tool calls within one assistant turn.

```typescript
type ContentBlockEntry =
  | { type: 'text'; text: string; turnId?: string }
  | { type: 'thinking'; text: string; turnId?: string }
  | { type: 'tool_call'; toolCall: ToolCallEntry; turnId?: string }
```

`turnId` uniquely identifies each LLM API call. Content blocks and the corresponding usage message in the same turn share the same turnId.

The `usage` event rotates `turnId` on both root and sub-session turn state without flushing the assistant message: the agent loop yields `tool_call`s before `usage` and runs the tools after, so at usage time every tool call of that model call is still pending — a flush there would split thinking/text from the tool_calls into two assistant messages (the pre-fix sub-session behavior). One assistant message therefore spans all model calls of a turn, each call's blocks tagged with its own turnId; it reaches disk at `complete` / `agent_done`, the next `user`, `system` or `error` event, or the interrupt flush. Those three run `flushCompletedAssistantMessage` before logging their row: the content up to the first pending tool call is flushed above the row, and the pending tail stays in the buffer below it. `error` always lands in the root log, a sub-session's error included, so it splits the root's buffer (the admin adds the error frame with no taskId, and `placeAroundStreaming` splits the root bubble the same way). Root and sub-session logs persist by one rule: `persistLog` overwrites the session's own file whole from its UI log, and every save carries the in-flight turn as a temporary assistant message (`createSaveSnapshot`). A sub-session log starts from its own file (`loadSubHistory`), so it always holds the full history; writes are debounced 500ms per session id (tool_call / tool_result / usage / context / user / system / error) and flushed at turn end (root `complete`, sub `agent_done`) and on interrupt.

### Render rules

| Mode | Visible | Hidden |
|---|---|---|
| Normal | user, assistant, notification | tool_call, tool_result, usage, context, agent_start, agent_done |
| Debug | user, assistant, notification, context, agent_start, agent_done + inlined usage | tool_call, tool_result (already inlined in the assistant's contentBlocks) |

Debug usage badges are grouped by turnId, not by log position: `buildExchanges` (`message-list.tsx`) puts each usage row in the exchange holding the last assistant message with a block of that turnId, and the badge renders after that turnId's last block. A usage row reaches the log when its model call returns, before the call's tools run, so a user row that lands mid-call is logged after the badge while the pending tool_calls are flushed below it. Grouping by position left the badge on the bubble above the user row. A usage row with no matching block falls back to the last assistant message of its own exchange.

Assistant rendering priority:
1. Has `contentBlocks` → render in contentBlocks order
2. No contentBlocks, has `toolCalls` → tools first, then content (legacy)
3. Neither → render only `content`

### `toolCalls` is write-deprecated (read-only)

Assistant turns are persisted with `contentBlocks` only. `toolCalls` held a second copy of every tool's input **and** output, byte-for-byte identical to the blocks copy: across 195 sessions it was 66 MiB of a 340 MiB corpus (19.4%), and dropping it shrank the corpus to 257 MiB (-24.4%). The three UI-log writers (`flushAssistantMessage`, `flushCompletedAssistantMessage`, `createSaveSnapshot` in `sessions/ui-log-builder.ts`) no longer attach it.

Every reader goes through `messageToolCalls(msg)` (`sessions/session-types.ts`): blocks-first, `toolCalls` only when `contentBlocks` is absent — a **fallback, never a supplement**. This matters because the legacy copy was not merely redundant, it was sometimes wrong: of 433 entries where the two copies disagreed, 242 were provably a *different* call's output landing in the legacy array (the write-side merge keyed on tool name, so parallel or repeated calls to the same tool cross-wired). Blocks was right in the spot-checks where they diverged; legacy was 0-for-11. So old files still render, but where they disagree the blocks copy wins by design.

### Backwards compatibility

1. Missing `type`: infer from `role` + existing fields
2. Missing `contentBlocks`: fall back to the `toolCalls` + `content` split layout — the only reason `toolCalls` is still read
3. Missing `compactSummary`: a user row whose content starts with `[Conversation Summary — ` is a summary
4. 1.x `{seg}.json` files: converted on first open (see [Migration from 1.x](#migration-from-1x)); no 2.0 reader reads them

### Change rules

- A change to the file layout or record shape is a new format version with its own migration in `legacy-migrate.ts`-style code at the log open — readers and writers know only the current format
- `SessionMessage` fields **must not** be removed; adding optional fields needs no version

## Agent Config format

### agent.yaml

```yaml
name: Default                          # required
description: Default agent             # optional
model:
  provider: aws-bedrock-claude-invoke         # matches ~/.halo/global/models/<providerId>.yaml
  id: global.anthropic.claude-sonnet-4-6
  endpoint: https://bedrock-runtime.us-west-2.amazonaws.com  # full endpoint URL; supports custom proxy
  maxTokens: 16384                     # optional, model's max output tokens
  thinking:
    enabled: true
    effort: medium                     # optional: low/medium/high/xhigh/max
    budget: medium                     # optional legacy alias for effort
  promptCaching: 1h                    # true / '5m' / '1h'
system_prompt: >                       # AGENT.md wins if present
  You are...
context:
  maxTokens: 272000                    # context window cap
  compressAt: 0.9                      # auto-compact threshold (default; settings: general.compact.compress_at)
tools:
  - file_read
  - file_write
  - shell_exec
skills:
  - agent-creator
priority: 99                           # sort weight (higher first); default 0
```

TypeScript type (`packages/server/src/agents/agent-loader.ts`):

```typescript
interface AgentYamlConfig {
  name: string
  description?: string
  model?: {
    provider?: string    // required — no default fallback
    id?: string          // required — no default fallback
    endpoint?: string    // required — no default fallback
    maxTokens?: number
    promptCaching?: boolean | string
    thinking?: { enabled?: boolean; budget?: string; effort?: string }
    verbosity?: string
  }
  system_prompt?: string
  tools?: string[]
  skills?: string[]
  context?: { maxTokens?: number; compressAt?: number }
  priority?: number
  internal?: boolean    // platform tooling — off the roster, no workspace context
  team?: string[]      // delegation whitelist; non-empty = can delegate
}
```

### AGENT.md

Path: `.halo/agents/{agent-id}/AGENT.md`

Plain Markdown describing the agent's personality, behaviour, and constraints. **Takes precedence over** the `system_prompt` field in `agent.yaml`.

### Load precedence

1. `{workspace}/.halo/agents/{id}/` — workspace
2. `~/.halo/global/agents/{id}/` — global

**Whole-folder override.** Resolution is by the agent's **folder**, not by
individual files: if the workspace dir `{workspace}/.halo/agents/{id}/`
exists, the agent is served entirely from it — both `agent.yaml` and
`AGENT.md` — and the global folder is ignored. A file missing inside the
workspace folder is simply absent; there is **no per-file fallback** to
global (a workspace agent with only `AGENT.md` has no `agent.yaml`, hence
no model config). When the workspace folder doesn't exist, the agent is
served entirely from global.

## Settings format

Path: `~/.halo/secrets/settings.yaml` (global) / `<workspace>/.halo/settings.yaml` (workspace overlay).

Layout follows VSCode's `contributes.configuration` model: schema lives with each declarer (provider yaml, skill yaml, server built-ins); only the values live in `settings.yaml`. Full spec: [requirements/settings.md](../requirements/settings.md).

```yaml
# Top-level keys are namespace ids; nested keys are kind (`params` / `secrets`)
# then leaf key.

general:                                  # built-in declarer (the server itself)
  session:
    max_queue_size: 256
    max_nesting_depth: 16
  compact:
    keep_messages: 5
    max_summary_input: 15000
    max_message_slice: 800
  sandbox:
    hidden_dirs: "~/.kube"                # extras, appended to the built-in list
    hidden_files: "~/.pgpass"             # extras, appended to the built-in list
  logging:
    level: warn

aws-bedrock-claude-invoke:                # provider id (matches models/<id>.yaml)
  secrets:
    access_key_id: AKIA…
    secret_access_key: <<AWS_SECRET_ACCESS_KEY>>

kimi:
  secrets:
    api_key: <<KIMI_API_KEY>>

tavily-web-search:                        # skill id (matches skills/<id>/)
  params:
    api_key: <<TAVILY_API_KEY>>
```

Path conventions:
- `general.<key>` — built-in server knobs (the only namespace that doesn't follow `<id>.<kind>s.<key>`)
- `<provider-id>.secrets.<key>` — server-side credentials for a model provider
- `<skill-id>.params.<key>` — values an agent can reference via `{{<skill-id>.params.<key>}}`
- `<skill-id>.secrets.<key>` — server-side keys a skill needs but agents must not see
- `ext-<extension-id>.params.<key>` / `ext-<extension-id>.secrets.<key>` — a canvas extension's manifest-declared `settings` (global file only, read by server code such as the transcription proxy; never by the extension itself) — see [canvas-extensions.md → Extension settings](canvas-extensions.md#extension-settings)

### Load precedence

```
process env (via <<ENV>>) > workspace settings.yaml > global settings.yaml > schema default
```

Workspace `settings.yaml` deep-merges over global, leaf by leaf. The Settings page surfaces source per field (`workspace` / `inherited from global` / `unset`) and lets users reset a workspace override.

### Env-var interpolation: `<<ENV_NAME>>`

A value of the form `<<ENV_NAME>>` is replaced at read time with `process.env.ENV_NAME`. **If the env var is unset, the literal `<<ENV_NAME>>` stays verbatim** — calls fail loudly with the placeholder visible, instead of silently falling through to a different env var. This is intentional: it makes typos discoverable.

`<<>>` substitution is honored only inside settings-resolved values; cmd text the agent itself writes is **not** scanned (`shell_exec "echo <<HOME>>"` keeps the literal). Trust boundary is "settings file content", not "string happens to look like a placeholder".

### Built-in keys (declared by the server)

| Path | Default | Notes |
|---|---|---|
| `general.session.max_queue_size` | 256 | Max queued messages per session. Restart required |
| `general.session.max_nesting_depth` | 16 | Sub-session nesting cap. Restart required |
| `general.compact.keep_messages` | 5 | Recent messages kept intact during compaction. Restart required |
| `general.compact.max_summary_input` | 15000 | Local truncation fallback total char cap. Restart required |
| `general.compact.max_message_slice` | 800 | Local truncation per-message char cap. Restart required |
| `general.limits.shell_output_bytes` | 5242880 | Max bytes captured from one `shell_exec` (stdout+stderr); excess truncated with a `[truncated]` marker |
| `general.limits.web_fetch_bytes` | 51200 | Max bytes downloaded by one `web_fetch` |
| `general.limits.grep_default_matches` | 50 | Default `grep` match cap when no explicit `max` is passed |
| `general.limits.tool_result_render_chars` | 8000 | Per-tool-result cap on the content **fed to the LLM** (truncated with a re-run marker to protect the context window / prompt cache). The UI gets a much larger slice — see `tool_result_ui_chars` and `agent-loop.ts` (`resultContent` = LLM cap, `resultTextFull` = UI cap) |
| `general.limits.tool_result_ui_chars` | 65536 | Per-tool-result cap on the content **stored for UI display** (admin/web chat panel). Far larger than the LLM cap so a normal command's full output stays visible, but bounded so a multi-MB `cat` can't bloat the session file / WS payload / browser render; excess truncated with a marker pointing at `file_read` |
| `general.limits.terminal_scrollback_bytes` | 50000 | Off-screen scrollback bytes retained per detached persistent terminal |
| `general.sandbox.hidden_dirs` | `''` | Extra dirs hidden from workspace/readonly sessions — bwrap tmpfs overlay (Linux) / Seatbelt deny (macOS). **Appended** to the built-in `DEFAULT_HIDDEN_DIRS` (`tools/sandbox.ts`: `~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker,~/.config/gh,~/.halo/global/internal-sessions,~/.halo/global/logs`), which are always included. Full sessions, the admin file explorer and the terminal are not affected |
| `general.sandbox.hidden_files` | `''` | Extra files hidden from workspace/readonly sessions — bwrap bind of the empty `~/.halo/.sandbox-empty`, reads as empty (Linux) / Seatbelt deny (macOS). **Appended** to the built-in `DEFAULT_HIDDEN_FILES` (`~/.npmrc,~/.bash_history,~/.gitconfig,~/.git-credentials,~/.netrc,~/.halo/global/{evo,cron,runs,a2a}.db` + `-wal` / `-shm`), which are always included. Full sessions, the admin file explorer and the terminal are not affected |
| `general.logging.level` | warn | `debug` / `info` / `warn` / `error`. Restart required |
| `general.a2a.public_url` | `''` | Global-only. Origin peers use to reach this server for A2A (no trailing slash): the agent card's interface URL and the default push-webhook base for `a2a_send`. Empty = derived from the request host (no outbound dispatch without it or a remote's `push_base`). Env `HALO_A2A_PUBLIC_URL` overrides. See [a2a.md](a2a.md) |
| `general.a2a.url_allowlist` | `100.64.0.0/10,*.ts.net` | Global-only. CIDRs / host patterns A2A egress may reach besides public https (push webhooks, remote cards and RPC, inbound image URLs). Private / loopback only when listed; plain http only to listed hosts / ranges; link-local always refused. See [a2a.md](a2a.md#push-delivery-and-url-policy) |
| `general.observability.endpoint` | `''` | OTLP base URL of an OpenTelemetry collector (e.g. `http://localhost:4318`); empty = off. Restart required (server); cron / evolution runs use a new value on their next run. See [observability.md](observability.md) |
| `general.observability.service_name` | `halo` | OTel resource `service.name`. Restart required (server); cron / evolution: next run |
| `general.observability.headers` | `''` | **Secret.** Extra OTLP request headers, comma-separated `k=v`. Restart required (server); cron / evolution: next run |
| `general.observability.capture_content` | `false` | Put prompt/completion/tool text on spans. Restart required (server); cron / evolution: next run |

Schema source: [packages/server/src/settings-schema.ts](../../../packages/server/src/settings-schema.ts) `generalSection()`.

### Caching

`config.ts` reads settings.yaml lazily with mtime-watching: every read stats the file and reparses if mtime changed. UI saves bump mtime, so the server picks up new values on the next read **without a restart** — except the keys marked "Restart required" above plus `general.agent.max_retries`, which `config.ts` reads once into object literals at boot (observability: `initObservability()`, mapped onto `OTEL_*` env; the cron / evolution `halo cli` children don't inherit those settings-derived vars — `cleanChildEnv()` strips them — so each re-reads settings at its own start); their schema fields carry `restartRequired: true` and the Settings page shows a restart notice after saving one.

### Orphans

Values present in `settings.yaml` whose namespace isn't currently declared by any provider/skill are surfaced as **orphans** in the Settings UI. They aren't deleted automatically — uninstalling a skill keeps its values around so re-installing pops them back in. Users prune them via the orphan tab.

> There is no longer a global "file access level" setting. Per-session access level is tracked on the session itself (`agent_sessions.access_level`) and, for channel bots, on the account (`channel_accounts.access_level`).

## Model registry format

Paths: `~/.halo/global/models/<providerId>.yaml` (bundled, seeded from `templates/models/` and overwritten on every template refresh) and `~/.halo/global/models.d/<providerId>.yaml` (hub-installed by `halo models install` / `/extension models`; seeding and refresh never touch it) — one file per provider. Both dirs are read on first access and merged into the in-memory registry. The same yaml also declares the provider's required server-side credentials (`secrets:` section), which the Settings page renders.

**Merge rule** (one implementation, `packages/server/src/models/registry.ts` `loadProviders`, behind the server registry, the Settings secrets forms, `halo setup` and the hub installer): per provider `id` the copy with the higher `revision` wins; on a tie the `models.d` copy wins; a yaml without `revision` counts as 0 (users' own custom yamls in `models/`). A `models.d` copy whose `runtime:` this build doesn't know is skipped with a `[Config]` log, so the bundled copy stays in effect. `halo setup` merges the package's `templates/models/` with `models.d/` the same way.

**Hub install** (`halo models install <dir> [--yes]`, `models/install.ts`): plan, then write `models.d/<id>.yaml` via tmp + rename. A yaml is refused (others still go ahead) for an unknown `runtime:` ("needs a newer halo"), a missing / non-integer `revision`, a `secrets[].default` other than empty / `<<ENV_NAME>>`, or bad model fields — `contextWindow` / `maxContextWindow` not positive integers, `contextWindow` > `maxContextWindow`, `compressAt` outside (0, 1], `endpoints` not a list of `https://` URLs (reason shaped `models.<id>.<field> …`). An older revision than the copy in effect is skipped, an identical one is up to date. **Consent**: the whole run writes nothing and needs `--yes` (exit 3) when an installed provider is new, its `defaultEndpoint` / `endpointPresets` change, or a model's `endpoints:` gains a URL the provider didn't use anywhere before (not in its old `defaultEndpoint`, presets or any model's list). Removed URLs, and added ones the provider already used, are listed but need no consent.

**Live reload**: `models/watcher.ts` watches `models.d/` (non-recursive, 300 ms debounce; created at boot), drops the registry cache and broadcasts `models:changed` when the merged view changed; admin pages re-fetch `/agent-configs/models` and the settings schema. `models/` isn't watched — only template refresh writes it, before the registry is first read.

```yaml
# aws-bedrock-claude-invoke.yaml
id: aws-bedrock-claude-invoke                  # required, must match filename and agent.yaml model.provider
runtime: bedrock-invoke                        # required, implementation class (wire protocol) — see below
revision: 2026100501                           # integer YYYYMMDDNN — bump on every edit; absent = 0
displayName: AWS Bedrock Claude (Invoke API)   # shown in UI
displayName_zh: AWS Bedrock Claude（Invoke API） # optional zh override
description: Invokes Bedrock via InvokeModel (non-streaming)
description_zh: 通过 Bedrock InvokeModel（非流式）调用
defaultEndpoint: https://bedrock-runtime.us-east-1.amazonaws.com
defaultModelId: global.anthropic.claude-sonnet-4-6   # picked when user switches to this provider
endpointPresets:                               # endpoint dropdown for models without their own `endpoints:`
  - https://bedrock-runtime.us-east-1.amazonaws.com
  - https://bedrock-runtime.us-west-2.amazonaws.com

# Server-side credentials. Stored at <provider-id>.secrets.<key> in
# settings.yaml; never injected into agent prompts or shell_exec.
secrets:
  - key: access_key_id
    description: AWS Access Key ID. Leave empty to use the AWS credential chain.
    description_zh: AWS Access Key ID。留空则使用凭证链
    secret: true
  - key: secret_access_key
    description: AWS Secret Access Key.
    description_zh: AWS Secret Access Key
    secret: true

models:
  - id: global.anthropic.claude-sonnet-4-6
    displayName: Claude Sonnet 4.6
    # endpoints: [https://…us-east-1…]         # optional — only when the model is served on a subset; narrows endpointPresets
    maxOutputTokens: 64000
    contextWindow: 272000                      # recommended window for a new agent (≤ 272000, ≤ maxContextWindow)
    maxContextWindow: 1000000                  # the model's true limit; absent → contextWindow
    compressAt: 0.9                            # compaction ratio for a new agent, (0, 1]
    capabilities:
      image: true                              # supports image input
      video: false
      audio: false
      promptCaching:
        default: 1h                             # auto-on value when toggled / on provider switch
        ttlPresets:
          - { value: 5m, label: 5min }
          - { value: 1h, label: 1hour }
      thinking:
        mode: adaptive                          # 'adaptive' | 'manual'
        defaultEnabled: true                    # start with Thinking checked for new agents
        default: medium                         # effort selected when Thinking is on (adaptive)
        defaultBudgetTokens: 4000               # budget when Thinking is on (manual mode only)
        effortPresets:
          - { value: low, label: Low }
          - { value: medium, label: Medium }
          - { value: high, label: High }
          - { value: max, label: Max }
      verbosity:                                # Responses-API providers only (bedrock-mantle runtime)
        default: medium
        presets:
          - { value: low, label: Low }
          - { value: medium, label: Medium }
          - { value: high, label: High }
```

**Per-model `endpoints:`** — `resolveModelEndpoints(provider, model)` (`models/model-endpoints.ts`; the admin form keeps a byte-identical copy in `features/agents/model-endpoints.ts`, pinned by `test/model-endpoints.test.ts`): a non-empty list is authoritative for that model — it replaces `endpointPresets` in the dropdown, and the model's default endpoint is `defaultEndpoint` when the list contains it, else the list's first entry. No list → provider presets and `defaultEndpoint`. Used by scaffolding / `halo setup` (`modelBlockFromProvider`) and the agent form. Runtime never falls back: a session needs `model.endpoint` in agent.yaml.

**Context fields** (`resolveModelContext` / `resolveEffectiveContext`, `config.ts`): `contextWindow` is the *recommended* window, kept ≤ 272000 even for 1M-class models (input past 272K bills at long-context rates on most of them); `maxContextWindow` is the true limit (absent → `contextWindow`); `compressAt` is the model's compaction ratio. At runtime a session's budget is agent.yaml `context.maxTokens` / `compressAt`, else the global defaults — `config.model.maxContextTokens` (272000) capped at the model's max, and `general.compact.compress_at` (0.9) — then `maxTokens` is clamped to the model's max (warned, `[SessionAgentBuilder] … clamped`). Same resolution for live sessions (`buildModelRuntime`) and cold ones (`getContextConfig`). `PUT /agent-configs/:id/yaml` refuses a new `context.maxTokens` above the model's max (400); an over-max value already on disk for the same model stays editable.

**Scaffold-only defaults** — the registry's recommended `contextWindow` / `compressAt` and `capabilities.verbosity.default` are written into agent.yaml when an agent is created (new-agent scaffold, `halo setup` rebind, the form's model / provider switch); runtime never reads them for an existing agent, so a registry update can't move a running agent. A new agent's `context:` = `contextWindow` (else the runtime default) and compressAt = explicitly set global `compact.compress_at` > model `compressAt` > 0.9 (`explicitCompressAt()`, `agent-configs.ts` `scaffoldContext`; settings.yaml only holds keys a user wrote, so absent = never set). Verbosity at runtime comes only from agent.yaml `model.verbosity`; absent → MantleAgent sends `low`.

### Capability defaults — what each `default*` field controls

| Path | Used when | Fallback |
|---|---|---|
| `<provider>.defaultModelId` | User switches provider; form picks this model | `models[0].id` |
| `<provider>.defaultEndpoint` | Same; endpoint input (narrowed by the model's `endpoints:`, see above) | `''` |
| `models[].contextWindow` | New agent / model switch with an untouched or over-max window → `context.maxTokens` | runtime default (272000 capped at max) |
| `models[].compressAt` | New agent (unless the global `compress_at` is set) / model switch with an untouched ratio → `context.compressAt` | global `compress_at`, 0.9 |
| `capabilities.promptCaching.default` | Toggle on / provider switch into a caching-capable model | `ttlPresets[0].value` |
| `capabilities.thinking.defaultEnabled` | New agent or provider switch with no prior thinking config | `false` |
| `capabilities.thinking.default` | Thinking toggled on, adaptive mode | `effortPresets[0].value` |
| `capabilities.thinking.defaultBudgetTokens` | Thinking toggled on, manual mode | `8192` |
| `capabilities.verbosity.default` | New agent / provider or model switch with no valid prior value → `model.verbosity` | none written; runtime `low` |

Existing agent yaml values always win over these defaults — switching providers carries the user's effort/ttl over when valid for the new model. The defaults only fire when there's nothing to carry, or the carry-over isn't valid in the new vocabulary (e.g. Bedrock `medium` → Kimi `enabled/disabled` mismatch resets to the new provider's `default`).

**`capabilities` drives the UI and runtime behavior**:
- `image` / `video` / `audio` (boolean) → modality badges in the form; at runtime, unsupported modality inputs are filtered out with a text notice instead of causing API errors
- `promptCaching.ttlPresets` → Prompt Caching dropdown
- `thinking.mode`:
  - `adaptive` → wire format `thinking: {type: 'adaptive'}` + `output_config.effort` (Sonnet 4.6+ / Opus 4.6 and later, incl. Opus 5). Qwen 3.8 Max / Flash use the same `output_config.effort` with `thinking: {type: 'enabled'}`, unless the agent.yaml carries an explicit `budget_tokens`.
  - `manual` → wire format `thinking: {type: 'enabled', budget_tokens: N}` (Haiku 4.5 and other legacy thinking models). UI offers a budget number input; runtime translates effort labels via `effortToBudget` in `anthropic-request.ts` if needed.
- `thinking.effortPresets` → Thinking effort dropdown (when `mode: adaptive`)
- Omit a block → the UI hides that control for this model

**`secrets:` declarations** drive the Settings page: each entry becomes a masked input grouped under the provider's display name. Values land at `<provider-id>.secrets.<key>` in settings.yaml.

`agent.yaml`'s `model.provider` must match a provider's `id` — otherwise session spawn fails.

Routing: `id` is the provider identity (model picker, `agent.yaml` `model.provider`, `<id>.secrets.*`); `runtime:` picks the implementation class. `resolveProviderRuntime(providerId)` reads `runtime` from the registry entry, then `createModelRuntime(runtime, cfg)` dispatches on the runtime name only — the provider id is never matched against it. Runtimes: `bedrock-invoke` (BedrockAgent), `bedrock-mantle` (MantleAgent, OpenAI Responses), `anthropic-messages` (AnthropicAgent), `openai-chat` (OpenAIAgent, Chat Completions), and the vendor subclasses under their own names (`kimi`, `deepseek`, `minimax`, `qwen`, `hunyuan`, `doubao`, `zhipu`). Several providers can share one runtime (`anthropic` + `mimo-token-plan-china`; `aws-bedrock-mantle` + `aws-bedrock-openai`). No yaml for the id, no `runtime:` (a seed older than template v82), or an unknown name → session build throws naming the provider and yaml path. See [design/agent.md](../design/agent.md#agent-instance).

## Skill schema (`config.yaml`)

Optional file at `<skill-dir>/config.yaml` (next to `SKILL.md`). Declares which params and secrets the skill needs; the Settings page renders these grouped under the skill's display name.

```yaml
# tavily-web-search/config.yaml
displayName_zh: Tavily 联网搜索      # optional override; falls back to SKILL.md `name`
description: Real-time web search via Tavily Search API.
description_zh: 通过 Tavily 搜索 API 进行实时联网搜索。

params:                              # values an agent can use via {{<skill>.params.<key>}}
  - key: api_key
    description: Tavily Search API Key
    description_zh: Tavily 搜索 API Key
    default: <<TAVILY_API_KEY>>      # placeholder/hint; user can leave as-is to use env var
    secret: true                     # masked input + masked API responses

secrets: []                          # optional — server-only keys, never reach the agent
```

Skill bodies can use the **short form** `{{params.<key>}}` — the activation pipeline rewrites it to `{{<skill-id>.params.<key>}}` before handing the body to the agent. Long form (`{{nano-banana.params.endpoint}}`) is also accepted, useful when one skill needs to reference another skill's param. AGENT.md must use the long form.

## Skill format

Path: `.halo/skills/{skill-id}/SKILL.md`

```markdown
---
name: skill-id        # kebab-case, = directory name
description: One-line description for agent discovery
command: /review      # optional, explicit opt-in registers a slash command
---

# Skill Title

Detailed instructions...
```

```typescript
interface SkillMeta {
  id: string           // directory name
  name: string         // from frontmatter
  description: string  // from frontmatter
  path: string         // absolute path to SKILL.md
  command?: string     // from frontmatter
  requiresAccess?: 'full' | 'workspace' | 'readonly'  // from frontmatter
}
```

Load precedence: workspace > global > extension, **whole-folder override** (the agent rule, plus a third, read-only source: `~/.halo/global/extensions/<extId>/skills/<id>/`, see [canvas-extensions.md → Extension skills](canvas-extensions.md#extension-skills)). A higher `skills/<id>/` folder replaces the lower skill wholesale — SKILL.md plus every sibling resource file — with no per-file fallback.

## SQLite databases

Workspace DB: `<workspace>/.halo/halo.db`
Channel DB: `~/.halo/secrets/channels/channels.db`
Schema seed: `packages/server/templates/schema.sql`
ORM: `packages/server/src/db/schema.ts`, `packages/server/src/db/channel-db.ts`

The databases hold session metadata (the only home of title / counts / tokens / latest output — session files carry none) and workspace-scoped preferences (e.g. disabled items); message content lives in the session JSONL files. Internal-agent sessions keep the same `agent_sessions` table in `~/.halo/global/internal-sessions/halo.db`. Agent/skill/project config goes through the filesystem.

### Tables

**`agent_sessions`** — agent session index (root + sub-sessions)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | Session ID (hierarchical: `sid_abc` or `sid_abc>sid_def`) |
| parent_id | TEXT | Parent session ID (null = root) |
| agent_id | TEXT NOT NULL | Agent YAML ID |
| agent_name | TEXT | Display name |
| description | TEXT | Task description |
| working_dir | TEXT | Workspace-relative path; null = project root |
| access_level | TEXT | `'readonly'`, `'workspace'`, or null (null = full access). Added in `HALO_MIGRATIONS` slot (`db/index.ts`). |
| created_at / updated_at | INTEGER | Unix ms |
| stopped_at | INTEGER | Stopped timestamp (null = active) |
| archived_at | INTEGER | Archived timestamp (null = not archived) |
| goal / goal_session_id | TEXT | Retained legacy columns (goal mode binding JSON / back-pointer); existing bindings are unchanged and still honored |
| reply_to | TEXT | Relay — JSON `{ workspace, sessionId }` of the caller session in another workspace; set by `relay_send`, cleared on report delivery. Added in `HALO_MIGRATIONS` slot (`db/index.ts`). |
| title | TEXT | Session title, sticky once set |
| exchange_count | INTEGER | Main user turns over the session's lifetime (kept + archived); new rows 0 |
| context_tokens | INTEGER | Latest context size |
| total_output_tokens | INTEGER | Output tokens over the session's lifetime |
| output | TEXT | Latest turn's accumulated assistant text. Added in `HALO_MIGRATIONS` v3 |
| last_activity_at | TEXT | ISO time of the latest turn's last text / tool event; null if none. Added in `HALO_MIGRATIONS` v3 |

`title` … `total_output_tokens` are written by `updateSessionMeta()` off the single UI-log persist seam (`SessionManager.persistUILog`) and by the PATCH-rename path; `output` / `last_activity_at` by `updateSessionOutput()` on every raw save. Both skip no-op writes and never touch `updated_at` (that column means "last activity"). `exchange_count` null = a row from before 2.0 → the first probe of its UI log migrates the 1.x file and back-fills the null columns from its header. Details in [session.md](session.md#sqlite-metadata).

**`disabled_items`** — per-workspace disable state for agents and skills (allows the same global item to be independently toggled in each workspace)

| Column | Type | Notes |
|---|---|---|
| item_type | TEXT NOT NULL | `'agent'` or `'skill'` |
| item_id | TEXT NOT NULL | Agent/skill ID |
| scope | TEXT NOT NULL | `'global'`, `'workspace'` or `'extension'` (a skill shipped by an installed extension, `agents/skill-sources.ts`) — which source the item comes from. `'extension'` added by `HALO_MIGRATIONS` v2 (table rebuild, rows kept) |
| disabled_at | INTEGER NOT NULL | Unix ms |
| | | **PK**: `(item_type, item_id, scope)` |

**`channel_accounts`** — unified channel account index (lives in `~/.halo/secrets/channels/channels.db`)

All channel types (telegram, web, wechat, slack, feishu, wecom) share one table. Common fields are explicit columns; channel-specific fields live in the `config` JSON column.

| Column | Type | Notes |
|---|---|---|
| account_id | TEXT PK | Channel-specific ID (e.g. `halo_agent_bot`, `abc-im-bot`, `e718bb7b`) |
| channel_type | TEXT NOT NULL | `'telegram'`, `'web'`, `'wechat'`, `'slack'`, `'feishu'`, or `'wecom'` |
| workspace_path | TEXT NOT NULL | Absolute path of the bound workspace |
| label | TEXT | User-chosen name |
| enabled | INTEGER | 1 = active, 0 = disabled |
| access_level | TEXT | `'full'`, `'workspace'`, or `'readonly'` (default `'readonly'`) |
| language | TEXT | `'en'` or `'zh'` (default `'en'`) |
| config | TEXT | JSON — channel-specific fields (see below) |
| created_at / updated_at | INTEGER | Unix ms |

**Config JSON by channel type:**

| Channel | Config fields |
|---|---|
| telegram | `botToken`, `botUsername`, `allowedUsers` |
| web | `token` |
| wechat | `botToken`, `baseUrl`, `userId`, `syncBuf` |
| slack | `botToken`, `appToken`, `botUserId`, `teamId` |
| feishu | `appId`, `appSecret`, `verificationToken`, `encryptKey`, `botOpenId` |
| wecom | `botId`, `secret` |

### Schema change rules

- `schema.sql` / each db's `CREATE_SQL` always describes the FULL current shape, so a fresh db is complete after the CREATEs alone
- Every change to an already-existing db gets a numbered slot in that file's ordered migration list — `HALO_MIGRATIONS` (`db/index.ts`), `CRON_MIGRATIONS` (`db/cron-db.ts`), `A2A_MIGRATIONS` (`db/a2a-db.ts`); `channel-db.ts` / `evo-db.ts` / `runs-db.ts` currently pass an empty list. `runMigrations(sqlite, list)` (`db/migrate.ts`) runs `list[user_version..]` in order, each in its own transaction, stamping `PRAGMA user_version = i + 1` after each
- A fresh db is also at `user_version 0` and runs the whole list, so every slot must be a no-op against the current shape (`addColumnIfMissing`, `CREATE … IF NOT EXISTS`). A CHECK constraint can't be altered in SQLite: the slot rebuilds the table (create `_v2`, copy rows, drop, rename) and skips when `sqlite_master` already shows the new constraint — `HALO_MIGRATIONS` v2 (`disabled_items.scope` admits `'extension'`) is the pattern
- Current slots worth knowing: `HALO_MIGRATIONS` v2 — the `disabled_items` rebuild above (rows kept). `HALO_MIGRATIONS` v3 — `agent_sessions.output TEXT`, `agent_sessions.last_activity_at TEXT` (session store 2.0: the files carry no metadata). `CRON_MIGRATIONS` v5 — `cron_jobs.working_dir TEXT NULL` (job folder → `halo cli --dir`), `cron_jobs.stateless INTEGER NOT NULL DEFAULT 0` (1 = fresh session every run), `cron_runs.session_id TEXT NULL` (the session that run used). `CRON_MIGRATIONS` v6 — `cron_runs.workspace_path TEXT NULL` (the workspace the run fired against, where a stateless run's session lives), backfilled from the job row (`UPDATE … SET workspace_path = (SELECT workspace_path FROM cron_jobs …) WHERE workspace_path IS NULL`), so rows whose job is already gone stay NULL; column semantics in [cron.md](cron.md)
- Append only — never reorder or edit a shipped slot. A db opened by a newer halo (user_version > list length) logs a warning and continues
- Do not drop or rename existing columns
- New channel types: add rows with a new `channel_type` value + define config shape in the channel's `accounts.ts` adapter

## Changelog

| Version | Date | Change |
|---|---|---|
| v1 | 2026-04-22 | Initial protocol. SessionMessage gains `type`; SessionFileData gains `version`. |
| v1+ | 2026-04-22 | Optional additions: `thinking` ContentBlockEntry; usage fields `thinkingEffort`, `cacheWriteInputTokens`; agent.yaml `thinking`, `promptCaching`; `is_main` → `is_default`; path `explorer/main/` → `explorer/default/`. |
| v1+ | 2026-04-28 | Model registry reshaped from `models.yaml` to per-provider files under `models/`. Provider id `bedrock` renamed to `aws-bedrock-claude-invoke`. Added `agent_sessions.access_level` column; added `weixin_accounts.access_level` and `weixin_accounts.sync_buf`. Removed global file-access setting. |
| v1+ | 2026-05-12 | Restructured `~/.halo/`: sensitive files (settings.yaml, config.yaml, channels/) moved to `secrets/`; non-sensitive config remains in `global/`. `migrateSecrets()` auto-migrates on first startup. Access level expanded to three tiers: `full` / `workspace` / `readonly` (agent_sessions + channel_accounts). Tool execution routed through bwrap sandbox for non-full access levels. `agent_sessions.working_dir` now stored as workspace-relative path. |
| v1+ | 2026-05-13 | Settings i18n + UI polish: compact keys renamed camelCase → snake_case (`keep_messages`, `max_summary_input`, `max_message_slice`, `summarize_timeout_sec`). Added `description_zh` on all leaf nodes and `description`/`description_zh` on branch nodes (replaces `_hint`/`_hint_zh`). Added `secret: true` attribute for masked input. Added Tavily to default params. Admin UI fully i18n'd (agents, skills, settings, nav). |
| v1+ | 2026-05-13 | Added `packages/cli` — standalone CLI/TUI client with embedded agent loop (no server required). Imports server agent-core via subpath exports. Session prefix: `cli_`. Added `exports` + `typesVersions` to server `package.json`. |
| v1+ | 2026-08-08 | Session file slimming (no version bump — additive + reader-compatible): assistant `toolCalls` no longer written (`contentBlocks` is the single copy, `toolCalls` stays read-only legacy); files written as compact JSON; UI-log archiving adds header fields `archiveCount` / `archivedUserCount` plus `{sessionId}.arch.{N}.json.gz` segment files; `agent_sessions` gains mirrored `title` / `exchange_count` / `context_tokens` / `total_output_tokens` columns so listing doesn't parse every file. |
| v1+ | 2026-09-18 | Relay + liveness (additive, no version bump): `agent_sessions.reply_to` column (idempotent ALTER); session file gains `lastActivityAt` beside `output`, read back by `get_session_output` for released sessions. |
| v1+ | 2026-09-20 | Schema migrations moved from ad-hoc boot-time ALTERs to `PRAGMA user_version` + ordered per-db migration lists (`db/migrate.ts`); existing dbs pick up at slot 0 and every slot is idempotent. Session-message + WS frame types moved to `@turmind/halo-core/protocol` (re-exported from their old server paths; no wire change). |
| v1+ | 2026-10-10 | Model registry (additive): per-model `endpoints:`, `maxContextWindow`, `compressAt`; recommended `contextWindow` ≤ 272000; registry context / compressAt / verbosity defaults are scaffold-only; installer validates model fields and asks consent for URLs new to a provider. `HALO_MIGRATIONS` v2: `disabled_items.scope` admits `'extension'`. `CRON_MIGRATIONS` v5: `cron_jobs.working_dir`, `cron_jobs.stateless`, `cron_runs.session_id`. |
| v1+ | 2026-10-13 | `CRON_MIGRATIONS` v6 (additive): `cron_runs.workspace_path`, backfilled from the job row (NULL where the job is already gone). |
| v2 | 2026-10-15 | Session store 2.0: `{seg}.json` replaced by append-only `{seg}.ui.jsonl` (`add` / `patch` / `inflight` records) + `{seg}.raw.jsonl`; archive segments `{seg}.ui.arch.{N}.{h}.jsonl.gz`, committed count = segment files (no stored counter), archived at turn end over 5 MB; no metadata in files — `HALO_MIGRATIONS` v3 adds `agent_sessions.output` / `last_activity_at`, internal sessions get rows in `~/.halo/global/internal-sessions/halo.db`; `SessionMessage.compactSummary`. 1.x files are converted on first open (or `halo sessions migrate v1 v2`) and deleted after a read-back check. |

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
│   │   ├── all/                       # Every agent (TOOL_GUIDELINES.md, TOOL_SHELL[.windows].md)
│   │   └── root/                      # Root agent only — empty by default; user-set
│   ├── agents/<id>/
│   │   ├── agent.yaml                 # Agent config
│   │   └── AGENT.md                   # Agent personality
│   ├── models/                        # Model registry — one file per provider, scanned at startup
│   │   └── <providerId>.yaml          # e.g. aws-bedrock-claude-invoke.yaml
│   ├── skills/<id>/
│   │   └── SKILL.md                   # Skill definition (frontmatter + body)
│   ├── internal-sessions/<agentId>/   # Internal-agent sessions (`__evo_agent__`, `__score__`, `__apply_agent__`)
│   │                                  #   — global so they don't pollute any workspace's halo.db
│   │   └── <sessionId>.json
│   ├── evo.db                         # Cross-workspace evolution queue (evolution_runs + evolution_applies)
│   ├── cron.db                        # Cross-workspace cron jobs + run history (cron_jobs + cron_runs)
│   ├── logs/                          # Runtime logs
│   │   ├── evo/                       # Per-evo-run wrapper logs
│   │   └── cron/                      # Per-cron-run cli stdout/stderr (30-day retention)
│   ├── server.lock                    # Single-instance pid lock
│   └── .template-version              # Template-seed marker (used by ensureHaloHome)
├── secrets/                           # Sensitive files (not mounted into sandbox)
│   ├── settings.yaml                  # Global settings (API keys, credentials)
│   ├── config.yaml                    # System config (admin password, server settings)
│   └── channels/
│       └── channels.db                # Channel accounts DB

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
├── sessions/<agentId>/                # Session files (one per regular session)
├── memory/                             # Project memory (dated entries)
├── logs/
├── evo/                                # Self-evolution per-workspace artifacts
│   ├── runs/<id>/                     #   per-evaluation: source-snapshot.json, tool-flow.md,
│   │                                  #   evo-context.json, sandbox/, patch.md, score.json,
│   │                                  #   sub-cli.log, optional .skip.md
│   ├── applies/<id>/                  #   per-apply: meta.json, sandbox/, regress/<runId>/, apply.log
│   ├── history/apply-<id>/            #   pre-apply rollback snapshot (MANIFEST.json + the overwritten files)
│   └── archive/                       #   zipped runs/applies past the retention window
├── tmp/                                 # Agent scratch files (logs, downloads, intermediate artifacts) — convention from TOOL_GUIDELINES, not auto-created
├── assets/<channel>/inbound/<accountId>/<date>/  # Inbound media per channel (image/voice/video/file)
├── halo.db                           # Per-workspace sqlite (sessions metadata, command registry, disabled-items)
└── docs/                               # Project docs (requirements/design/dev/test/plans)
```

Precedence: workspace > global, **at folder granularity**. For the same id, a workspace `agents/<id>/` or `skills/<id>/` folder entirely replaces the global one — every file in it, no per-file fallback to global (a workspace agent folder with only `AGENT.md` loses the global `agent.yaml`). Same whole-folder rule for `prompts/{bootstrap,all,root}/` (workspace scope directory replaces the global one). INSTRUCTIONS.md is the single-file exception: workspace root suppresses global.

### Path constructors

All `.halo/...` path math goes through `packages/server/src/paths.ts` (e.g. `wsHaloDir(ws)`, `wsEvoRunDir(ws, runId)`, `globalInternalSessionFile(agentId, seg)`, `cronLogFile(runId)`). Treat `paths.ts` as the canonical reference for the layout above; if the layout changes, update `paths.ts` first and call sites follow.

## Session file format (v1)

Path: `.halo/sessions/{agentId}/{sessionId}.json`

```jsonc
{
  "version": 1,
  "id": "oogezptkmoaeflb5",
  "agentId": "default",
  "agentName": "Default",
  "title": "First user message...",  // auto-generated, max 60 chars
  "source": "explorer",              // "explorer" (root) | "delegated" (sub-session)
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "messageCount": 42,
  "contextTokens": 5975,
  "totalOutputTokens": 6058,
  "parentSessionId": "parent_id",    // sub-sessions only
  "messages": [SessionMessage],       // UI event-log format (written by WS handler / UIState reducer)
  "rawMessages": [AnthropicMessage],  // raw Bedrock API shape (written by SessionManager saveAgentState)
  "output": "..."                     // accumulated assistant text from the latest turn
}
```

### SessionMessage

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
  type: MessageType
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number              // Unix ms
  agentName: string

  // Optional scope
  taskId?: string                // Sub-agent task ID

  // assistant-only
  toolCalls?: ToolCallEntry[]
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
}
```

### ToolCallEntry

```typescript
interface ToolCallEntry {
  name: string
  input: string                  // formatted summary
  output?: string
  durationMs?: number
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

### Render rules

| Mode | Visible | Hidden |
|---|---|---|
| Normal | user, assistant, notification | tool_call, tool_result, usage, context, agent_start, agent_done |
| Debug | user, assistant, notification, context, agent_start, agent_done + inlined usage | tool_call, tool_result (already inlined in the assistant's contentBlocks) |

Assistant rendering priority:
1. Has `contentBlocks` → render in contentBlocks order
2. No contentBlocks, has `toolCalls` → tools first, then content (legacy)
3. Neither → render only `content`

### Backwards compatibility

1. Missing `type`: infer from `role` + existing fields
2. Missing `contentBlocks`: fall back to the `toolCalls` + `content` split layout
3. Missing `version`: treat as v0, apply inference rules

### Change rules

- Format changes **must** bump `version`
- Readers **must** handle every historical version
- Persisted fields **must not** be removed
- Adding optional fields does **not** require a version bump

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
  maxTokens: 200000                    # context window cap
  compressAt: 0.8                      # auto-compact threshold (default; settings: general.compact.compress_at)
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
  }
  system_prompt?: string
  tools?: string[]
  skills?: string[]
  context?: { maxTokens?: number; compressAt?: number }
  priority?: number
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
    max_queue_size: 3
    max_nesting_depth: 16
  compact:
    keep_messages: 5
    max_summary_input: 15000
    max_message_slice: 800
    summarize_timeout_sec: 300
  sandbox:
    hidden_dirs: "~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker"
    hidden_files: "~/.npmrc,~/.bash_history,~/.gitconfig"
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
| `general.session.max_queue_size` | 3 | Max queued messages per session |
| `general.session.max_nesting_depth` | 16 | Sub-session nesting cap |
| `general.compact.keep_messages` | 5 | Recent messages kept intact during compaction |
| `general.compact.max_summary_input` | 15000 | Local truncation fallback total char cap |
| `general.compact.max_message_slice` | 800 | Local truncation per-message char cap |
| `general.compact.summarize_timeout_sec` | 300 | LLM summary timeout |
| `general.limits.shell_output_bytes` | 5242880 | Max bytes captured from one `shell_exec` (stdout+stderr); excess truncated with a `[truncated]` marker |
| `general.limits.web_fetch_bytes` | 51200 | Max bytes downloaded by one `web_fetch` |
| `general.limits.grep_default_matches` | 50 | Default `grep` match cap when no explicit `max` is passed |
| `general.limits.tool_result_render_chars` | 8000 | Per-tool-result cap on the content **fed to the LLM** (truncated with a re-run marker to protect the context window / prompt cache). The UI gets a much larger slice — see `tool_result_ui_chars` and `agent-loop.ts` (`resultContent` = LLM cap, `resultTextFull` = UI cap) |
| `general.limits.tool_result_ui_chars` | 65536 | Per-tool-result cap on the content **stored for UI display** (admin/web chat panel). Far larger than the LLM cap so a normal command's full output stays visible, but bounded so a multi-MB `cat` can't bloat the session file / WS payload / browser render; excess truncated with a marker pointing at `file_read` |
| `general.limits.ws_event_buffer` | 5000 | Events buffered per detached WS session before oldest are dropped on reattach |
| `general.limits.terminal_scrollback_bytes` | 50000 | Off-screen scrollback bytes retained per detached persistent terminal |
| `general.sandbox.hidden_dirs` | `~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker` | bwrap tmpfs overlay (Linux only) |
| `general.sandbox.hidden_files` | `~/.npmrc,~/.bash_history,~/.gitconfig` | bwrap /dev/null bind (Linux only) |
| `general.logging.level` | warn | `debug` / `info` / `warn` / `error` |

Schema source: [packages/server/src/settings-schema.ts](../../../packages/server/src/settings-schema.ts) `generalSection()`.

### Caching

`config.ts` reads settings.yaml lazily with mtime-watching: every read stats the file and reparses if mtime changed. UI saves bump mtime, so the server picks up new values on the next read **without a restart**.

### Orphans

Values present in `settings.yaml` whose namespace isn't currently declared by any provider/skill are surfaced as **orphans** in the Settings UI. They aren't deleted automatically — uninstalling a skill keeps its values around so re-installing pops them back in. Users prune them via the orphan tab.

> There is no longer a global "file access level" setting. Per-session access level is tracked on the session itself (`agent_sessions.access_level`) and, for channel bots, on the account (`channel_accounts.access_level`).

## Model registry format

Path: `~/.halo/global/models/<providerId>.yaml` — one file per provider. All files are scanned at startup and merged into the in-memory registry. The same yaml also declares the provider's required server-side credentials (`secrets:` section), which the Settings page renders.

```yaml
# aws-bedrock-claude-invoke.yaml
id: aws-bedrock-claude-invoke                  # required, must match filename and agent.yaml model.provider
displayName: AWS Bedrock Claude (Invoke API)   # shown in UI
displayName_zh: AWS Bedrock Claude（Invoke API） # optional zh override
description: Invokes Bedrock via InvokeModel (non-streaming)
description_zh: 通过 Bedrock InvokeModel（非流式）调用
defaultEndpoint: https://bedrock-runtime.us-west-2.amazonaws.com
defaultModelId: global.anthropic.claude-sonnet-4-6   # picked when user switches to this provider
endpointPresets:
  - https://bedrock-runtime.us-west-2.amazonaws.com
  - https://bedrock-runtime.us-east-1.amazonaws.com

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
    maxOutputTokens: 64000
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
```

### Capability defaults — what each `default*` field controls

| Path | Used when | Fallback |
|---|---|---|
| `<provider>.defaultModelId` | User switches provider; form picks this model | `models[0].id` |
| `<provider>.defaultEndpoint` | Same; endpoint input | `''` |
| `capabilities.promptCaching.default` | Toggle on / provider switch into a caching-capable model | `ttlPresets[0].value` |
| `capabilities.thinking.defaultEnabled` | New agent or provider switch with no prior thinking config | `false` |
| `capabilities.thinking.default` | Thinking toggled on, adaptive mode | `effortPresets[0].value` |
| `capabilities.thinking.defaultBudgetTokens` | Thinking toggled on, manual mode | `8192` |

Existing agent yaml values always win over these defaults — switching providers carries the user's effort/ttl over when valid for the new model. The defaults only fire when there's nothing to carry, or the carry-over isn't valid in the new vocabulary (e.g. Bedrock `medium` → Kimi `enabled/disabled` mismatch resets to the new provider's `default`).

**`capabilities` drives the UI and runtime behavior**:
- `image` / `video` / `audio` (boolean) → modality badges in the form; at runtime, unsupported modality inputs are filtered out with a text notice instead of causing API errors
- `promptCaching.ttlPresets` → Prompt Caching dropdown
- `thinking.mode`:
  - `adaptive` → wire format `thinking: {type: 'adaptive'}` + `output_config.effort` (Sonnet 4.6 / Opus 4.6+ / Opus 4.7)
  - `manual` → wire format `thinking: {type: 'enabled', budget_tokens: N}` (Haiku 4.5 and other legacy thinking models). UI offers a budget number input; runtime translates effort labels via the table in `bedrock-agent.ts` if needed.
- `thinking.effortPresets` → Thinking effort dropdown (when `mode: adaptive`)
- Omit a block → the UI hides that control for this model

**`secrets:` declarations** drive the Settings page: each entry becomes a masked input grouped under the provider's display name. Values land at `<provider-id>.secrets.<key>` in settings.yaml.

`agent.yaml`'s `model.provider` must match a provider's `id` — otherwise session spawn fails.

Routing: `createModelRuntime(providerId, cfg)` → looks up the implementation by `providerId`. See [design/agent.md](../design/agent.md#agent-instance).

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
}
```

Load precedence matches agents: workspace > global, **whole-folder override**. A workspace `skills/<id>/` folder replaces the global skill wholesale — SKILL.md plus every sibling resource file — with no per-file fallback to global.

## SQLite databases

Workspace DB: `<workspace>/.halo/halo.db`
Channel DB: `~/.halo/secrets/channels/channels.db`
Schema seed: `packages/server/templates/schema.sql`
ORM: `packages/server/src/db/schema.ts`, `packages/server/src/db/channel-db.ts`

The databases hold session metadata indexes and workspace-scoped preferences (e.g. disabled items); message content lives in JSON files. Agent/skill/project config goes through the filesystem.

### Tables

**`sessions`** — frontend session index (created on first chat)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | Session ID |
| title | TEXT NOT NULL DEFAULT '' | Truncated first user message |
| messages | TEXT | Legacy field, unused (content now in JSON) |
| message_count | INTEGER | Message count |
| created_at / updated_at | INTEGER | Unix ms |

**`agent_sessions`** — agent session index (root + sub-sessions)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | Session ID (hierarchical: `sid_abc` or `sid_abc>sid_def`) |
| parent_id | TEXT | Parent session ID (null = root) |
| agent_id | TEXT NOT NULL | Agent YAML ID |
| agent_name | TEXT | Display name |
| description | TEXT | Task description |
| working_dir | TEXT | Workspace-relative path; null = project root |
| access_level | TEXT | `'readonly'`, `'workspace'`, or null (null = full access). Added via idempotent ALTER in `db/index.ts`. |
| created_at / updated_at | INTEGER | Unix ms |
| stopped_at | INTEGER | Stopped timestamp (null = active) |
| archived_at | INTEGER | Archived timestamp (null = not archived) |

**`disabled_items`** — per-workspace disable state for agents and skills (allows the same global item to be independently toggled in each workspace)

| Column | Type | Notes |
|---|---|---|
| item_type | TEXT NOT NULL | `'agent'` or `'skill'` |
| item_id | TEXT NOT NULL | Agent/skill ID |
| scope | TEXT NOT NULL | `'global'` or `'workspace'` — which source the item comes from |
| disabled_at | INTEGER NOT NULL | Unix ms |
| | | **PK**: `(item_type, item_id, scope)` |

**`channel_accounts`** — unified channel account index (lives in `~/.halo/secrets/channels/channels.db`)

All channel types (telegram, web, wechat, slack, feishu) share one table. Common fields are explicit columns; channel-specific fields live in the `config` JSON column.

| Column | Type | Notes |
|---|---|---|
| account_id | TEXT PK | Channel-specific ID (e.g. `halo_agent_bot`, `abc-im-bot`, `e718bb7b`) |
| channel_type | TEXT NOT NULL | `'telegram'`, `'web'`, `'wechat'`, `'slack'`, or `'feishu'` |
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

### Schema change rules

- Add columns via `ALTER TABLE ... ADD COLUMN` + try/catch (skip if already present)
- Do not drop or rename existing columns
- New tables: add to `templates/schema.sql`
- Centralise migration logic in `db/index.ts` and `db/channel-db.ts`
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

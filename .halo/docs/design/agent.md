# Agent — Design

Agent instances, lifecycle, tools, and message formats.

## Agent instance

Each session is 1:1 with a `ModelRuntime`. `ModelRuntime` is a provider-agnostic interface; `agent.yaml`'s `model.provider` selects the concrete implementation.

**Files**:
- [packages/server/src/agents/model-runtime.ts](../../../packages/server/src/agents/model-runtime.ts) — the interface plus the `createModelRuntime(providerId, cfg)` dispatcher
- [packages/server/src/agents/bedrock-agent.ts](../../../packages/server/src/agents/bedrock-agent.ts) — the `aws-bedrock-claude-invoke` implementation (uses Bedrock InvokeModel, non-streaming)

### State

```
messages: AnthropicMessage[]    ← full conversation history (external code can mutate for compact/repair)
run(input, opts): AsyncGenerator ← the only public entry point
```

Each provider's SDK client and config details are encapsulated inside its runtime implementation; session-manager does not see them.

### Core loop

`*run(input, {cancelSignal})` — async generator (non-streaming):
1. Append the user message to `messages`
2. `callModel()` → invoke the provider API, get complete response
3. Yield `thinking` / `text` / `usage` / `tool_call` events
4. If `stop_reason=tool_use` → execute tools, yield `tool_result` events → loop
5. Otherwise yield a `stop` event and return

### Adding a new provider

1. Write the model manifest and capabilities at `~/.halo/global/models/<providerId>.yaml` (see `aws-bedrock-claude-invoke.yaml` for shape)
2. Add a case to the switch in `model-runtime.ts` returning a class that implements `ModelRuntime`
3. Nothing else changes — session-manager will automatically route by `agent.yaml`'s `model.provider`

## Agent build pipeline (SessionManager.buildAgentInstance)

1. Load `agent.yaml` (workspace > global)
2. Resolve `model.provider`, `model.id`, `model.endpoint` — all three **must** be specified in `agent.yaml`; missing any one throws an error (no defaults)
3. Filter the workspace tool set by `yaml.tools`
4. Build the system prompt: AGENT.md > YAML `system_prompt` > built-in default
5. Inject the MD layers (USER.md / AGENT.md / INSTRUCTIONS.md chain / INDEX.md)
6. **Render AGENT.md placeholders**: `{{var}}` / `{{<skill-id>.params.<key>}}` / `<<ENV>>` substitution (see [prompt-system.md](prompt-system.md#placeholder-rendering-pipeline))
7. Inject skill metadata (use `activate_skill` to load the full body on demand)
8. `createModelRuntime(providerId, {modelId, endpoint, systemPrompt, tools, ...})`

See [prompt-system.md](prompt-system.md).

## Session tools

Agents manage other sessions with these tools (enable them by name in `agent.yaml`'s `tools` list). Full schema in [dev/tools.md](../dev/tools.md#session-tools).

| Tool | Purpose |
|------|---------|
| `start_session` | Start a new sub-session asynchronously; auto-reports to its parent when done |
| `session_list` | List the current session's children and their status |
| `query_session` | Send a message to another session (runs immediately if idle, queues if busy) |
| `interrupt_session` | Enqueue a message + immediately abort the in-flight turn so the queue drains now (= `query_session` + abort) |
| `stop_session` | Fold the queue into history (preserve, don't drop) + abort + repair, no re-run |
| `archive_session` | Archive a session and all its descendants (sets archivedAt) |
| `get_session_output` | Read the latest text output of a session |
| `query_agent` | Get an agent's full details (AGENT.md, YAML config, skills); team-gated to the agent's roster |

Plus the workspace tools for direct work. The tool set varies by access level and bwrap availability:

| Level | Tools (with bwrap) | Tools (without bwrap) |
|---|---|---|
| `full` | All 9 tools | All 9 tools |
| `workspace` | All 9 tools | All 9 tools |
| `readonly` | All 9 tools | file_read, view_image, file_list, grep, glob (5 tools) |

`view_image` is also vision-gated: models that don't declare `capabilities.image: true` get the same lists minus `view_image`, so the model never sees a tool that would 400 the moment it called it. See [dev/tools.md](../dev/tools.md#view_image).

When `accessLevel` is not `full`, tool execution is routed through a bwrap sandbox (`packages/server/src/tools/sandbox.ts`):
- Base: `--ro-bind / /` (entire filesystem read-only) + `--tmpfs /tmp` (isolated writable temp)
- Sensitive paths hidden via tmpfs/devnull overlays — configurable in `settings.yaml general.sandbox.hidden_dirs/hidden_files` (scope: global only, workspace cannot override)
- `workspace`: workspace directory overridden with `--bind` (rw)
- `readonly`: workspace stays ro from the root bind; without bwrap, tool set is reduced to 5 read-only tools
- Error sanitization: sandbox internals (bwrap flags, mount details) are stripped from error messages before reaching the agent

When bwrap is not installed, app-level path validation (`assertPathAllowed`) enforces workspace + `~/.halo/global/` boundaries. `shell_exec` is blocked entirely without bwrap for non-full sessions.

**`activate_skill`**: auto-injected whenever the YAML has a non-empty `skills` list (does **not** need to be declared in `tools`). It loads the full SKILL.md on demand. Disabled skills are excluded.

## Root agent rule

Root agent = `!parentId` (i.e. `parentId === null`).

| Injected content | Root agent | Sub-agent |
|---|---|---|
| USER.md | ✓ | ✗ |
| AGENT.md | ✓ | ✓ |
| INSTRUCTIONS.md (global + per-level) | ✓ | ✓ |
| INDEX.md (project root) | ✓ | ✓ |
| `prompts/all/` | ✓ | ✓ |
| `prompts/root/` | ✓ | ✗ |
| `prompts/bootstrap/` | ✓ (only when needsBootstrap) | ✗ |
| `"workspace at..."` | ✓ | ✓ |
| `"Working directory: ..."` | only when workingDir ≠ root | always |

Seed default agent: id `default`, priority 99. The chat panel auto-selects the highest-priority agent when no session is active and the user hasn't picked one manually, so `default` wins as long as no other agent is configured with `priority > 99`.

## Scaffolding new agents (`buildScaffoldModelBlock`)

When the admin UI creates a new agent (POST `/agent-configs`) or seeds the default agent on first run, the `model:` block in the freshly written `agent.yaml` is generated, not hard-coded. Sources, in order:

1. **Provider** — `general.agent.default_provider` from `settings.yaml` (Settings → General). Fallback chain: configured value → `aws-bedrock-claude-invoke` if installed → first provider on disk.
2. **Model id, endpoint, prompt-caching TTL, thinking defaults** — read from that provider's YAML in `<global>/models/<id>.yaml`:
   - `defaultModelId` → `model.id`
   - `defaultEndpoint` → `model.endpoint`
   - The selected model's `capabilities.promptCaching.default` → `model.promptCaching`
   - `capabilities.thinking.defaultEnabled / default / defaultBudgetTokens` → `model.thinking.{enabled, effort, budget_tokens}`

The provider YAML is the single source of truth. Existing `agent.yaml` files are never rewritten when the General default is changed — the setting only affects subsequently-scaffolded agents. Implementation: [packages/server/src/routes/agent-configs.ts](../../../packages/server/src/routes/agent-configs.ts) `buildScaffoldModelBlock()`.

## Graceful interrupt (message queueing)

When the user sends a new message while the agent is working (the **soft** interrupt):
1. The message is pushed onto the single `messageQueue` (no `sourceSessionId` — it's a user entry) and `interruptRequested` is set
2. Inside `runAgentTurn`'s event loop, when `event.type === 'tool_result'` and `interruptRequested` is true → `abortController.abort('interrupt')` — the abort waits for the current tool, so a mid-flight `shell_exec` is **not** killed
3. The loop terminates (AbortError or cancelled)
4. **Conversation repair** (`repairConversationMessages`) cleans up orphan `toolUse` / `toolResult` blocks
5. Control returns to `runSession`, whose `drainQueue` folds the queued message into one merged follow-up turn

**Hard stop** is the Stop button — immediate abort, then repair. It does **not** discard the queue: the un-drained messages are folded into history first so nothing is lost (see the three-tier interrupt model + stop/archive contrast in [session.md](session.md#message-queue-and-drain)).

## Limits

Source: `packages/server/src/config.ts`

| Config | Default | Description |
|---|---|---|
| `model.maxContextTokens` | 200,000 | Max context window (env: `HALO_MAX_CONTEXT_TOKENS`) |
| `model.compressAt` | 0.8 | Auto-compact threshold (80%) |
| `agent.maxRetries` | 5 | Max retry count (settings: `general.agent.max_retries`) |
| `session.maxCachedSessions` | 50 | In-memory session cache (env: `HALO_MAX_CACHED_SESSIONS`) |
| `session.maxQueueSize` | 256 | inter-session message queue cap (settings: `general.session.max_queue_size`) |
| `session.maxNestingDepth` | 16 | Max session nesting depth (settings: `general.session.max_nesting_depth`) |

Note: there is no `model.defaultModelId` — model ID must be specified per-agent in `agent.yaml`.

## Error handling

When a sub-agent session crashes, the error is auto-reported back to its parent through the `.then()` callback chain — the parent never silently loses work.

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

### When agent.yaml changes take effect

`agent.yaml` (and AGENT.md, INSTRUCTIONS, USER.md, prompts, skill metadata) is read **only at agent-instance build time** — nothing re-reads it mid-turn. But an instance doesn't outlive its run: `runSession`'s finally calls `releaseSession` on every run end, dropping the session from the in-memory Map, so the next message goes through `ensureSession` and rebuilds from the current files. Build points in `SessionManager`:

1. **`createSession`** — every new session (sub-agents included) builds fresh
2. **`ensureSession`** — any session not in the Map rebuilds on next access; since every run ends in `releaseSession`, this is the normal path for an existing session's next turn
3. **Access-level change** — `sendUserMessage` with a different `accessLevel` rebuilds in place (messages preserved)

Practical consequence: a yaml edit reaches an existing session on its **next turn**, not at the next restart. The run in flight — including queued messages it drains before releasing — finishes on the old instance; a session loaded into memory by a view path (`getSessionContext`, `/context`, compact) runs one more turn on the config it was loaded with. (`resetAgent` in session-manager.ts would also rebuild, but it has no callers.) User-facing summary: [guide/delegation-and-access.md](../guide/delegation-and-access.md#2-when-a-config-edit-takes-effect).

## Session tools

Agents manage other sessions with these tools. The whole 8-tool bundle is granted automatically by a non-empty `team` in `agent.yaml` (listing them under `tools:` has no effect); the `team` ids also scope who's reachable. Full schema in [dev/tools.md](../dev/tools.md#session-tools), gating in [prompt-system.md](prompt-system.md#agent-roster).

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

Plus the workspace tools for direct work. The tool set varies by access level and OS-sandbox availability (bwrap on Linux, sandbox-exec on macOS):

| Level | Tools (with OS sandbox) | Tools (without) |
|---|---|---|
| `full` | All 9 tools | All 9 tools |
| `workspace` | All 9 tools | All 9 tools |
| `readonly` | All 9 tools | file_read, view_image, file_list, grep, glob (5 tools) |

`view_image` is also vision-gated: models that don't declare `capabilities.image: true` get the same lists minus `view_image`, so the model never sees a tool that would 400 the moment it called it. See [dev/tools.md](../dev/tools.md#view_image).

When `accessLevel` is not `full`, tool execution is routed through an OS sandbox (`packages/server/src/tools/sandbox.ts`) — bwrap on Linux, Seatbelt (`sandbox-exec`) for `shell_exec` on macOS; `getSandboxBackend()` reports which one (`'bwrap' | 'seatbelt' | null`, also exposed as `sandbox` on `/api/health`):
- Base: `--ro-bind / /` (entire filesystem read-only) + `--tmpfs /tmp` (isolated writable temp)
- Sensitive paths hidden via tmpfs / empty-file overlays — configurable in `settings.yaml general.sandbox.hidden_dirs/hidden_files` (scope: global only, workspace cannot override). Hidden files are covered with a zero-byte `~/.halo/.sandbox-empty`, not `/dev/null` (a `/dev/null` bind reads as EACCES inside bwrap, and git treats an unreadable `~/.gitconfig` as fatal) — so they read as empty
- `workspace`: workspace directory overridden with `--bind` (rw)
- `readonly`: workspace stays ro from the root bind; without an OS sandbox, tool set is reduced to 5 read-only tools
- Host git identity (`user.name` / `user.email` only, read once at boot) is passed in as `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env, since `~/.gitconfig` is hidden
- macOS: the Seatbelt profile has the same shape — `(allow default)`, deny all writes, re-allow writes to the workspace + `writable_dirs` (+ temp dirs, `/dev`; readonly gets neither workspace nor `writable_dirs`), then deny read+write on every hidden path. File tools on macOS run in-process behind `assertPathAllowed`
- Workspace runtime state (`.halo/sessions`, `.halo/logs`, `.halo/evo`, `halo.db` + sqlite sidecars) is masked even *inside* the workspace — hardcoded constants, not settings — because it holds other channels'/users' conversations on a shared workspace. The principle: workspace knowledge (INSTRUCTIONS, docs, skills, memory, …) stays readable, runtime state is hidden. These masks must be mounted *after* the workspace `--bind` (bwrap: last mount on a path wins; ordering gotcha in [memory/2026-08-05-sandbox-workspace-hidden-and-auth-hot-reload.md](../../memory/2026-08-05-sandbox-workspace-hidden-and-auth-hot-reload.md))
- Error sanitization: sandbox internals (bwrap flags, mount details) are stripped from error messages before reaching the agent

Every hidden path — global lists and workspace-relative set alike — is enforced twice: OS-sandbox masks when available, and `assertPathAllowed` for in-process file tools. `assertPathAllowed` mirrors the OS sandbox: **read** anywhere except the hidden sets, **write** only inside the workspace (minus the hidden set) and `writable_dirs`, never for readonly; symlinks are judged by their resolved target. Without an OS sandbox, that in-process check is the only boundary and `shell_exec` is blocked entirely for non-full sessions.

`shell_exec` also runs an **rm guard** (`assertRmSafe`) at every access level, `full` included, on every platform except Windows: an `rm` / `rmdir` whose target resolves to `/`, `$HOME`, `~/.halo`, the workspace root, a parent of any of those, or a system directory / its direct child is refused before spawning. It's a heuristic against mistakes rather than a shell parser — details in [dev/tools.md](../dev/tools.md#rm-guard).

The admin chat input picks the session's level per message (see [requirements/chat.md](../requirements/chat.md#access-level)); the server applies it on the idle path of `handleChat` and rebuilds the agent when it changes.

**`activate_skill`**: auto-injected whenever the YAML has a non-empty `skills` list (does **not** need to be declared in `tools`). It loads the full SKILL.md on demand. Disabled skills are excluded.

**`continue_task`**: injected for **every** agent unconditionally — the only tool that is (`activate_skill` is gated on `skills`, session tools on `team`). It lets a turn that was started by an interruption resume the interrupted task after answering; see [session.md → continue_task](session.md#message-queue-and-drain).

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
2. Inside `runAgentTurn`'s event loop, when `event.type === 'tool_result'` and `interruptRequested` is true → `abortController.abort(abortReason('interrupt'))` (a `DOMException` wrapper — see [session.md](session.md#resilient-execution-loop) for why the reason must not be a bare string) — the abort waits for the current tool, so a mid-flight `shell_exec` is **not** killed
3. The loop terminates (AbortError or cancelled)
4. **Conversation repair** (`repairConversationMessages`) fixes orphaned pairs — an orphan `toolUse` gets a synthesized `[interrupted]` error `tool_result` (so the model knows the call was cut short and doesn't re-issue it), an orphan `toolResult` is stripped (see [session.md](session.md#conversation-repair))
5. Control returns to `runSession`, whose `drainQueue` folds the queued message into one merged follow-up turn

**Hard stop** is the Stop button — immediate abort, then repair. It does **not** discard the queue: the un-drained messages are folded into history first so nothing is lost (see the three-tier interrupt model + stop/archive contrast in [session.md](session.md#message-queue-and-drain)).

## Limits

Source: `packages/server/src/config.ts`

| Config | Default | Description |
|---|---|---|
| `model.maxContextTokens` | 200,000 | Global-default context window (env: `HALO_MAX_CONTEXT_TOKENS`) — the last tier of the resolution chain below |
| `model.compressAt` | 0.8 | Auto-compact threshold (80%) |
| `agent.maxRetries` | 5 | Max retry count (settings: `general.agent.max_retries`) |
| `session.maxCachedSessions` | 50 | In-memory session cache (env: `HALO_MAX_CACHED_SESSIONS`) |
| `session.maxQueueSize` | 256 | inter-session message queue cap (settings: `general.session.max_queue_size`) |
| `session.maxNestingDepth` | 16 | Max session nesting depth (settings: `general.session.max_nesting_depth`) |

Note: there is no `model.defaultModelId` — model ID must be specified per-agent in `agent.yaml`.

### Context window resolution

A session's context budget (`contextConfig.maxTokens`, drives compaction thresholds and the token ring) resolves through three tiers:

1. agent.yaml `context.maxTokens` — explicit per-agent override
2. model registry `contextWindow` — the model entry's official window in `models/<provider>.yaml`, via `resolveContextWindow(modelId)` (config.ts)
3. `config.model.maxContextTokens` — global default 200K

Two consumers apply the same chain: `buildModelRuntime` (session-agent-builder.ts) when a session is built, and the cold-session `getContextConfig()` path (session-manager.ts) for sessions not in memory — so what the UI displays for a cold session matches what actually takes effect on resume.

## Error handling

When a sub-agent session crashes, the error is auto-reported back to its parent through the `.then()` callback chain — the parent never silently loses work.

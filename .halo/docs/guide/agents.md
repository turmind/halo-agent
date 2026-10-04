# Agents — User Guide

The agent is Halo's core abstraction: personality (AGENT.md) + config (agent.yaml) + tool set.

## Three agent kinds

| Kind | Description |
|---|---|
| Built-in | Server-shipped agents (`default`, `executor`, `deep-executor` + the internal `goal` / `__evo_agent__` / `__score__` / `__apply_agent__`; `goal` is seeded like the rest but only usable when `general.goal_mode_enabled` is set — off by default, no UI). Live under `~/.halo/global/agents/<id>/`. **Force-overwritten on every server startup** — local edits to these files will be lost on the next start. To customize: copy into the workspace scope (workspace replaces global) and edit there. |
| Global | Any other agent under `~/.halo/global/agents/<id>/`, e.g. one you created via the admin UI. Shared across projects. Never overwritten by the server. |
| Workspace | `<project>/.halo/agents/<id>/`, private to the current project; same-id workspace wins over global. Override is **whole-folder**: the workspace agent folder replaces the global one entirely, so copy *both* `agent.yaml` and `AGENT.md` when customizing — a folder with only `AGENT.md` has no model config and won't load. |

## Open the Agents panel

Click the `🤖 Agents` icon in the Activity Bar.

```
┌─────────────────┬──────────────────────────┐
│ Agents          │  Form / Edit             │
│─────────────────│                          │
│ ▼ Global    (2) │                          │
│   🤖 Default    │                          │
│   🤖 researcher │                          │
│ ▼ Workspace (1) │                          │
│   🤖 coder      │                          │
└─────────────────┴──────────────────────────┘
```

## Create an agent

Click the `+` on the **Global** or **Workspace** group header in the sidebar (the group you click decides the scope; Workspace needs an open workspace). Two prompts follow:
- **Name**: display name (e.g. "Coder")
- **Description**: one-line description (optional)

The backend calls `defaultAgentYaml(name, description)` to generate a minimal `agent.yaml`.

## Edit an agent

Click an agent in the sidebar to open the right-hand editor. Two views:

### Form view
Data-driven form for name / description / model / tools / skills / thinking. Changes auto-save about half a second after you stop editing — there's no Save button. The agent's AGENT.md is shown below the form as a read-only preview.

**Model section** has four fields:
- `provider` — dropdown populated from `~/.halo/global/models/*.yaml`
- `id` — combobox (input + datalist); preset options filtered by current provider, also accepts manual input of any model ID
- `endpoint` — combobox (input + datalist); full endpoint URL (e.g. `https://bedrock-runtime.ap-northeast-1.amazonaws.com`), supports custom proxy URLs
- `maxTokens` — optional; defaults to `maxOutputTokens` in the provider yaml

Switching provider resets the model id to the new provider's default model (its `defaultModelId`), keeping the current id when the new provider lists it too.

**Capability buttons** (Prompt Caching / Thinking) appear when the selected model matches a registry entry with declared capabilities. For manually entered model IDs not in the registry, default presets are shown (5min/1hour for caching, Low/Medium/High/Max for thinking).

### Edit view
The **Edit** button (top right) opens the agent's folder in a mini workspace (file tree + Monaco); **Back** returns to the form. Edit `agent.yaml` directly for advanced settings (like `context.maxTokens`, `promptCaching`) and `AGENT.md` for the personality.
- `AGENT.md` takes precedence over YAML's `system_prompt`
- AGENT.md supports `{{var}}` placeholders (`{{<skill-id>.params.<key>}}` / `<<ENV>>` / built-ins) rendered on agent start — see [skills.md placeholder section](skills.md#placeholders-template-variables)

## Tool configuration

What workspace tools an agent can use lives in the YAML `tools` list:

```yaml
tools:
  - file_read
  - file_write
  - shell_exec
team:                 # a non-empty team is what enables delegation
  - executor          # the agent ids this one may spawn
```

**Workspace tools**: `file_read / view_image / file_write / file_edit / file_list / shell_exec / grep / glob / web_fetch` — listed by name under `tools`.

**Session tools**: `start_session / session_list / query_session / interrupt_session / stop_session / archive_session / get_session_output / query_agent` — **not** listed under `tools`. The whole bundle is granted automatically the moment an agent declares a non-empty `team`; an empty/absent `team` means no delegation (no session tools, no roster). To let a sub-agent delegate further, give it its own `team`. Add the agent's own id to its `team` to enable parallel self-spawn.

Form view lets you check workspace tools on/off and pick the team; there's no separate session-tools checklist — delegation rides entirely on the team.

Roster rules, `start_session` checks and errors, access-level inheritance, and when an edit takes effect: [delegation-and-access.md](delegation-and-access.md).

## Skill mounting

`skills: [skill_id_1, skill_id_2]` — Halo injects skill metadata into the prompt, and the agent calls `activate_skill` to load the full SKILL.md when needed.

## Thinking mode

```yaml
model:
  thinking:
    enabled: true
    effort: medium    # low / medium / high / xhigh / max
```

When enabled, the agent "thinks" before answering — useful for hard problems. Debug mode in the Session Viewer shows the full thinking content.

## Priority

```yaml
priority: 50
```

Higher = higher in the list, default 0. The default agent seed is `priority: 99`.

Two effects:
1. **Sort weight** — agents with higher priority appear first in the chat dropdown.
2. **Default selection** — when the user opens chat without an active session and hasn't manually picked an agent, the highest-priority agent is auto-selected. To override the seed `default`, raise another agent's priority above 99.

## Test

Top-right `Test` button:
1. Sets this agent as the chat panel's selected agent
2. Jumps to the Explorer's chat tab
3. Start chatting (in the real environment, not a sandbox)

Better than the old built-in test chat — it has full workspace tools + session persistence.

Internal agents (`internal: true`, e.g. self-evolution agents) have no Test button and never appear in the chat agent selector or `/session new`'s default pick — they're delegated to by other agents, never driven directly. They remain editable in the management sidebar's collapsed **Internal** group.

## Delete

Hover a **workspace** agent in the sidebar and click its trash icon. Global agents show a crown instead (no delete button there). Constraints:
- The last global agent cannot be deleted (server-enforced)
- Workspace agents delete freely
- `/agent delete <name>` (full access) removes either kind

## Common workflows

**Copy a global agent into workspace for customisation**: copy the whole folder `~/.halo/global/agents/<id>/` to `<project>/.halo/agents/<id>/` and edit there. (Clicking `+` on Workspace with the same name creates a fresh scaffold under the same id, not a copy.)

**Multi-agent collaboration**: the Default agent sees its teammates in the prompt roster, starts them with `start_session`, and the sub-agent auto-reports on completion. See [sessions.md](sessions.md).

## agent.yaml field reference

Full field list grouped by section. Form view covers about 80%; the rest requires YAML.

```yaml
name: Coder                          # required, display name
description: Full-stack coder        # optional, one-line description

# Sort weight (higher first). Default 0. The default agent is seeded with 99.
priority: 0

model:
  provider: aws-bedrock-claude-invoke       # required, matches ~/.halo/global/models/<provider>.yaml
  id: global.anthropic.claude-sonnet-4-6   # the provider yaml's defaultModelId
  endpoint: https://bedrock-runtime.us-west-2.amazonaws.com  # full endpoint URL; supports custom proxy
  maxTokens: 16384                   # optional, max output tokens (default from provider yaml)

  # Prompt caching — lower cost on repeated system prompts
  # Values: true / '5m' (5-minute TTL) / '1h' (1-hour TTL)
  promptCaching: 1h

  # Thinking mode (Claude 4.x extended thinking)
  thinking:
    enabled: true
    effort: medium                   # low / medium / high / xhigh / max
    # budget: medium                 # legacy alias for effort (either is accepted)

# Personality prompt injected into the LLM. Ignored when AGENT.md is present.
system_prompt: |
  You are...

# Context window
context:
  maxTokens: 272000                  # max context (default 272000)
  compressAt: 0.9                    # auto-compact trigger (0.9 = compact when 90% full)

# Tool allowlist (strict by name; unlisted tools are not injected).
# Session/delegation tools are NOT listed here — see `team` below.
tools:
  - file_read
  - file_write
  - shell_exec

# Available skills (referenced by ID)
# When YAML lists skills, the agent automatically receives the activate_skill tool
skills:
  - code-review

# Delegation: a non-empty `team` is the on/off switch. It grants the whole
# session-tool bundle (start_session, query_agent, …) AND scopes which agents
# this one may delegate to. Omit / leave empty = no delegation.
team:
  - executor

```

> **Disable / Enable**: managed per workspace in the `disabled_items` table of `halo.db` (not in agent.yaml). Toggle via admin sidebar; disabled agents are hidden from the delegation roster, chat selector, and `/workspace share` export. Still visible in admin sidebar (dimmed + toggle switch).

**Field source**: `packages/server/src/agents/agent-loader.ts`, `AgentYamlConfig` interface.

**Full tool list**: see [dev/tools.md](../dev/tools.md).

**Common edits**:
- Agent handling long tasks → `context.maxTokens: 500000` + `context.compressAt: 0.85`
- Save cost → `model.promptCaching: '1h'`
- Complex reasoning → `thinking.enabled: true` + `thinking.effort: high`
- Read-only agent → keep only `file_read` / `file_list` / `grep` / `glob` in `tools`

## AGENT.md placeholders

AGENT.md supports `{{var}}` placeholders, rendered on session start. Uses the same renderer as SKILL.md.

Built-ins (`{{workspace_root}}`, `{{user_name}}`, …) + settings paths (`{{<skill-id>.params.<key>}}`) + env vars (`<<ENV_NAME>>`). Full rules in [skills.md placeholder section](skills.md#placeholders-template-variables).

> AGENT.md uses **fully-qualified** paths (`{{<skill-id>.params.<key>}}`). The short-form auto-rewrite (`{{params.<key>}}`) is a SKILL.md-only convenience.

**Example**:

```markdown
You are the Nano Banana client assistant.
API endpoint: {{nano-banana.params.base_url}}
API key: {{nano-banana.params.api_key}}
```

Combined with `~/.halo/secrets/settings.yaml`:

```yaml
nano-banana:
  params:
    base_url: https://api.nano-banana.example
    api_key: <<NANO_BANANA_KEY>>
```

…where the schema lives in the skill's own `config.yaml` (`skills/nano-banana/config.yaml`).

With `export NANO_BANANA_KEY=sk-xxx` in the env, the agent's system prompt gets the real key on start.

## Model registry — adding a new provider

Halo ships 13 providers (`aws-bedrock-claude-invoke`, `aws-bedrock-mantle`, `aws-bedrock-openai`, `anthropic`, `openai`, `kimi`, `deepseek`, `minimax`, `qwen`, `hunyuan`, `doubao`, `zhipu`, `mimo-token-plan-china`); each one is a yaml under `~/.halo/global/models/` whose `runtime:` field names the implementation in [packages/server/src/agents/model-runtime.ts](../../../packages/server/src/agents/model-runtime.ts) (e.g. `anthropic-messages`, `openai-chat`, `bedrock-invoke`). For any OpenAI- or Anthropic-compatible endpoint you don't need new code: pick `openai` or `anthropic` as the provider and fill in the endpoint and model id in Form view.

A provider that speaks an existing wire protocol needs only a yaml manifest with that `runtime:`; a new protocol also needs a runtime class. The step-by-step is in [dev/add-model-provider.md](../dev/add-model-provider.md). A provider yaml without `runtime:` (or with a name Halo doesn't know) makes session spawn fail with an error naming the yaml; for a bundled provider that means the seed is stale — run `halo setup` or restart the Halo server.

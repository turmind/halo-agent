# Agents — User Guide

The agent is Halo's core abstraction: personality (AGENT.md) + config (agent.yaml) + tool set.

## Three agent kinds

| Kind | Description |
|---|---|
| Built-in | Server-shipped agents (`default`, `executor`, `deep-executor` + the three internal `__evo_agent__` / `__score__` / `__apply_agent__`). Live under `~/.halo/global/agents/<id>/`. **Force-overwritten on every server startup** — local edits to these files will be lost on the next start. To customize: copy into the workspace scope (workspace replaces global) and edit there. |
| Global | Any other agent under `~/.halo/global/agents/<id>/`, e.g. one you created via the admin UI. Shared across projects. Never overwritten by the server. |
| Workspace | `<project>/.halo/agents/<id>/`, private to the current project; same-id workspace wins over global. Override is **whole-folder**: the workspace agent folder replaces the global one entirely, so copy *both* `agent.yaml` and `AGENT.md` when customizing — a folder with only `AGENT.md` has no model config and won't load. |

## Open the Agents panel

Click the `👥 Agents` icon in the Activity Bar.

```
┌─────────────────┬──────────────────────────┐
│ Agents          │  Form / YAML / MD Editor │
│─────────────────│                          │
│ ▼ Global    (2) │                          │
│   🤖 Default    │                          │
│   🤖 researcher │                          │
│ ▼ Workspace (1) │                          │
│   🤖 coder      │                          │
└─────────────────┴──────────────────────────┘
```

## Create an agent

Top-of-sidebar `+` button; modal asks for:
- **Name**: display name (e.g. "Coder")
- **Description**: one-line description
- **Scope**: Global / Workspace

The backend calls `defaultAgentYaml(name, description)` to generate a minimal `agent.yaml`.

## Edit an agent

Click an agent in the sidebar to open the right-hand editor. Three views:

### Form view
Data-driven form for name / description / model / tools / skills / thinking — click Save.

**Model section** has four fields:
- `provider` — dropdown populated from `~/.halo/global/models/*.yaml`
- `id` — combobox (input + datalist); preset options filtered by current provider, also accepts manual input of any Bedrock model ID
- `endpoint` — combobox (input + datalist); full endpoint URL (e.g. `https://bedrock-runtime.ap-northeast-1.amazonaws.com`), supports custom proxy URLs
- `maxTokens` — optional; defaults to `maxOutputTokens` in the provider yaml

Switching provider auto-resets the model id to the first model of the new provider.

**Capability buttons** (Prompt Caching / Thinking) appear when the selected model matches a registry entry with declared capabilities. For manually entered model IDs not in the registry, default presets are shown (5min/1hour for caching, Low/Medium/High/Max for thinking).

### YAML view
Edit `agent.yaml` directly (Monaco). Use this for advanced settings (like `context.maxTokens`, `promptCaching`).

### MD view
Edit `AGENT.md` (personality) and `INSTRUCTIONS.md` (preferences).
- `AGENT.md` takes precedence over YAML's `system_prompt`
- `INSTRUCTIONS.md` is injected into every agent, not just this one
- When a workspace is open, the top-right toggles **Global / Workspace**; both MDs can be edited independently of which scope the current agent lives in. Switching to a non-existent file shows `(new)`; saving auto-creates the dir/file.
- AGENT.md supports `{{var}}` placeholders (`{{<skill-id>.params.<key>}}` / `<<ENV>>` / built-ins) rendered on agent start — see [skills.md placeholder section](skills.md#placeholders-template-variables)

## Tool configuration

What tools an agent can use lives in the YAML `tools` list:

```yaml
tools:
  - file_read
  - file_write
  - shell_exec
  - start_session   # delegate to other agents
  - query_session   # message an existing session
```

**Workspace tools**: `file_read / file_write / file_edit / file_list / shell_exec / grep / glob / web_fetch`

**Session tools**: `start_session / session_list / query_session / interrupt_session / stop_session / archive_session / get_session_output / list_agents / query_agent`

Sub-agents default to `query_session` only (so they can report back to the parent). To let a sub-agent delegate further, add `start_session` (and friends) to its `tools`.

Form view lets you check workspace tools on/off; session tools still require YAML.

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

Right-click → Delete. Constraints:
- The last global agent cannot be deleted (server-enforced)
- Workspace agents delete freely

## Common workflows

**Copy a global agent into workspace for customisation**: edit it in Form view, switch scope to Workspace, Save — creates an independent copy under `<project>/.halo/agents/<id>/`.

**Multi-agent collaboration**: the Default agent discovers sub-agents via `list_agents`, starts them with `start_session`, and the sub-agent auto-reports on completion. See [sessions.md](sessions.md).

## agent.yaml field reference

Full field list grouped by section. Form view covers about 80%; the rest requires YAML.

```yaml
name: Coder                          # required, display name
description: Full-stack coder        # optional, one-line description

# Sort weight (higher first). Default 0. The default agent is seeded with 99.
priority: 0

model:
  provider: aws-bedrock-claude-invoke       # required, matches ~/.halo/global/models/<provider>.yaml
  id: global.anthropic.claude-sonnet-4-6   # default from settings.yaml params.model.default
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
  maxTokens: 200000                  # max context (default 200000)
  compressAt: 0.8                    # auto-compact trigger (0.8 = compact when 80% full)

# Tool allowlist (strict by name; unlisted tools are not injected)
tools:
  - file_read
  - file_write
  - shell_exec
  - start_session                    # session tools also go in this list
  - query_session

# Available skills (referenced by ID)
# When YAML lists skills, the agent automatically receives the activate_skill tool
skills:
  - code-review

```

> **Disable / Enable**: managed per workspace in the `disabled_items` table of `halo.db` (not in agent.yaml). Toggle via admin sidebar; disabled agents are hidden from `list_agents`, chat selector, and `/ws share` export. Still visible in admin sidebar (dimmed + toggle switch).

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

…where the schema lives at `extensions/skills/nano-banana/config.yaml`.

With `export NANO_BANANA_KEY=sk-xxx` in the env, the agent's system prompt gets the real key on start.

## Model registry — adding a new provider

Halo ships with `aws-bedrock-claude-invoke` only. Hooking up OpenAI / direct Anthropic / another Bedrock variant takes two steps:

### 1. Declare the provider

Create `~/.halo/global/models/<providerId>.yaml`:

```yaml
id: openai                             # required; matches the filename
displayName: OpenAI
description: OpenAI Chat Completions
models:
  - id: gpt-4o
    displayName: GPT-4o
    maxOutputTokens: 16384
    capabilities:
      promptCaching:
        ttlPresets:
          - { value: 5m, label: 5min }
  # No thinking block → UI automatically hides the Thinking button
```

### 2. Implement the runtime

Add a case in the switch inside [packages/server/src/agents/model-runtime.ts](../../../packages/server/src/agents/model-runtime.ts) returning a class that implements `ModelRuntime` (`messages` + `run()`). Interface detail in [design/agent.md](../design/agent.md#agent-instance).

### Usage

Set `model.provider: openai` in your agent.yaml; the Provider dropdown in Form view lists it automatically.

### Current state

Only `aws-bedrock-claude-invoke` ships an implementation. If you drop a provider yaml without a runtime implementation, session spawn fails with `Unknown provider "..."`.

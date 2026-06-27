---
name: agent
description: Create or update agent configurations (agent.yaml + AGENT.md). Activate when the user wants to add a new agent or change an existing agent's model / tools / skills / behavior.
command: /agent
verbs:
  # builtin verbs — access is set in code (SUBCOMMAND_ROUTES); shown here for reference
  - { name: list,   builtin: true,  desc: List usable agents }
  - { name: switch, builtin: true,  desc: Start a session with an agent }
  - { name: desc,   builtin: true,  desc: Show an agent's model / tools / skills }
  - { name: delete, builtin: true,  requiresAccess: full, desc: Delete an agent (workspace or global) }
  # skill verbs — access enforced from here
  - { name: create, builtin: false, requiresAccess: full, desc: Create a new agent }
  - { name: update, builtin: false, requiresAccess: full, desc: Modify an existing agent }
---

# agent

Create or modify agent configurations. An agent lives in a directory holding
`agent.yaml` (model, tools, skills, context) and optional `AGENT.md` (behavior)
/ `USER.md`.

This skill body handles **create** and **update** — the actions that need to
author files. `list` / `switch` / `desc` / `delete` are handled directly by the
`/agent` command and never reach here. The requested action is **`$1`** (full
args: `$ARGUMENTS`); if invoked by natural language, infer it from the request.

## Locations & scope rules (read before create/update)

- `<workspace>/.halo/agents/<agent-id>/` — workspace-scoped
- `~/.halo/global/agents/<agent-id>/` — shared across all workspaces

A workspace agent **overrides** a global one with the same id at runtime.
Consequences you must apply:

- **Create**: ask (or infer from the request) which scope. Default to
  **workspace** unless the user says "global" / "all workspaces". If creating a
  workspace agent whose id already exists globally, say so — the new file will
  shadow the global one in this workspace.
- **Update**: resolve which file is actually in effect FIRST — check the
  workspace path, fall back to global. Edit the file that exists; if both
  exist, edit the workspace one (it's the live one here) unless the user
  explicitly says to change the global. Never edit global to fix behavior in
  one workspace when a workspace copy shadows it — that edit would have no
  effect here.
- **Built-in agents** (`default`, `executor`, `deep-executor`, internal
  `__*__`): their global copies are force re-seeded on every server start —
  direct edits to those global files are lost. To customize a built-in, copy
  it to workspace scope and edit there.

## Create

Generate `agent.yaml`:

```yaml
name: <AgentName>
description: <one-line description shown in the agent picker>
priority: 50            # higher = appears earlier in the picker
model:
  provider: aws-bedrock-claude-invoke
  id: global.anthropic.claude-sonnet-4-6
  endpoint: https://bedrock-runtime.us-east-1.amazonaws.com
  promptCaching: 1h     # optional: Bedrock prompt caching ('1h' or '5m')
  thinking:
    enabled: true
    effort: medium      # off | low | medium | high | xhigh
system_prompt: >
  <Brief one-paragraph role statement. Keep behavioral detail in AGENT.md.>
context:
  maxTokens: 200000
  compressAt: 0.8       # auto-compact at 80%
tools:
  - file_read
  - file_write
  - file_edit
  - file_list
  - shell_exec
  - grep
  - glob
  - web_fetch
  - view_image
  # Session tools — only for orchestrator agents that delegate:
  # - start_session
  # - query_agent
  # - session_list
  # - get_session_output
  # - query_session
  # - interrupt_session
  # - stop_session
skills:
  - <skill-id>
```

**Required:** `model.provider` (must match an id in `~/.halo/global/models/<provider>.yaml`),
`model.id`, `model.endpoint` — the server rejects sessions missing any of these.

**Model choice:** Sonnet 4.6 is the default workhorse. Opus 4.8
(`global.anthropic.claude-opus-4-8`) when the task visibly needs deeper
reasoning (costs more — not the default). Haiku 4.5 for fast, lightweight work.

**Thinking:** `medium` is a good default; `high`/`xhigh` only for deep-reasoning
agents; `enabled: false` to turn it off entirely.

**Delegation (`team`):** only relevant when the agent holds `start_session`.
Omit the `team` field and the agent may delegate to every agent in the
workspace (the default). Add `team: [agent-id, ...]` to restrict it to exactly
those ids — the injected roster, `start_session`, and `query_agent` all honor
the list. Use this to scope a sub-agent so it can only reach the few agents
relevant to its job. The agent can always spawn parallel copies of itself
regardless of the list.

Then write **`AGENT.md`** (behavior doc, read as part of the system prompt) —
keep `system_prompt` brief and put the detail here:

1. Role and scope — what it's for, what it isn't
2. When to use which tool — concrete decision rules
3. Output style — format, tone, length
4. Constraints — what it must not do, when to ask

Optionally write **`USER.md`** if the agent needs to know who the user is
(name, role, language, domain). Workspace `USER.md` overrides global.

## Update

`file_read` the target `agent.yaml`, change only the requested fields, write it
back. Common edits: switch `model.id`, adjust `thinking.effort`, add/remove a
tool or skill, rewrite `system_prompt` (or edit `AGENT.md` for behavior). Don't
rewrite untouched fields. Confirm the agent id and scope first if ambiguous.

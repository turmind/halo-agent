---
name: agent
description: Create or update agent configurations (agent.yaml + AGENT.md). Activate when the user wants to add a new agent or change an existing agent's model / tools / skills / behavior.
command: /agent
verbs:
  # builtin verbs — access is set in code (SUBCOMMAND_ROUTES); shown here for reference
  - { name: list,   builtin: true,  requiresAccess: workspace, desc: List usable agents }
  - { name: switch, builtin: true,  requiresAccess: workspace, desc: Start a session with an agent }
  - { name: desc,   builtin: true,  requiresAccess: workspace, desc: Show an agent's model / tools / skills }
  - { name: delete, builtin: true,  requiresAccess: full,      desc: Delete an agent (workspace or global) }
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

## Locations

- `<workspace>/.halo/agents/<agent-id>/` — workspace-scoped
- `~/.halo/global/agents/<agent-id>/` — shared across all workspaces

A workspace agent **overrides** a global one with the same id at runtime.

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
  # - list_agents
  # - query_agent
  # - start_session
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

**Model choice:** Sonnet 4.6 is the default workhorse. Opus 4.7 only when the
task visibly needs deeper reasoning (costs more — not the default). Haiku 4.5
for fast, lightweight work.

**Thinking:** `medium` is a good default; `high`/`xhigh` only for deep-reasoning
agents; `enabled: false` to turn it off entirely.

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

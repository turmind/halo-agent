---
name: Create Agent
description: Create new agent configurations with YAML and AGENT.md files
command: /create-agent
---

# Create Agent

When the user asks you to create a new agent, generate the following files.

## agent.yaml

```yaml
name: <AgentName>
description: <one-line description shown in /agents and the agent picker>
priority: 50            # higher = appears earlier in /agents (default 99 for default agent)
model:
  provider: aws-bedrock-claude-invoke
  id: global.anthropic.claude-sonnet-4-6
  endpoint: https://bedrock-runtime.us-east-1.amazonaws.com
  promptCaching: 1h     # optional: enable Bedrock prompt caching ('1h' or '5m'); cuts cost on repeated turns
  thinking:             # optional but recommended for non-trivial agents
    enabled: true
    effort: medium      # off | low | medium | high | xhigh
system_prompt: >
  <Brief one-paragraph role statement. Keep behavioral details in AGENT.md, not here.>
context:                # optional — defaults are usually fine
  maxTokens: 200000
  compressAt: 0.8       # auto-compact when context hits 80%
tools:                  # workspace tools the agent can call
  - file_read
  - file_write
  - file_edit
  - file_list
  - shell_exec
  - grep
  - glob
  - web_fetch
  - view_image
  # Session tools (only for orchestrator-style agents that delegate)
  # - list_agents
  # - query_agent
  # - start_session
  # - session_list
  # - get_session_output
  # - query_session
  # - interrupt_session
  # - stop_session
skills:                 # skill ids the agent is allowed to activate
  - <skill-id>
```

### Required fields

`model.provider`, `model.id`, and `model.endpoint` are all required — the server rejects sessions
with any of them missing. `provider` must match an id from `~/.halo/global/models/<providerId>.yaml`
(default install ships with `aws-bedrock-claude-invoke`).

### Choosing a model

- **Sonnet 4.6** — default workhorse. Good for chat, code, most agent work.
- **Opus 4.7** — only when the task visibly needs deeper reasoning (architecture write-ups, complex
  refactors, long-form deliverables). Costs more — don't make it the default.
- **Haiku 4.5** — quick / lightweight tasks where latency matters more than depth.

### Thinking effort

`thinking.effort` controls reasoning budget. `medium` is a good default. Use `high`/`xhigh` only on
deep-reasoning agents; `low` for fast-turn agents. Set `enabled: false` to disable thinking entirely
(model returns answer directly, no `<thinking>` block).

## AGENT.md

A behavior document the agent reads as part of its system prompt. Cover:

1. **Role and scope** — what this agent is for, what it isn't
2. **When to use which tool** — concrete decision rules
3. **Output style** — format, tone, length expectations
4. **Constraints** — what it must not do, when to ask for help

Keep `system_prompt` brief and put the meat here. Easier to edit, better diffs, and the file is
visible in the agent picker UI.

## USER.md (optional)

If this agent should know specifics about *who* the user is (name, role, language preference,
domain background), put that in a sibling `USER.md` file. Workspace `USER.md` overrides global.

## Location

Save the files to:
- `<workspace>/.halo/agents/<agent-id>/` for workspace-scoped agents, or
- `~/.halo/global/agents/<agent-id>/` for agents shared across all workspaces.

Workspace agents override globals with the same id.

## After creating

Tell the user how to start a session with the new agent: `/agent <name>` (in any channel) or pick
it from the dropdown in the web UI.

# Agent — Requirements

Agent configuration management: creating, editing YAML / Form / AGENT.md.

## Layout

Left sidebar has two collapsible groups (Global / Workspace); right side is the editor:

```
┌─────────────────┬───────────────────────────────┐
│ Agents          │                               │
│─────────────────│   Form / YAML / MD Editor     │
│ ▼ Global    (2) │                               │
│   🤖 Default     │                               │
│   🤖 sleeper     │                               │
│ ▼ Workspace (1) │                               │
│   🤖 coder       │                               │
└─────────────────┴───────────────────────────────┘
```

## Core behaviour

### YAML / Form dual view
- **YAML view**: Monaco-edit the raw `agent.yaml`
- **Form view**: data-driven form derived from YAML fields (name / description / model / tools / skills / thinking)
- Switching views preserves edits

### CRUD
| Operation | API |
|---|---|
| List | `GET /api/agent-configs?projectId=xxx` |
| Create | `POST /api/agent-configs` (body: `{name, description, scope, projectId?}`) |
| Read YAML | `GET /api/agent-configs/:id/yaml` |
| Write YAML | `PUT /api/agent-configs/:id/yaml` |
| Delete | `DELETE /api/agent-configs/:id` |
| Toggle disabled | `PATCH /api/agent-configs/:id/toggle` → `{ ok, disabled }` |

Creating requires name + description; the backend uses `defaultAgentYaml(name, description)` to produce a full YAML.

### Scope (Global / Workspace)
- **Global**: `~/.halo/global/agents/<id>/agent.yaml` — shared across projects
- **Workspace**: `<project>/.halo/agents/<id>/agent.yaml` — project-private; wins over a same-id global

Same id present in both scopes: workspace wins; the overridden global is greyed out as "overridden".

**Cross-scope conflict**: creating a same-name agent in the other scope prompts about the overwrite behaviour.

**Delete protection**: at least one global agent must remain (server-enforced).

### Disable / Enable
- Toggle switch on each agent row in the admin sidebar. Disabled state is stored per workspace in the `disabled_items` table of `halo.db` (not in agent.yaml). Both global and workspace agents can be independently toggled per workspace.
- Disabled agents are greyed out (opacity-40) with sub-text "disabled"; the toggle stays visible.
- Hidden from: `list_agents` tool, chat agent selector, `/ws share` export.
- Still visible in the admin management sidebar for re-enabling.

### Tool selection
- **Session tools**: `start_session` / `session_list` / `query_session` / `interrupt_session` / `stop_session` / `archive_session` / `get_session_output` / `list_agents` / `query_agent` (enable by name in `agent.yaml tools`)
- **Workspace tools**: `file_read` / `file_write` / `file_edit` / `file_list` / `shell_exec` / `grep` / `glob` / `web_fetch`, returned by `GET /api/agent-configs/tools`
- **`activate_skill`**: auto-injected whenever the YAML lists `skills`; loads the full SKILL.md on demand

### Skill selection
`GET /api/skills?projectId=xxx` lists available skills; `agent.yaml`'s `skills` references them by id.

### MD file editing

| File | Writable | Purpose |
|---|---|---|
| AGENT.md | yes | Agent personality / behaviour (overrides YAML `system_prompt`) |
| INSTRUCTIONS.md | yes | User preferences (global or workspace scope) |

The MD editor has a **Global / Workspace** scope toggle (visible when a workspace is open).

API: `GET/PUT /api/agent-configs/:id/md/:fileType`

### Test button
- Sets `selectedAgentId` in the chat store
- Dispatches a `halo:navigate` event to switch to explorer/chat
- The user chats with the selected agent in the main chat panel
- **Not rendered for internal agents** (`internal: true`) — they're delegated to by other agents, never driven directly

### Internal agents
Agents flagged `internal: true` in agent.yaml (e.g. `__evo_agent__`, `__apply_agent__`, `__score__`) are platform tooling. They are hidden from every user-facing surface: `list_agents` tool, `/session new` default pick, and the chat agent selector — and have no Test button. They stay editable in the management sidebar's collapsed **Internal** group.

Replaces the old built-in test chat panel, giving a more realistic environment (full workspace tools + session persistence).

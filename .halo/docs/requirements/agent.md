# Agent — Requirements

Agent configuration management: creating, editing via Form / mini workspace (agent.yaml, AGENT.md).

## Layout

Left sidebar has two collapsible groups (Global / Workspace — the latter only while a workspace is open); right side is the editor. Each group header has a `+` to create an agent in that scope, and the sidebar header has a refresh button:

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

### Form / Edit dual view
- **Form view** (default): data-driven form derived from the YAML fields (name / description / priority / model incl. thinking and capabilities / system_prompt / team / tools / skills). Edits auto-save to `agent.yaml` (debounced 500 ms). If `agent.yaml` fails to load or parse, the form is replaced by an error with a Retry button and nothing is auto-saved (an unparsable file is fixed in Edit view); below the form, a read-only preview of `AGENT.md` is shown when it has content
- **Edit view**: the **Edit** button opens a mini workspace (file tree + editor) rooted at the agent's folder, for editing `agent.yaml` / `AGENT.md` directly; **Back** returns to the form, which reloads from disk
- The chosen view is remembered per agent in `localStorage`

### CRUD
| Operation | API |
|---|---|
| List | `GET /api/agent-configs?projectId=xxx` |
| Create | `POST /api/agent-configs` (body: `{name, description, scope, projectId?}`) |
| Read YAML | `GET /api/agent-configs/:id/yaml` (`scope=workspace` requires `projectId`, else 400) |
| Write YAML | `PUT /api/agent-configs/:id/yaml` (same `projectId` rule) |
| Delete | `DELETE /api/agent-configs/:id` (same `projectId` rule — never falls back to deleting the same-named global agent) |
| Toggle disabled | `PATCH /api/agent-configs/:id/toggle` → `{ ok, disabled }` |

Creating requires a name (description is optional); the id is derived from the name. The backend uses `defaultAgentYaml(name, description)` to produce a full YAML and also scaffolds an `AGENT.md`.

### Scope (Global / Workspace)
- **Global**: `~/.halo/global/agents/<id>/agent.yaml` — shared across projects
- **Workspace**: `<project>/.halo/agents/<id>/agent.yaml` — project-private; wins over a same-id global

Same id present in both scopes: workspace wins; the overridden global is greyed out as "overridden".

**Cross-scope conflict**: creating a same-name agent in the other scope prompts about the overwrite behaviour.

**Delete protection**: at least one global agent must remain (server-enforced). The sidebar offers delete (hover trash) on workspace agents only; global rows show a crown instead.

### Disable / Enable
- Toggle switch on each agent row in the admin sidebar (shown on hover while enabled; not offered for internal agents or when no workspace is open). Disabled state is stored per workspace in the `disabled_items` table of `halo.db` (not in agent.yaml). Both global and workspace agents can be independently toggled per workspace.
- Disabled agents are greyed out (opacity-40) with sub-text "disabled"; the toggle stays visible.
- Hidden from: the delegation roster, chat agent selector, `/workspace share` export.
- Still visible in the admin management sidebar for re-enabling.

### Tool selection
- **Session tools**: `start_session` / `session_list` / `query_session` / `interrupt_session` / `stop_session` / `archive_session` / `get_session_output` / `query_agent` — **not** selected by name; the whole bundle is granted automatically by a non-empty `team` (see below). Listing them under `agent.yaml tools` has no effect.
- **Workspace tools**: `file_read` / `view_image` / `file_write` / `file_edit` / `file_list` / `shell_exec` / `grep` / `glob` / `web_fetch`, plus the single `relay_send` chip (grants the whole cross-workspace relay set, full-access sessions only), returned by `GET /api/agent-configs/tools`. `view_image` is dropped at runtime when the model can't take images (the form dims it)
- **`activate_skill`**: auto-injected when the YAML lists at least one usable skill (not disabled, allowed at the session's access level); loads the full SKILL.md on demand

### Team (delegation switch + whitelist)
- Optional `team: [id, …]` field in `agent.yaml`. A **non-empty** list is the on/off switch for delegation: it grants the whole session-tool bundle (`start_session` / `query_agent` / …) plus the prompt roster, AND scopes which agents this one may reach.
- **Unset or empty `[]` = no delegation** — no session tools, no roster. (Breaking change from the earlier "unset = every agent reachable" default; agents that relied on implicit-all must now list their team explicitly.)
- Enforced server-side on `start_session` and `query_agent`, not just in the roster — a call to a non-team agent is rejected.
- `self` is treated like any other agent: shown in the picker tagged `(you)`. Include the agent's own id to allow parallel self-spawn (the seed `default` agent lists `default`); omit it to block self-spawn — no special-casing.
- **Admin form**: the Team is an always-present chip picker (one chip per delegatable agent, `self` tagged `(you)`). Checking a chip toggles that id in the `team` list; unchecking the last one drops the field entirely (`undefined` = delegation off), mirroring the server's "non-empty team" switch.
- **Picker only offers effective, enabled agents.** A chip shows iff the *effective* agent for that id is runnable — same resolve-then-check the runtime uses: a workspace agent shadows the same-id global (the overridden global is skipped), then anything disabled is dropped. So a global stays out of the picker when its workspace override is disabled, even though that global's own record isn't flagged disabled. Matches the chat / cron selectors and the runtime roster — you can never pick a teammate that can't actually run.

### Skill selection
`GET /api/skills?projectId=xxx` lists available skills; `agent.yaml`'s `skills` references them by id. The form offers enabled skills only; ids that are referenced but not installed show as red ⚠ chips (click to remove).

### MD file editing

| File | Writable | Purpose |
|---|---|---|
| AGENT.md | yes | Agent personality / behaviour (overrides YAML `system_prompt`) |
| INSTRUCTIONS.md | yes | User preferences (global or workspace scope) |
| INDEX.md | no | Project index, read-only through this API |

The admin edits `AGENT.md` through the Edit mini workspace; `INSTRUCTIONS.md` is not edited from this tab.

API: `GET/PUT /api/agent-configs/:id/md/:fileType`, `GET /api/agent-configs/:id/md-all`

### Test button
- Opens a fresh chat draft tab (an untouched draft is reused) with this agent selected
- Dispatches a `halo:navigate` event to switch to explorer/chat
- The user chats with the selected agent in the main chat panel
- **Not rendered for internal agents** (`internal: true`) — they're delegated to by other agents, never driven directly

### Internal agents
Agents flagged `internal: true` in agent.yaml (e.g. `__evo_agent__`, `__apply_agent__`, `__score__`) are platform tooling. They are hidden from every user-facing surface: the delegation roster, `/session new` default pick, the chat agent selector, the Cron job agent picker and `halo cli`'s agent list (`halo agents`) — and have no Test button. They stay editable in the management sidebar's collapsed **Internal** group.

Replaces the old built-in test chat panel, giving a more realistic environment (full workspace tools + session persistence).

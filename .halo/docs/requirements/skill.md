# Skill — Requirements

A skill is a knowledge pack an agent can reference — prompts, templates, scripts, reference docs.

## Core behaviour

### Mini workspace
Clicking a skill in the sidebar turns the main area into a mini workspace:
- File tree: every file in the skill directory
- Monaco editor: edit any file (SKILL.md, templates, scripts)
- Reuses the main workspace's editor / explorer components

The skill editor runs in an **isolated** `EditorStoreProvider` — its tabs, file tree, and
selection are independent of the main Explorer Canvas, so switching back to Explorer
restores that Canvas untouched. The provider is keyed on `${id}:${scope}`, so switching
between skills also resets the mini workspace (no cross-skill tab bleed). The maximize
button is hidden in this mode (`showMaximize={false}`).

### CRUD

| Operation | API |
|---|---|
| List | `GET /api/skills?projectId=xxx` — returns BOTH global and workspace skills as separate entries (no merge); global entries shadowed by a same-id workspace skill are flagged `overridden: true` |
| Create | `POST /api/skills` (body: name, description, scope, projectId) |
| Delete | `DELETE /api/skills/:id?scope=...&projectId=...` |
| Toggle disabled | `PATCH /api/skills/:id/toggle?scope=...&projectId=...` → `{ ok, disabled }` |

### Scope (Global / Workspace)

| Scope | Path | Notes |
|---|---|---|
| Global | `~/.halo/global/skills/<id>/` | Shared across projects |
| Workspace | `<project>/.halo/skills/<id>/` | Wins over a same-id global skill at runtime |

### Management UI

The Skills sidebar mirrors the Agents sidebar layout:
- Two collapsible sections — **Global** (globe icon) and **Workspace** (folder icon). Expanded state persists in `halo_skills_expandedScopes` (localStorage)
- Each section header has its own **+ button** — scope is implicit from which button is clicked, no pop-up picker
- Creating a name that collides with the other scope prompts a one-time confirmation explaining the runtime override
- Items overridden by a workspace skill are rendered dimmed with "overridden" subtitle
- Disabled skills are rendered dimmed with "disabled" subtitle and a toggle switch (always visible). Disabled state is stored per workspace in the `disabled_items` table of `halo.db` (not in SKILL.md frontmatter). Both global and workspace skills can be independently toggled per workspace. Disabled skills are excluded from system prompt injection, activate_skill tool, agent form skill picker, and `/workspace share` export.
- Selection uses a composite `id:scope` key (localStorage `halo_skills_selectedKey`) so the same id in different scopes can coexist

### Auto-sync behaviour (workspace vs. global)

The Skills sidebar and any open mini-workspace editor stay in sync with the file system via `file:changed` WS events — but the server's watcher is scoped to the current workspace, so the guarantees differ by scope:

| Change | Workspace skills | Global skills |
|---|---|---|
| Create / delete a skill dir | Live (watcher emits add/unlink → `skill-bus` bump → sidebar refetches) | Refreshed opportunistically on **window focus** |
| Edit a file inside a skill while the mini-workspace editor has it open | Live (EditorPanel translates workspace-rel path into its own tab.path and refetches) | Live for the currently-open tab (same code path) — but the file tree change won't show new/removed sibling files until focus refresh |
| Edit from external CLI / SSH | Same as above | Same as above |

So when an agent (or the `skill` skill) creates a **global** skill, the Skills sidebar won't reflect it until the user refocuses the browser window. The `skill` skill documents this so agents can warn the user.

### SKILL.md protocol

```markdown
---
name: code-review
description: Automated code review with checklist
command: /review
---

# Code Review

Review the code for:
1. Correctness
2. Performance
...
```

- **Frontmatter** (required): `name` (kebab-case, = directory name) + `description` — injected into the agent system prompt for discovery
- **Body**: the full instructions, lazily loaded by the agent via `activate_skill`
- **Optional fields**: `allowed-tools` (space-separated), `metadata` (custom kv), `command` (slash command registration — opt-in, only declared commands exist), `requiresAccess` (one of `full` / `workspace` / `readonly`), `verbs` (Halo extension — subcommand list, each `{ name, builtin?, requiresAccess?, desc? }`; skill verbs' access gates are declared here), `disable-model-invocation` (standard — command exists but skill is not injected for model auto-activation), `user-invocable` (standard — `false` = never a slash command, model can still activate)
- **Arguments**: user command-line args fill `$ARGUMENTS` / `$1`–`$9` placeholders in the body (quotes respected, `\$` escapes, `$5.00`/`$PATH` untouched); `{{...}}` placeholders (params/channel/workspace_root etc.) carry platform-injected values — the two coexist without cross-translation. A verb reaches the body as `$1` for dispatch; args are no longer appended verbatim to the body end

### Skill-as-command
When a `command` field is present (e.g. `command: /review`), the skill auto-registers as a slash command. Users trigger it with `/review`. See [commands](command.md).

If the `command` collides with a built-in slash command (or another skill's `command`), it is dropped from the command list with a warning — built-ins win, then first-come among skills. Only the slash command is lost; the skill stays usable via `activate_skill`. See [conflict detection](command.md#conflict-detection).

### Access-level gate (`requiresAccess`)

A skill can declare a minimum session access level in frontmatter:

```yaml
---
name: workspace
description: ...
command: /workspace
requiresAccess: workspace
---
```

When set, the skill is hidden from agents whose session access level is more restricted (e.g. a `readonly` Telegram channel can't see or invoke a `requiresAccess: full` skill). The check runs both at metadata-load time (so it never enters the system prompt's `<available_skills>` block) and at slash-command execution time (server-side gate, so a user typing the slash manually still hits it). `requiresAccess` is independent of `command`: an agent-activated-only skill (no `command`) is still hidden from too-restricted sessions.

Default is unset → the skill is visible to all access levels. `full` is the standard "admin-only" marker for skills that mutate global state (cron, self, etc.).

### Settings integration

When a skill needs configuration (API keys, endpoints, preset values):
1. Declare them in a `config.yaml` next to `SKILL.md` — schema lives with the package
2. Reference them from the SKILL.md body with the short form `{{params.<key>}}` (auto-qualified to `{{<skill-id>.params.<key>}}` at activation)
3. Values live in `~/.halo/secrets/settings.yaml` at `<skill-id>.params.<key>` — written by the user via the Settings page or by hand
4. Use `<<ENV_NAME>>` placeholders for sensitive values; the real value comes from env vars at render time

Full rules: [guide/skills.md](../guide/skills.md#placeholders-template-variables) and [requirements/settings.md](settings.md).

### Agent references
Agents reference skills by id in `agent.yaml`'s `skills` field:

```yaml
skills:
  - code-review
  - test-writer
```

Runtime uses **progressive disclosure**:
1. **Discovery**: only skill metadata (name + description) is injected into the system prompt
2. **Activation**: the agent calls `activate_skill(skill_id)` to load the full SKILL.md
3. **Execution**: the agent follows the loaded instructions; `file_read` can pull resources from the skill directory

Avoids bloating the system prompt with unused skill content.

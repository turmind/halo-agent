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
| List | `GET /api/skills?projectId=xxx` — returns workspace, global AND extension skills as separate entries (no merge); entries shadowed by a higher-precedence same-id skill are flagged `overridden: true`; extension entries carry `extId` |
| Create | `POST /api/skills` (body: name, description, scope, projectId) — `scope: 'extension'` → 403 |
| Delete | `DELETE /api/skills/:id?scope=...&projectId=...` — `scope=extension` → 403 |
| Toggle disabled | `PATCH /api/skills/:id/toggle?scope=...&projectId=...` → `{ ok, disabled }` (all three scopes) |

### Scope (Global / Workspace / Extension)

Runtime precedence for one id: workspace > global > extension. The higher folder wins wholly.

| Scope | Path | Notes |
|---|---|---|
| Global | `~/.halo/global/skills/<id>/` | Shared across projects; wins over a same-id extension skill |
| Workspace | `<project>/.halo/skills/<id>/` | Wins over a same-id global or extension skill at runtime |
| Extension | `~/.halo/global/extensions/<extId>/skills/<id>/` | Shipped by an installed extension (valid manifest; id `<extId>` or `<extId>-*`). Read-only; removed with the extension. See [design/canvas-extensions.md → Extension skills](../design/canvas-extensions.md#extension-skills) |

### Management UI

The Skills sidebar mirrors the Agents sidebar layout:
- Two collapsible sections — **Global** (globe icon) and **Workspace** (folder icon, shown only while a workspace is open). Expanded state persists in `halo_skills_expandedScopes` (localStorage)
- Each section header has its own **+ button** — scope is implicit from which button is clicked, no pop-up picker
- Creating a name that collides with the other scope prompts a one-time confirmation explaining the runtime override
- Items overridden by a higher-precedence skill are rendered dimmed with "overridden" subtitle
- A third section, **Extensions** (puzzle icon), is shown only when an installed extension ships skills. It has no + button and no trash button; the toggle stays. The subtitle reads "from extension X". Clicking one opens a read-only file view (badge "from extension · read-only" and a hint to copy the folder into global / workspace) instead of the mini workspace editor
- Each row has a toggle switch (shown on hover while enabled, always visible once disabled) and a hover trash button. Disabled skills are rendered dimmed with "disabled" subtitle. Disabled state is stored per workspace in the `disabled_items` table of `halo.db` (not in SKILL.md frontmatter). Global, workspace and extension skills can each be toggled per workspace (rows keyed `scope:id`, e.g. `extension:<id>`). Disabled skills are excluded from system prompt injection, activate_skill tool, agent form skill picker, and `/workspace share` export.
- Selection uses a composite `id:scope` key (localStorage `halo_skills_selectedKey`) so the same id in different scopes can coexist

### Auto-sync behaviour (workspace vs. global)

Every skill list — the chat's slash-command popup, the Skills sidebar, the agent form's skill picker — refetches on the `skills:changed` WS frame (→ `skill-bus` bump), in every open admin tab. The server sends it after every real mutation: REST create / delete / toggle and `/skill disable|enable|delete` from any chat or channel (a no-op toggle sends nothing). A workspace change reaches only that workspace's tabs; a global one reaches all. File-system edits differ by scope, because the server's watcher covers only the current workspace:

| Change | Workspace skills | Global skills |
|---|---|---|
| Via Skills tab / REST / `/skill` command | Live | Live |
| Create / delete a skill dir or edit SKILL.md frontmatter on disk (agent `file_write`, CLI / SSH) | Live (watcher → 300 ms debounce → `skills:changed` only when the folder ids / frontmatter changed) | Refreshed opportunistically on **window focus** while the Skills page is open |
| Edit a file inside a skill while the mini-workspace editor has it open | Live (EditorPanel translates workspace-rel path into its own tab.path and refetches) | Live for the currently-open tab (same code path) — but the file tree change won't show new/removed sibling files until focus refresh |

So when an agent writes a **global** skill folder directly, the lists won't reflect it until the user refocuses the browser window on the Skills page, or switches session / agent. The `skill` skill documents this so agents can warn the user.

Extension skills follow the extension, not a file watcher. Installing or uninstalling an extension broadcasts `extension:changed`, which bumps `skill-bus`, so the sidebar and the agent form's skill picker refetch live. Edits inside an installed extension's `skills/` push nothing (show on focus refresh); reinstalling the extension is how a change ships.

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
- **Optional fields**: `command` (slash command registration — opt-in, only declared commands exist), `requiresAccess` (one of `full` / `workspace` / `readonly`), `verbs` (Halo extension — subcommand list, each `{ name, builtin?, requiresAccess?, desc? }`; skill verbs' access gates are declared here), `disable-model-invocation` (standard — command exists but skill is not injected for model auto-activation), `user-invocable` (standard — `false` = never a slash command, model can still activate). Other standard fields (`allowed-tools`, `metadata`) are tolerated but not read
- **Arguments**: user command-line args fill `$ARGUMENTS` / `$1`–`$9` placeholders in the body (quotes respected, `\$` escapes, `$5.00`/`$PATH` untouched); `{{...}}` placeholders (params/channel/workspace_root etc.) carry platform-injected values — the two coexist without cross-translation. A verb reaches the body as `$1` for dispatch; args are no longer appended verbatim to the body end

### Skill-as-command
When a `command` field is present (e.g. `command: /review`), the skill auto-registers as a slash command. Users trigger it with `/review`. See [commands](command.md).

If the `command` collides with a built-in slash command (or another skill's `command`), it is dropped from the command list (a warning is logged when another skill owns the name) — built-ins win, then first-come among skills. Only the slash command is lost; the skill stays usable via `activate_skill`. See [conflict detection](command.md#conflict-detection).

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

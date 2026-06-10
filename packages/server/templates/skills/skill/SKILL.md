---
name: skill
description: Create or update skill definitions (SKILL.md + resource files). Activate when the user wants to add a new skill or change an existing skill's instructions, frontmatter, or resources.
command: /skill
verbs:
  # builtin verbs — access is set in code (SUBCOMMAND_ROUTES); shown here for reference
  - { name: list,    builtin: true, desc: List all skills (with disabled/overridden flags) }
  - { name: desc,    builtin: true, desc: Show a skill's description and status }
  - { name: disable, builtin: true, requiresAccess: workspace, desc: Disable/enable a skill (this workspace) }
  - { name: delete,  builtin: true, requiresAccess: full, desc: Delete a skill (workspace or global) }
  # skill verbs — access enforced from here
  - { name: create, builtin: false, requiresAccess: full, desc: Create a new skill }
  - { name: update, builtin: false, requiresAccess: full, desc: Modify an existing skill }
---

# skill

Create or modify skill definitions. A skill is a chunk of instruction (and
optionally extra resource files) that an agent pulls into context on demand via
`activate_skill`. Use skills for capabilities the agent doesn't need on every
turn — domain knowledge, multi-step procedures, output templates — to keep the
base prompt small.

This skill body handles **create** and **update**. `list` / `desc` / `disable`
/ `delete` are handled directly by the `/skill` command and never reach here.
The requested action is **`$1`** (full args: `$ARGUMENTS`); if invoked by
natural language, infer it from the request.

## Locations & override rules (read before create/update)

- `<workspace>/.halo/skills/<skill-id>/` — workspace-scoped
- `~/.halo/global/skills/<skill-id>/` — shared across all workspaces

A workspace skill **wholly overrides** a global one with the same id — the
whole folder, SKILL.md plus every resource file. There is NO per-file fallback:
if the workspace copy lacks a resource file the global one has, that file is
simply absent. Consequences you must apply:

- **Create**: ask (or infer) which scope. Default to **workspace** unless the
  user says "global" / "all workspaces". If the id already exists globally,
  say so — the new workspace folder will shadow the global one here entirely.
- **Update**: resolve which folder is actually in effect FIRST — workspace
  path if it exists, else global. Edit the live one; never edit global to fix
  behavior in a workspace where a workspace copy shadows it. To customize a
  global skill for one workspace, copy the WHOLE folder to workspace scope
  (including resource files — remember: no per-file fallback), then edit.
- **Built-in skills** (`agent`, `skill`, `organize-workspace`,
  `share-workspace`, `manage-cron-jobs`, `send-file`, `create-halo-acp`,
  `express-self`): their global copies are force re-seeded on every server
  start — direct edits to those global files are lost. Customize at workspace
  scope instead.
- **Disabled state** lives per-workspace in the `disabled_items` DB table, not
  in SKILL.md — creating or editing files never re-enables a disabled skill.

## Create

### Step 1: SKILL.md

```markdown
---
name: <skill-id>
description: <one-line description; this is what the agent sees in the skill list>
command: /<slug>            # optional: also expose as a slash command
requiresAccess: <level>     # optional: full | workspace | readonly gate
---

# <Heading>

<Detailed instructions for the agent. The frontmatter description tells the
agent *when* to activate; the body tells it *what to do* once activated.>
```

Frontmatter fields:
- `name` — display name in `/help` and the skill list (kebab-case, match the directory)
- `description` — short hint the agent uses to decide whether to activate
- `command` (optional) — expose as a slash command users can type
- `requiresAccess` (optional) — hide from sessions below this access level
- `verbs` (optional, for object skills) — declared sub-actions; each
  `{ name, builtin?, requiresAccess?, desc? }`. Verbs with `builtin: true` are
  handled by platform code; others fall through to this body via `$1`.

### Resource files (optional)

Put extra files in the same skill directory — templates, reference docs,
scripts. The skill body can `file_read` them on activation. Inlining large
reference material in the body bloats every activation; sibling files keep the
body lean and the references on-demand.

### Step 2: Wire it to an agent

A skill is only available if an agent's `agent.yaml` lists it under `skills:`:

```yaml
skills:
  - my-new-skill
```

If the user doesn't say which agent, add it to `default`.

## Update

`file_read` the live SKILL.md (workspace first — see override rules), change
only what's requested, write back. Don't rewrite untouched sections. If the
skill declares `verbs`, keep the frontmatter list and any builtin handlers in
sync (builtin verbs are platform code; only their desc text lives here).

## Writing good skill bodies

A skill body's job is to make the activation decision and the execution
predictable. Three sections cover that:

- **When to use this** — what the activation signal looks like, so the agent's
  choice to load the skill is well-founded.
- **Steps** in execution order — the procedure as the agent will follow it.
- **Constraints / failure modes** — phrased as consequences ("X breaks Y
  because Z") so the agent can reason about edge cases, not just memorize
  prohibitions.

Generic advice ("be helpful", "write good code") duplicates what every agent
already knows; the skill body's leverage is project-specific or domain-specific
guidance.

## Patterns that go sideways

- Trivial one-liners as skills bloat the activation list and add latency to
  every skill search; inline instructions in the agent's prompt land cleaner
  for small, frequent operations.
- Skills that duplicate built-in tool behavior (`file_read`, `web_fetch`) add
  an indirection layer with no leverage.
- Hard-coded paths to specific user files break when the workspace moves or
  gets shared; templating paths keeps the skill portable.

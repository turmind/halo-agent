---
name: Create Skill
description: Create new skill definitions with SKILL.md files
command: /create-skill
---

# Create Skill

A skill is a chunk of instruction (and optionally extra resource files) that an agent can pull into
its context on demand via the `activate_skill` tool. Use skills for capabilities the agent doesn't
need on every turn — domain knowledge, multi-step procedures, output templates — to keep the base
prompt small.

## Step 1: Create SKILL.md

```markdown
---
name: <Display Name>
description: <one-line description; this is what the agent sees in the skill list>
command: /<slug>            # optional: if set, the skill is also a slash command users can type
---

# <Heading>

<Detailed instructions for the agent. The frontmatter description tells the agent
*when* to activate; the body tells it *what to do* once activated.>
```

### Frontmatter fields

- `name` — display name in `/help` and the skill list
- `description` — short hint shown to the agent so it can decide whether to activate
- `command` (optional) — if set, the skill is exposed as a slash command (e.g. `/organize-workspace`).
  When the user types it, the skill body is prepended to the next turn. Useful for recipes the
  user wants to trigger explicitly.

### Resource files (optional)

Put extra files in the same skill directory — templates, reference docs, scripts. The skill body
can `file_read` them on activation. Inlining large reference material in the body bloats every
activation; sibling files keep the body lean and the references on-demand.

## Step 2: Save

- Workspace skills: `<workspace>/.halo/skills/<skill-id>/SKILL.md`
- Global skills: `~/.halo/global/skills/<skill-id>/SKILL.md`

Workspace skills override globals with the same id.

## Step 3: Wire it to an agent

A skill is only available if an agent's `agent.yaml` lists it under `skills`:

```yaml
skills:
  - my-new-skill
```

- Workspace agent file: `.halo/agents/<agent-id>/agent.yaml`
- Global agent file: `~/.halo/global/agents/<agent-id>/agent.yaml`

If the user doesn't say which agent, add it to `default`.

## Writing good skill bodies

A skill body's job is to make the activation decision and the execution
predictable. Three sections cover that:

- **When to use this** — what the activation signal looks like, so the
  agent's choice to load the skill is well-founded.
- **Steps** in execution order — the procedure as the agent will follow it.
- **Constraints / failure modes** — phrased as consequences ("X breaks Y
  because Z") so the agent can reason about edge cases, not just memorize
  prohibitions.

Generic advice ("be helpful", "write good code") duplicates what every
agent already knows; the skill body's leverage is project-specific or
domain-specific guidance.

## Patterns that go sideways

- Trivial one-liners as skills bloat the activation list and add latency
  to every skill search; inline instructions in the agent's prompt land
  cleaner for small, frequent operations.
- Skills that duplicate built-in tool behavior (`file_read`, `web_fetch`)
  add an indirection layer with no leverage.
- Hard-coded paths to specific user files break when the workspace moves
  or gets shared; templating paths keeps the skill portable.

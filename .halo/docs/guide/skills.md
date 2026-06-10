# Skills — User Guide

A skill is a "knowledge pack" an agent can reference — a detailed instruction set plus optional templates or scripts.

## Why skills

To extract capabilities an agent uses occasionally but needs full instructions for. For example:
- "Code Review": review code against a checklist
- "Deploy check": the pre-deploy checklist
- "Translate to academic English": a specific translation flow

Putting those in AGENT.md would bloat the system prompt. Skills use **progressive disclosure**:
1. On startup the agent only sees each skill's name + description
2. When the user triggers the skill or the agent decides it needs it, it calls `activate_skill` to load the full body

## Directory layout

```
~/.halo/global/skills/               # Global skills
  code-review/
    SKILL.md
    checklist.md
    examples/review-sample.md

<project>/.halo/skills/              # Workspace skills
  deploy-check/
    SKILL.md
    scripts/verify.sh
```

Workspace overrides global (same id).

**Built-in skills** (`agent`, `skill`, `ws`, `cron`, `acp`, `send-file`, `self`, `aws-knowledge`, `nova-web-search`) are server-shipped and **force-overwritten on every server startup**. Local edits to these directories under `~/.halo/global/skills/` will be lost. To customize one, copy it into `<project>/.halo/skills/<id>/` (workspace replaces global) and edit there. Other skills under `~/.halo/global/skills/` — including any the user created via the admin UI — are untouched by the seeder.

## SKILL.md format

```markdown
---
name: code-review
description: Review code for correctness, performance, and style
command: /review       # optional: also register a slash command
---

# Code Review

Review the code for:

1. Correctness bugs
2. Performance issues
3. Style / consistency with codebase

Follow the checklist in checklist.md...
```

**Frontmatter fields**:
| Field | Required | Purpose |
|---|---|---|
| name | yes | kebab-case, = directory name (lowercase / digits / hyphens, ≤64) |
| description | yes | One-line description (what agents see at discovery time) |
| command | no | Also register as a slash command (`/xxx` user-triggerable) — opt-in, unlike the upstream Agent Skills standard where the directory name automatically becomes a command |

**Body**: the full instructions, returned when the agent calls `activate_skill(skill_id)`.

## Open the Skills panel

Left-side Activity Bar → `🪄 Skills` icon.

Click any skill and the right pane becomes a mini workspace:
- File tree (every file in the skill directory) on the left
- Monaco editor + Markdown preview on the right

You can edit SKILL.md, add scripts, templates, example docs.

## Create / delete

`+` button on the sidebar — fill in name / description / scope.

Delete: right-click → Delete.

## Letting an agent use a skill

Edit agent.yaml:

```yaml
skills:
  - code-review
  - deploy-check
```

After Save, from the next conversation:
- The system prompt gets `<available_skills> <skill><name>...</name><id>...</id>... </skill> </available_skills>`
- The agent automatically receives the `activate_skill` tool

When the agent decides a skill fits, it calls `activate_skill(skill_id='code-review')`, receives the full SKILL.md, and follows the instructions.

## Skill-as-Command

When SKILL.md frontmatter has a `command` field, the user can slash-trigger it:

```
User: /review src/foo.ts
```

Halo renders the SKILL.md body (user args reach it via `$ARGUMENTS` / `$1`–`$9` placeholders — they are not appended to the end) and sends it as a message for the agent:

```
[Skill activated: /review]

{SKILL.md body, with $ARGUMENTS → "src/foo.ts"}
```

The agent follows the skill's instructions.

## Resource files

Files in the same directory as SKILL.md are listed at the end of `activate_skill`'s return:

```
Resource files in skill directory:
- checklist.md
- examples/review-sample.md
```

The agent uses `file_read` to load them on demand.

## Settings integration

For configurable parameters (API keys, regions, model presets), declare them in a `config.yaml` next to `SKILL.md` and reference them from the body with `{{params.x}}` (short form — auto-qualified to `{{<skill-id>.params.x}}` at activation). See [Placeholders (template variables)](#placeholders-template-variables) below.

`config.yaml` example (sits beside `SKILL.md`):

```yaml
params:
  - key: api_key
    description: API key for the Example service
    default: <<EXAMPLE_KEY>>
    secret: true
secrets: []   # rare for skills — server-side only, never substituted into shell_exec
```

The Settings page reads this declaration and renders inputs grouped under the skill's name. The user's value lands in `~/.halo/secrets/settings.yaml` at `<skill-id>.params.api_key`.

> Credentials **do not** belong directly in `settings.yaml` — use `<<ENV_NAME>>` placeholders with the real value in env vars, or type them once into the Settings page (which still encrypts in the UI but stores plaintext on disk). Don't write credentials in SKILL.md either. SKILL.md + the schema in `config.yaml` are meant to be shareable; values are the user's.

See the full credential model at [secrets-and-credentials.md](secrets-and-credentials.md).

## Built-in skills

Halo seeds these skills on every startup (the ids in `BUILTIN_SKILL_IDS`, `packages/server/src/init.ts`):

| ID | Purpose |
|---|---|
| agent | Create / update agents — backs the `create` / `update` verbs of `/agent` |
| skill | Create / update skills — backs the `create` / `update` verbs of `/skill` |
| ws | Workspace maintenance — backs `/ws setup` / `tidy` (init / reorganize `.halo/` INDEX.md / INSTRUCTIONS.md / memory/) and `/ws share` (export a shareable bundle) |
| cron | Create / list / update / enable / disable / delete scheduled agent runs — backs `/cron` |
| acp | Talk to other agents over ACP (`/acp kiro\|claude <q>`) and manage `ask-<label>` bindings for halo-to-halo delegation (`/acp add\|list\|remove`) |
| send-file | Deliver an image/video/file as a channel attachment by emitting `MEDIA:<absolute_path>` — works on Web / WeChat / Telegram / Slack / Feishu (no command; model-activated, workspace access) |
| self | The agent's own visual space (`.halo/canvas/self.html`) for self-expression (no command; model-activated, full access) |
| aws-knowledge | Query the official AWS Knowledge MCP server for up-to-date AWS docs (no command, `user-invocable: false`; model auto-activates) |
| nova-web-search | Real-time web search via Amazon Nova 2 Lite's nova_grounding (no command, `user-invocable: false`; model auto-activates) |

All live under `~/.halo/global/skills/` and are force-overwritten on startup. To customize one, copy it into `<project>/.halo/skills/<id>/` and edit there (workspace overrides global). `tavily-web-search` remains an optional (non-seeded) skill.

## SKILL.md field reference

Frontmatter fields (Halo dialect of the Agent Skills standard):

```markdown
---
name: code-review                    # required, kebab-case, = directory name
description: Review code changes     # required, one-line description (agents use this to decide when to activate)
command: /review                     # optional, register as a slash command (opt-in)
requiresAccess: workspace            # optional (Halo), object-level access gate: full | workspace | readonly
verbs:                               # optional (Halo extension), subcommand declarations
  - { name: list, builtin: true, desc: List things }
  - { name: create, requiresAccess: full, desc: Create a thing }
disable-model-invocation: true       # optional (standard), command stays but the model can't auto-activate
user-invocable: false                # optional (standard), never becomes a slash command; model can still activate
---

# Skill Body...
```

**Field notes**:

| Field | Required | Purpose |
|---|---|---|
| name | yes | kebab-case, = directory name; appears in the agent system prompt's `<available_skills>` block |
| description | yes | Helps agents decide when to activate |
| command | no | Register a slash command — see Skill-as-Command above |
| requiresAccess | no | Halo-specific access gate (`full` / `workspace` / `readonly`) for the whole skill |
| verbs | no | **Halo extension** — list of `{ name, builtin?, requiresAccess?, desc? }`. `builtin: true` marks a verb handled by platform code (declarative; actual routing lives in `SUBCOMMAND_ROUTES`); skill verbs take their access gate from this declaration. The verb reaches the body via `$1` |
| disable-model-invocation | no | Standard — `true` keeps the slash command but the skill isn't injected for the model (no auto-activation) |
| user-invocable | no | Standard — `false` means no slash command ever; the model can still activate it |

> **Disable / Enable**: managed per workspace in the `disabled_items` table of `halo.db` (not in SKILL.md). Toggle via admin sidebar or `/skill disable|enable`; disabled skills are excluded from system prompt injection, activate_skill tool, agent form picker, and `/ws share` export. Still visible in admin sidebar (dimmed + toggle switch).

**Minimal SKILL.md**: frontmatter with `name` + `description` + body; everything else is optional.

**What `activate_skill` returns**:

```
# Skill: {name}

{body}

Resource files in skill directory:
- checklist.md
- examples/review.md
...
```

**When a skill auto-injects**: whenever `agent.yaml`'s `skills` lists that skill's id. Skills not in the list are invisible to the agent (but the user can still trigger via `/command` if registered).

## Placeholders (template variables)

SKILL.md body supports `{{var}}` placeholders, rendered on activation. AGENT.md uses the same syntax.

User command-line args additionally use the **standard** syntax `$ARGUMENTS` / `$1`–`$9` (quote-aware; `\$` escapes; `$5.00` / `$12` / `$PATH` are left alone). The two systems coexist without cross-translation: `$…` carries user args, `{{…}}` carries Halo-injected values. For object commands, the verb arrives as `$1`.

### Built-ins (no dot)

| Variable | Description |
|---|---|
| `{{args}}` | User args from a slash command. Empty string when invoked via `activate_skill` |
| `{{workspace_root}}` | Current workspace absolute path |
| `{{working_dir}}` | Agent's working_dir (defaults to workspace_root) |
| `{{now}}` | ISO8601 timestamp |
| `{{user_name}}` / `{{ai_name}}` | From USER.md frontmatter |
| `{{agent_name}}` | Current agent's display name |

### Settings paths (dotted)

`{{<id>.params.<key>}}` looks up a declared param and substitutes its value. Only `params` paths are substituted — `secrets` paths and anything else (`general.*`, top-level keys) stay as literal text. The `<id>` is the namespace declared in `models/<provider>.yaml` or `skills/<skill-id>/config.yaml`.

**Short form inside SKILL.md** — drop the namespace; activation auto-qualifies it for you:

```markdown
---
name: Nano Banana Caption
---

Call API `{{params.base_url}}` with key `{{params.api_key}}`.
Max `{{params.max_files}}` files per run.
Files: {{args}}
```

If the skill id is `nano-banana`, those become `{{nano-banana.params.base_url}}` / `{{nano-banana.params.api_key}}` / `{{nano-banana.params.max_files}}` before reaching the agent.

**`<skill-dir>/config.yaml`** declares what's needed:

```yaml
params:
  - key: api_key
    description: Nano Banana API key
    default: <<NANO_BANANA_KEY>>
    secret: true
  - key: base_url
    description: API endpoint
    default: https://api.nano-banana.example
  - key: max_files
    description: Max files per review pass
    default: "10"
```

**`~/.halo/secrets/settings.yaml`** holds the values (created by the Settings UI):

```yaml
nano-banana:
  params:
    api_key: <<NANO_BANANA_KEY>>
    base_url: https://api.nano-banana.example
    max_files: 10
```

### Resolution rules

1. **Merge order**: workspace `<project>/.halo/settings.yaml` deep-merges over global `~/.halo/secrets/settings.yaml` (field-level merge, not block replacement)
2. **Env vars**: `<<ENV_NAME>>` inside a value is replaced with `process.env.ENV_NAME` at render time. **If the env var is missing, the `<<ENV_NAME>>` literal is kept** so agents can see what's unset and the user can fix it
3. **Unknown placeholders** stay as-is (e.g. `{{foo}}`, `{{nano-banana.params.missing-key}}`); the server logs a `[md-vars] Unknown placeholder "…"` warning
4. **Key charset**: `[\w-]`, hyphens allowed (e.g. `nano-banana`)

### Why put credentials in env vars

So settings.yaml can go to git or be shared:
- `<<NANO_BANANA_KEY>>` only describes "there should be a key here", it doesn't expose the value
- Deploy with `export NANO_BANANA_KEY=xxx`; the agent only sees the real value at render time
- Unset env var → the agent sees the literal `<<NANO_BANANA_KEY>>`, making it obvious what's missing

### Two activation paths

- Skill-as-command (`/review xxx`): `{{args}}` = the user's args
- `activate_skill(skill_id)` tool: `{{args}}` = empty string

Settings and env placeholders render identically either way.

### AGENT.md placeholders

AGENT.md runs through the same renderer; on session start, placeholders in the agent personality are substituted before injection. Useful for wiring API config into an agent ("You use `{{weather-skill.params.endpoint}}`"). AGENT.md must use the **fully-qualified** form (no short-form rewrite happens here — that's a skill-only convenience).

Implementation: [md-vars.ts](../../../packages/server/src/prompts/md-vars.ts) `renderMdBody` — the shared entry point for both skill and agent rendering.

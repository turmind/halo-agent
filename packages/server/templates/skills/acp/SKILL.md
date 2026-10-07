---
name: acp
description: Talk to other agents over ACP — `/acp kiro <q>` (local Kiro), `/acp claude <q>` (local Claude Code) — and manage `ask-<label>` bindings for remote halo servers. Activate when the user wants to ask another agent something or wire up an ACP connection.
command: /acp
requiresAccess: full
verbs:
  - { name: kiro,   desc: Ask the local Kiro (rest of the line is the question) }
  - { name: claude, desc: Ask the local Claude Code (rest of the line is the question) }
  - { name: add,    desc: Generate an ask-<label> binding for a remote halo }
  - { name: list,   desc: List generated ask-* binding skills }
  - { name: remove, desc: Remove a generated ask-* binding skill }
---

# acp

The requested action is **`$1`**; everything after it is the payload
(`$ARGUMENTS` minus the first token). With natural language, infer both.

## Direct ask verbs — kiro / claude

The question is the rest of the line. The helper lives in this skill's
directory under `templates/ask.py` — the workspace copy wins if it exists,
else the global one (deterministic paths, no glob needed):

- `<workspace>/.halo/skills/acp/templates/ask.py`
- `~/.halo/global/skills/acp/templates/ask.py`

Pick ASK = the first of those that exists, then run and relay the reply
(quote short answers; summarize long ones — never paste the SESSION
bookkeeping line):

```bash
# /acp kiro <question>            — local Kiro CLI
shell_exec: python3 $ASK "<question>" --kind kiro --cwd {{workspace_root}}

# /acp claude <question>          — local Claude Code
shell_exec: python3 $ASK "<question>" --kind claude --cwd {{workspace_root}}
```

Remote halo servers are reached through generated bindings (`/ask-<label>`),
not a direct verb — see add/list/remove below.

- Follow-ups on the same topic: reuse the `SESSION:` id from the previous
  call's stdout with `--session-id <id>` so the other agent keeps context.
  If it errors with unknown session, drop the id and start fresh.
- **The question text is passed verbatim** — including the OTHER agent's own
  slash commands. Verified with kiro: sending `/model` as the question lists
  its available models; `/model <full-model-id>` switches its model and saves
  it as default (fuzzy names like `claude` are rejected — full id only, e.g.
  `claude-opus-4.7`). Use this when the user asks to change the remote/local
  agent's model or invoke its built-in commands. Other kinds may support their
  own command sets the same way.
- Failure modes: `not found in PATH` → that CLI isn't installed (kiro-cli /
  claude-agent-acp / halo). Exit 124 → timed out, suggest a narrower question.
  stopReason≠end_turn on stderr → pass it along with the partial reply.

## Remote halo bindings — add / list / remove

These verbs manage the GENERATED `ask-<label>` skills (one per remote halo,
each with its own `/ask-<label>` command and settings namespace holding that
remote's host/token).

- **list** — enumerate `ask-*` skill dirs (workspace + global); report each
  label and target.
- **remove** — confirm, delete the chosen `ask-<label>` skill directory, and
  mention the leftover `ask-<label>:` block in settings.yaml can be cleaned.
- **add** — the generator flow below.

## Add — generator flow

Stamps out a new skill named `ask-<label>` that bridges this local agent to a different halo agent over the [ACP adapter](../../docs/dev/acp-adapter.md). One binding = one remote (host + port + token + workspace). Multiple bindings can coexist — each gets its own slash command (`/ask-sa-agent`, `/ask-prod`, …) and its own settings namespace.

This is the **only supported path** to set up a new ACP binding — there's no longer a generic `ask-acp-agent` skill. The split is intentional: each remote needs its own `params.token`, and skill namespaces are 1:1 with skills.

## Step 1 — collect inputs

Required from the user:

| Field | Notes |
|---|---|
| `label` | Slug — lowercase, hex/dash only (regex `^[a-z][a-z0-9-]*$`). Used for the skill id (`ask-<label>`), slash command (`/ask-<label>`), and settings namespace. Must not collide with an existing skill. Example: `sa-agent`, `prod-cluster`, `audit-ws`. |
| `host` | Remote halo server hostname / IP. |
| `port` | Remote halo server port. (halo kind only) |
| `scheme` | URL scheme to reach the remote — `http` or `https`. Default `http`; only set `https` if the remote is behind a TLS proxy. (halo kind only) |
| `workspace` | Absolute path of the remote workspace on its server. |
| `token` | Web-channel token from the remote halo's admin (Channels → Web → copy). Should be a `full` access token if you'll later want to override workspace per call. |

Optional:

| Field | Default |
|---|---|
| `label_display` | Pretty display name (e.g. "SA Agent"). Defaults to the `label` as-is. |
| `agent_id` | Remote agent profile to use. Blank = remote `default`. |

Also ask **scope**: install the skill **globally** (`~/.halo/global/skills/`, available to every workspace's agents) or **only in this workspace** (`<workspace>/.halo/skills/`). Default to "this workspace" if unsure — share-workspace and reorg are easier.

## Step 2 — validate

Before writing files:

1. **Slug**: regex `^[a-z][a-z0-9-]*$`. Reject anything else.
2. **Collision**: check whether `ask-<label>` already exists in the chosen scope. If yes, ask the user to pick a different label OR confirm overwrite.
3. **`halo` binary**: confirm `halo` is on the PATH the local agent's `shell_exec` sees (`shell_exec: which halo`; on Windows `where halo.cmd` — bare `halo` there resolves to the desktop GUI `Halo.exe`, which `ask.py` deliberately skips). If not, the binding will install but won't run — surface this and stop.

## Step 3 — stage files

The template directory is `~/.halo/global/skills/acp/templates/`. Copy + substitute placeholders. Three files per binding:

```
<scope-dir>/ask-<label>/
├── SKILL.md       (from templates/SKILL.md.tmpl)
├── config.yaml    (from templates/config.yaml.tmpl)
└── ask.py         (verbatim copy of templates/ask.py — stays unchanged)
```

Where `<scope-dir>` is:

- Global: `~/.halo/global/skills/`
- Workspace: `<current-workspace>/.halo/skills/`

### Placeholders

Both `SKILL.md.tmpl` and `config.yaml.tmpl` use `{{NAME}}` markers. Substitute these literally — they're NOT halo `{{params.X}}` template syntax (those `{{params.X}}` strings should remain in the rendered output as-is so the runtime expands them at shell_exec time).

| Placeholder | Replace with |
|---|---|
| `{{LABEL}}` | the slug (e.g. `sa-agent`) |
| `{{LABEL_DISPLAY}}` | display name (defaults to `label_display` or the label as-is) |
| `{{HOST}}` | host |
| `{{PORT}}` | port |
| `{{SCHEME}}` | scheme (`http` / `https`; default `http`) |
| `{{WORKSPACE}}` | remote workspace path |
| `{{SKILL_DIR}}` | absolute path of the new skill dir; use this in the `python3 …/ask.py` line so the cmd works regardless of cwd |

**Substitute with Python on every OS — not sed.** Git-for-Windows' sed mangles `{{LABEL}}` passed as `-e` args, and Step 4 needs Python anyway. Replace only the `{{NAME}}` keys above; the body's `$ARGUMENTS` (slash-command args) and `{{params.X}}` (shell_exec-time settings) must survive verbatim — no regex, no blanket `{{…}}` replace:

```python
import pathlib, shutil
home = pathlib.Path.home()
tpl = home / ".halo/global/skills/acp/templates"
skill_dir = home / ".halo/global/skills" / "ask-sa-agent"   # or <workspace>/.halo/skills/ask-<label>
subs = {
    "{{LABEL}}": "sa-agent",
    "{{LABEL_DISPLAY}}": "SA Agent",
    "{{HOST}}": "ec2-1-2-3-4.compute.amazonaws.com",
    "{{PORT}}": "9527",
    "{{SCHEME}}": "http",                    # or https if the remote is behind a TLS proxy
    "{{WORKSPACE}}": "/home/ubuntu/sa-agent",
    "{{SKILL_DIR}}": skill_dir.as_posix(),   # forward slashes, also on Windows
}
skill_dir.mkdir(parents=True, exist_ok=True)
for src, dst in (("SKILL.md.tmpl", "SKILL.md"), ("config.yaml.tmpl", "config.yaml")):
    text = (tpl / src).read_text(encoding="utf-8")
    for key, val in subs.items():
        text = text.replace(key, val)
    (skill_dir / dst).write_text(text, encoding="utf-8", newline="\n")
shutil.copyfile(tpl / "ask.py", skill_dir / "ask.py")   # verbatim
```

Then `chmod +x <skill-dir>/ask.py` — unix only; skip on Windows.

## Step 4 — write **all** params to settings.yaml

Halo's shell_exec `{{<id>.params.X}}` substitution reads from `settings.yaml` and does NOT fall back to `config.yaml` `default:`. Config.yaml defaults are *only* used as form placeholders in the admin Settings UI. So at install time we must write every value the helper script needs (host, port, scheme, workspace, token, label) into settings.yaml — otherwise the SKILL.md's `python3 ask.py ... --host {{params.host}}` will pass through as a literal `{{...}}` to shell_exec and break.

Choose the file by scope:

- **Workspace scope**: `<workspace>/.halo/settings.yaml`
- **Global scope**: `~/.halo/secrets/settings.yaml`

Merge into the file (don't overwrite — there may be other namespaces already there):

```yaml
ask-<label>:
  params:
    host: <host>
    port: "<port>"             # quote so YAML keeps it as a string
    scheme: "<scheme>"         # http (default) or https
    workspace: <workspace>
    label: <label_display>
    token: <token>
    # agent_id intentionally omitted (default empty); ask.py drops blank flags
```

Use Python for the merge — yaml-aware, won't trash existing keys:

```python
import yaml, pathlib
p = pathlib.Path("<settings-path>")
data = yaml.safe_load(p.read_text()) if p.exists() else {}
if not isinstance(data, dict):
    data = {}
ns = data.setdefault("ask-<label>", {})
params = ns.setdefault("params", {})
params["host"] = "<host>"
params["port"] = "<port>"
params["scheme"] = "<scheme>"
params["workspace"] = "<workspace>"
params["label"] = "<label_display>"
params["token"] = "<token>"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
```

## Step 5 — wire into the agent that should use it

The new skill exists but no agent will activate it until it's listed in an agent's `skills:` array. Target the agent the user is talking to right now. Its definition is `<workspace>/.halo/agents/<id>/` when that folder exists (it replaces the global one wholesale), else `~/.halo/global/agents/<id>/`.

- **Workspace folder exists, or a user-created global agent**: edit its `agent.yaml` directly. Insert one `  - ask-<label>` line under `skills:` as a text edit (`file_edit`, matching the list's indentation; append a `skills:` block if there is none). Don't load + `yaml.safe_dump` the file back — that drops its comments.
- **Built-in global agent** (`default`, `executor`, `deep-executor`, `goal`, or the internal `__evo_agent__` / `__score__` / `__apply_agent__`) with no workspace folder: **don't edit `~/.halo/global/agents/<id>/agent.yaml`**. Halo re-seeds built-in agents from its bundled templates on startup (every desktop launch; server / CLI after an upgrade), keeping only `model:` and `context:`, so an added skill silently vanishes and the file's comments go with it. Ask the user which they want:
  - **(a) Workspace copy**: copy the whole `~/.halo/global/agents/<id>/` folder (agent.yaml, AGENT.md, anything else in it) to `<workspace>/.halo/agents/<id>/`, then add `ask-<label>` to the copy's `skills:` as above. Tell the user the copy now replaces the global agent in this workspace, so future upgrades of the built-in agent won't reach it until they delete or re-sync the copy.
  - **(b) Leave it to them**: surface the agent path and the line to add (`- ask-<label>` under `skills:`).

## Step 6 — confirm

Reply with:

- The four paths created (SKILL.md, config.yaml, ask.py, settings.yaml entry).
- The new slash command (`/ask-<label>`) the user can now type.
- Which agent now lists `ask-<label>` (and its yaml path) — or, for a built-in agent, the option the user picked; with (a), repeat that the workspace copy won't pick up upgrades of the global agent.
- A reminder that admin Settings → Skills → ask-<label> will show the form with the token already filled.
- One example invocation:

> All set! Two ways to use it:
>
> - Type the slash command directly: `/ask-{{label}} What was our EC2 spend this month?`
> - Or just mention the remote in chat: "ask {{label_display}} for this month's EC2 spend"
>
> The token is stored at {{settings_path}}; you can edit it in Admin → Settings → Skills → ask-{{label}}.

## Patterns that go sideways

- **Picking a label that contains uppercase / underscores** — file system ok, but `command: /ask-<label>` slash command names are case-sensitive and ugly. Stick to lowercase + dashes.
- **Forgetting to wire the agent** — the binding installs cleanly but the agent never sees it (silently absent). Always do step 5 or be explicit about why you skipped.
- **Adding the skill to a built-in agent's global yaml** (`~/.halo/global/agents/default/agent.yaml` etc.) — works until the next startup re-seed wipes it. Use step 5's workspace copy, or let the user decide.
- **Substituting with sed or a blanket `{{…}}` regex** — Git-for-Windows sed mangles `{{LABEL}}`; a blanket replace also eats `{{params.X}}` / `$ARGUMENTS`. Use step 3's Python key-by-key replace.
- **Putting the token into config.yaml `default:`** — config.yaml is committed code; settings.yaml is per-install secrets. Don't cross the streams.
- **Reusing the same `label` for two different remotes** — Settings namespace collision. Detect at step 2.

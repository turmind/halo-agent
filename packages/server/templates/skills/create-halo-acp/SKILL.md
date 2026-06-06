---
name: Create Halo ACP Binding
description: Generate a new halo-to-halo ACP bridge skill. The user gives connection details (label, host, port, token, workspace) for a remote halo agent; this command stamps out a fresh `ask-<label>` skill that the local agent can call to relay questions to that remote. Activate when the user says "add an ACP binding", "let me talk to <other halo>", "set up halo-to-halo", "create an ACP connection", or asks to wire a new remote halo workspace.
command: /create-halo-acp
---

# Create Halo ACP Binding

Stamps out a new skill named `ask-<label>` that bridges this local agent to a different halo agent over the [ACP adapter](../../docs/dev/acp-adapter.md). One binding = one remote (host + port + token + workspace). Multiple bindings can coexist — each gets its own slash command (`/ask-sa-agent`, `/ask-prod`, …) and its own settings namespace.

This is the **only supported path** to set up a new ACP binding — there's no longer a generic `ask-acp-agent` skill. The split is intentional: each remote needs its own `params.token`, and skill namespaces are 1:1 with skills.

## Step 1 — collect inputs

Required from the user:

| Field | Notes |
|---|---|
| `label` | Slug — lowercase, hex/dash only (regex `^[a-z][a-z0-9-]*$`). Used for the skill id (`ask-<label>`), slash command (`/ask-<label>`), and settings namespace. Must not collide with an existing skill. Example: `sa-agent`, `prod-cluster`, `audit-ws`. |
| `host` | Remote halo server hostname / IP. |
| `port` | Remote halo server port. |
| `workspace` | Absolute path of the remote workspace on its server. |
| `token` | Web-channel token from the remote halo's admin (Channels → Web → copy). Should be a `full` access token if you'll later want to override workspace per call. |

Optional:

| Field | Default |
|---|---|
| `label_display` | Pretty display name (e.g. "SA Agent"). Defaults to `label` capitalized. |
| `agent_id` | Remote agent profile to use. Blank = remote `default`. |

Also ask **scope**: install the skill **globally** (`~/.halo/global/skills/`, available to every workspace's agents) or **only in this workspace** (`<workspace>/.halo/skills/`). Default to "this workspace" if unsure — share-workspace and reorg are easier.

## Step 2 — validate

Before writing files:

1. **Slug**: regex `^[a-z][a-z0-9-]*$`. Reject anything else.
2. **Collision**: check whether `ask-<label>` already exists in the chosen scope. If yes, ask the user to pick a different label OR confirm overwrite.
3. **`halo` binary**: confirm `halo` is on the PATH the local agent's `shell_exec` sees (`shell_exec: which halo`). If not, the binding will install but won't run — surface this and stop.

## Step 3 — stage files

The template directory is `~/.halo/global/skills/create-halo-acp/templates/`. Copy + substitute placeholders. Three files per binding:

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
| `{{LABEL_DISPLAY}}` | display name (defaults to `label_display` or capitalized label) |
| `{{HOST}}` | host |
| `{{PORT}}` | port |
| `{{WORKSPACE}}` | remote workspace path |
| `{{SKILL_DIR}}` | absolute path of the new skill dir; use this in the `python3 …/ask.py` line so the cmd works regardless of cwd |

Implementation hint — small Python / shell pipeline works fine:

```bash
LABEL=sa-agent
LABEL_DISPLAY="SA Agent"
HOST=ec2-1-2-3-4.compute.amazonaws.com
PORT=9527
WORKSPACE=/home/ubuntu/sa-agent
SCOPE_DIR=$HOME/.halo/global/skills           # or the workspace's .halo/skills
SKILL_DIR=$SCOPE_DIR/ask-$LABEL
TPL=$HOME/.halo/global/skills/create-halo-acp/templates

mkdir -p "$SKILL_DIR"
sed -e "s|{{LABEL}}|$LABEL|g" \
    -e "s|{{LABEL_DISPLAY}}|$LABEL_DISPLAY|g" \
    -e "s|{{HOST}}|$HOST|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{WORKSPACE}}|$WORKSPACE|g" \
    -e "s|{{SKILL_DIR}}|$SKILL_DIR|g" \
    "$TPL/SKILL.md.tmpl" > "$SKILL_DIR/SKILL.md"
sed -e "s|{{LABEL}}|$LABEL|g" \
    -e "s|{{LABEL_DISPLAY}}|$LABEL_DISPLAY|g" \
    -e "s|{{HOST}}|$HOST|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{WORKSPACE}}|$WORKSPACE|g" \
    "$TPL/config.yaml.tmpl" > "$SKILL_DIR/config.yaml"
cp "$TPL/ask.py" "$SKILL_DIR/ask.py"
chmod +x "$SKILL_DIR/ask.py"
```

If any path contains `|` (rare), pick a different sed delimiter or use Python.

## Step 4 — write **all** params to settings.yaml

Halo's shell_exec `{{<id>.params.X}}` substitution reads from `settings.yaml` and does NOT fall back to `config.yaml` `default:`. Config.yaml defaults are *only* used as form placeholders in the admin Settings UI. So at install time we must write every value the helper script needs (host, port, workspace, token, label) into settings.yaml — otherwise the SKILL.md's `python3 ask.py ... --host {{params.host}}` will pass through as a literal `{{...}}` to shell_exec and break.

Choose the file by scope:

- **Workspace scope**: `<workspace>/.halo/settings.yaml`
- **Global scope**: `~/.halo/secrets/settings.yaml`

Merge into the file (don't overwrite — there may be other namespaces already there):

```yaml
ask-<label>:
  params:
    host: <host>
    port: "<port>"             # quote so YAML keeps it as a string
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
params["workspace"] = "<workspace>"
params["label"] = "<label_display>"
params["token"] = "<token>"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
```

## Step 5 — wire into the agent that should use it

The new skill exists but no agent will activate it until it's listed in an agent's `skills:` array. Two paths:

- **The current workspace's `default` agent**: read `<workspace>/.halo/agents/default/agent.yaml` (or whichever agent the user is talking to right now), add `ask-<label>` to its `skills:` list, write back.
- **Skip and let the user do it**: surface the path + tell them.

Default behavior: edit the **current agent's** yaml automatically; if the agent has no workspace-local yaml (i.e. it inherits a global agent), tell the user "add `ask-<label>` to your agent's skills list to enable" and surface the path.

## Step 6 — confirm

Reply with:

- The four paths created (SKILL.md, config.yaml, ask.py, settings.yaml entry).
- The new slash command (`/ask-<label>`) the user can now type.
- A reminder that admin Settings → Skills → Ask <Label_Display> will show the form with the token already filled.
- One example invocation:

> All set! Two ways to use it:
>
> - Type the slash command directly: `/ask-{{label}} What was our EC2 spend this month?`
> - Or just mention the remote in chat: "ask {{label_display}} for this month's EC2 spend"
>
> The token is stored at {{settings_path}}; you can edit it in Admin → Settings → Skills → Ask {{label_display}}.

## Patterns that go sideways

- **Picking a label that contains uppercase / underscores** — file system ok, but `command: /ask-<label>` slash command names are case-sensitive and ugly. Stick to lowercase + dashes.
- **Forgetting to wire the agent** — the binding installs cleanly but the agent never sees it (silently absent). Always do step 5 or be explicit about why you skipped.
- **Putting the token into config.yaml `default:`** — config.yaml is committed code; settings.yaml is per-install secrets. Don't cross the streams.
- **Reusing the same `label` for two different remotes** — Settings namespace collision. Detect at step 2.

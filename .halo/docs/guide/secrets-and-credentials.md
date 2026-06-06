# Secrets and Credentials

How to give a skill or agent an API key / token / password without committing it to a repo or hard-coding it in a skill body.

## The model: schema vs. value

Halo's settings system mirrors VSCode's `contributes.configuration` pattern:

| Side | What lives there | Where |
|---|---|---|
| **Schema** (declaration) | "This provider/skill needs a key called X, here's its description, and here's whether it's a secret" | Inside the package: `models/<provider-id>.yaml` `secrets:` section · `skills/<skill-id>/config.yaml` `params:` / `secrets:` sections |
| **Value** | The user's actual key | `~/.halo/secrets/settings.yaml` (global) or `<workspace>/.halo/settings.yaml` (workspace overlay) |

Removing or disabling a package only takes its **schema** out of the registry; values stay in `settings.yaml` and re-attach automatically if the same id comes back. The Settings page surfaces leftover values in an "Unclaimed" list so the user can prune them on their own schedule.

## Two kinds of declared fields

| Kind | Reachable from agent? | Storage path | Render |
|---|---|---|---|
| **`secrets`** | Never. Server-side only — model providers, OAuth app credentials, signing keys. | `<id>.secrets.<key>` | UI masks the value; the placeholder renderer rejects `{{<id>.secrets.…}}` so nothing leaks into prompts. |
| **`params`** | Yes, via `{{<id>.params.<key>}}`. Use this for keys a skill needs to inject into its own `shell_exec` (e.g. Tavily search). | `<id>.params.<key>` | Substituted at `shell_exec` time inside the skill's command. |

The boundary is enforced by:
- [packages/server/src/prompts/md-vars.ts](../../../packages/server/src/prompts/md-vars.ts) — `renderMdBody` only replaces `{{<id>.params.<key>}}`; anything else stays literal.
- [packages/server/src/tools/workspace-tools.ts](../../../packages/server/src/tools/workspace-tools.ts) — `substituteSecrets` does the same on every `shell_exec` call.

A malicious agent that tries `curl -H "Bearer {{aws-bedrock-claude-invoke.secrets.secret_access_key}}"` gets the literal placeholder, not the value.

## Worked example: a skill that needs an API key

Goal: a skill called `caption-image` that calls `api.example.com` with an API key.

### Step 1 — declare in the skill's `config.yaml`

Beside `SKILL.md`:

```yaml
# extensions/skills/caption-image/config.yaml
params:
  - key: api_key
    description: API key for api.example.com
    description_zh: api.example.com 的 API Key
    default: <<EXAMPLE_KEY>>      # placeholder shown in UI when value is unset
    secret: true                  # UI masks the input + API response
  - key: base_url
    description: Endpoint base URL
    default: https://api.example.com
```

The schema is what the package ships. The Settings page reads it and renders inputs.

### Step 2 — set the value

Two options:

- **From the Settings page** — open the `caption-image` section, type the key, save. The value is written to `~/.halo/secrets/settings.yaml` at `caption-image.params.api_key`.
- **Via env var** — leave the value as `<<EXAMPLE_KEY>>` (the default) and `export EXAMPLE_KEY=...` on the host. Both work; env vars are friendlier for ops automation, settings are friendlier for one-off keys.

In either case the rendered value travels through the normal `<<ENV_NAME>>` → `process.env.ENV_NAME` resolution.

### Step 3 — reference from `SKILL.md`

Inside the skill's body you can write the **short form** — Halo auto-qualifies it with the skill id when `activate_skill` fires:

```markdown
---
name: Caption Image
description: Generate a caption for an image using the Example API
---

# Caption Image

Call the endpoint `{{params.base_url}}/caption`:

- Method: POST
- Header: `Authorization: Bearer {{params.api_key}}`
```

Behind the scenes the activation rewrites `{{params.base_url}}` → `{{caption-image.params.base_url}}` before the body is shown to the agent. By the time `shell_exec` runs the curl, `workspace-tools` substitutes the real value.

You can also write the long form `{{caption-image.params.api_key}}` directly if you prefer it explicit (e.g. when one skill references another's params).

## Workspace overlay

`<workspace>/.halo/settings.yaml` deep-merges on top of the global file, key by key. So a project-specific Tavily key would live at:

```yaml
# /home/me/myproject/.halo/settings.yaml
tavily-search:
  params:
    api_key: tvly-project-specific-…
```

…and overrides whatever sits at `tavily-search.params.api_key` in `~/.halo/secrets/settings.yaml`. The Settings UI shows source badges (`workspace` / `inherited from global` / `unset`) and an explicit Reset button to drop a workspace override.

## Precedence

```
env vars (process.env.X) > workspace settings.yaml > global settings.yaml > schema default
```

`<<ENV_NAME>>` substitution happens **at render time** — right before the skill/agent body is handed to the LLM, and at `shell_exec` time inside values that came from a `{{<id>.params.<key>}}` lookup.

**Trust boundary**: `<<ENV>>` is only honored inside settings-resolved values. Cmd text the agent writes directly is not scanned — `shell_exec "echo <<HOME>>"` keeps the literal. This prevents an agent from naming an env var and forcing the server to dump it.

## Missing env var

If `process.env.EXAMPLE_KEY` is unset and the value at `caption-image.params.api_key` is `<<EXAMPLE_KEY>>`:
- The agent sees the literal `<<EXAMPLE_KEY>>` in the rendered skill body
- The server logs `[md-vars] Env var "EXAMPLE_KEY" not set — keeping <<EXAMPLE_KEY>> literal`
- API calls the agent makes will fail with a clear error (usually HTTP 401) and the error message will reveal the literal, so the user can tell what to fix

This is intentional: empty strings hide the misconfiguration; literals make it visible.

## Placeholder rules

In an MD body, `{{xxx}}` is resolved as:

1. **No dots** → built-in (`args`, `workspace_root`, `working_dir`, `now`, `user_name`, `ai_name`, `agent_name`)
2. **Matches `<id>.params.<key>`** → settings tree lookup, then `<<ENV>>` expansion
3. **Anything else** → kept literal + warning logged

| In MD body | Result |
|---|---|
| `{{caption-image.params.api_key}}` | Replaced with the value (after `<<ENV>>` resolution) |
| `{{params.api_key}}` inside a SKILL.md | Auto-rewritten to `{{<this-skill-id>.params.api_key}}` at `activate_skill` time |
| `{{aws-bedrock-claude-invoke.secrets.access_key_id}}` | Kept as literal — the renderer hard-rejects `secrets.*` paths |
| `{{general.compact.keep_messages}}` | Same — kept literal |
| `{{args}}`, `{{workspace_root}}`, etc. | Built-ins, replaced |

This whitelist is the single defence preventing prompt-injection-style theft of server-side secrets via skill content.

## What NOT to do

| Anti-pattern | Why it's bad | Right fix |
|---|---|---|
| Paste the key directly into `SKILL.md` | The SKILL is usually git-tracked or shared; the key leaks | Use `{{params.api_key}}` |
| Paste the key into `settings.yaml` and commit it | The file holds real secrets | Set the value to `<<KEY>>` + `export KEY=...` |
| Store the key in `AGENT.md` | Same reason | Use a `params:` declaration on the agent or a skill it depends on |
| Put a model-provider key under a skill's `params:` | Any agent could borrow it via `shell_exec` | Declare it as `secrets:` in the model provider yaml |
| Reference `{{<id>.secrets.x}}` from a skill body | Hard-rejected — kept as literal | If a skill genuinely needs server-side credentials, that's a sign it should be a server tool, not a `shell_exec` skill |

## Rotating a credential

1. Generate the new value
2. Either edit it in the Settings page (writes `settings.yaml` immediately), or update the env var and restart the server
3. Existing running sessions keep the old value baked into already-rendered SKILL bodies of previous `activate_skill` calls. They pick up the new value on the next activation.

No code change. No yaml schema change.

## Env var naming conventions

Free-form, but consistency helps. Common patterns in Halo:

| Env var | Purpose |
|---|---|
| `HALO_PASSWORD` | Server login password |
| `HALO_MODEL_ID` / `HALO_MODEL_PROVIDER` / `HALO_MAX_CONTEXT_TOKENS` | Server defaults |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS / Bedrock |

For your own skills, `UPPER_SNAKE` prefixed by the product is idiomatic (`NANO_BANANA_KEY`, `EXAMPLE_API_TOKEN`). The placeholder is case-sensitive — `<<example_key>>` won't match `EXAMPLE_KEY`.

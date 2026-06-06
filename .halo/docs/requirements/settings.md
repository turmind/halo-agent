# Settings — Requirements

Global + workspace configuration. The shape mirrors VSCode's `contributes.configuration` model: **schema** (declared by each package — provider yaml, skill yaml, server built-ins) is separate from **values** (stored in the user's `settings.yaml`).

## Storage layout

```yaml
# ~/.halo/secrets/settings.yaml — values only
general:                                  # built-in declarer (server itself)
  session:
    max_queue_size: 3
    max_nesting_depth: 16
  compact:
    keep_messages: 5
    max_summary_input: 15000
    ...
  sandbox:
    hidden_dirs: "~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker"
    hidden_files: "~/.npmrc,~/.bash_history,~/.gitconfig"
  logging:
    level: warn

aws-bedrock-claude-invoke:                # provider id from models/<id>.yaml
  secrets:
    access_key_id: ""
    secret_access_key: ""

kimi:
  secrets:
    api_key: <<KIMI_API_KEY>>

deepseek:
  secrets:
    api_key: <<DEEPSEEK_API_KEY>>

tavily-search:                            # skill id from skills/<id>/config.yaml
  params:
    api_key: <<TAVILY_API_KEY>>
```

The path always reads as `<namespace-id>.<kind>s.<key>`:
- `<namespace-id>` is `general`, a provider id, or a skill id
- `<kind>` is `param` or `secret`
- `<key>` is the leaf, dotted for grouping (e.g. `general.compact.keep_messages`)

`general` is the only namespace that doesn't follow the `<id>.{params|secrets}.<key>` pattern — its declared keys are flat (`general.<key>`) since the server is the implicit declarer.

## Two kinds of fields

| Kind | Reachable from agent? | UI render |
|---|---|---|
| **`params`** | Yes — via `{{<id>.params.<key>}}` placeholders. Substituted at `shell_exec` time. | Plain text / number input. |
| **`secrets`** | Never. Server-side only (model providers, signing keys). The placeholder renderer rejects `{{<id>.secrets.…}}`; the API returns masked values to the browser. | Masked password input; `<<ENV>>` references shown plainly (they're not the real value). |

## Schema declaration

Schema lives **inside the package**, alongside its other files:

### Provider secrets — `models/<provider-id>.yaml`

```yaml
id: aws-bedrock-claude-invoke
displayName: AWS Bedrock Claude (Invoke API)
defaultEndpoint: https://bedrock-runtime.us-west-2.amazonaws.com

secrets:
  - key: access_key_id
    description: AWS Access Key ID
    description_zh: AWS Access Key ID
    secret: true
  - key: secret_access_key
    description: AWS Secret Access Key
    description_zh: AWS Secret Access Key
    secret: true

models: [...]
```

### Skill params/secrets — `skills/<skill-id>/config.yaml`

```yaml
params:
  - key: api_key
    description: Tavily API Key
    description_zh: Tavily 搜索 API Key
    default: <<TAVILY_API_KEY>>
    secret: true
secrets: []
```

### General — built-in

Declared in [packages/server/src/settings-schema.ts](../../../packages/server/src/settings-schema.ts) `generalSection()`. The server itself is the implicit declarer. Keys: `language`, `agent.*`, `session.*`, `compact.*`, `sandbox.*`, `logging.*`, `evolution.*`.

`evolution.*` controls the self-evolution subsystem (see [plans/self-evolution.md](../plans/self-evolution.md)). All `evolution.*` keys are `globalOnly` — they live in `~/.halo/secrets/settings.yaml` only, not workspace settings. Notable knobs: `evolution.level` (`L0` = off, `L1` = human + LLM assist), `evolution.max_concurrent_run` / `max_concurrent_apply` (wrapper concurrency caps), `evolution.run_timeout_minutes` / `apply_timeout_minutes` (heartbeat timeouts), `evolution.max_attempts` (per-row retry cap), `evolution.triggers.pre_compact` (snapshot session before compaction).

`agent.default_provider` is rendered as an `enum` whose options are the provider ids found under `~/.halo/global/models/*.yaml`. It controls **which provider a freshly scaffolded agent.yaml uses** — the model id, endpoint, prompt-caching TTL and thinking defaults are then derived from that provider's YAML (`defaultModelId`, `defaultEndpoint`, per-model `capabilities.promptCaching.default`, `capabilities.thinking.defaultEnabled / default / defaultBudgetTokens`). Existing agents are not retroactively touched. Implementation: [packages/server/src/routes/agent-configs.ts](../../../packages/server/src/routes/agent-configs.ts) `buildScaffoldModelBlock()`.

### Field attributes

| Attribute | Required | Purpose |
|---|---|---|
| `key` | yes | Leaf key under the namespace |
| `description` | no | English description rendered as help text |
| `description_zh` | no | Chinese description (UI picks based on lang) |
| `default` | no | Placeholder shown when the value is unset; supports `<<ENV>>` |
| `secret` | no | `true` → masked in API responses + password input in UI |

## Scope: global vs. workspace

| Scope | File | Priority |
|---|---|---|
| Global | `~/.halo/secrets/settings.yaml` | Base |
| Workspace | `<project>/.halo/settings.yaml` | Overrides global, key by key |

Read order: `<schema default> <- <global> <- <workspace>`.

The Settings page shows source badges per field:
- `workspace` (green-blue, override applied here)
- `inherited from global` (grey, value pulled from global because workspace has none)
- `unset` (no value at any layer; the `default` is shown as placeholder)

A Reset button on each field removes the value at the current scope, letting it fall back to the lower scope (or unset).

## Environment variable injection

Values can carry `<<ENV_NAME>>` placeholders. They're expanded:
- At `shell_exec` time inside values resolved through `{{<id>.params.<key>}}` — see [workspace-tools.ts](../../../packages/server/src/tools/workspace-tools.ts) `substituteSecrets`.
- At read time when server-side code calls `getServerSecret(namespaceId, key)` — see [config.ts](../../../packages/server/src/config.ts).

**Trust boundary**: `<<ENV>>` is only expanded inside settings-resolved values. Raw cmd text the agent writes is not scanned — `shell_exec "echo <<HOME>>"` keeps the literal. This prevents an agent from naming an env var and forcing the server to dump it.

Env var unset → the `<<ENV_NAME>>` literal stays verbatim, plus `[md-vars] Env var "X" not set — keeping <<X>> literal` in the server log. The Settings UI returns the literal too — the browser never sees the real env value.

## Agent visibility

Placeholder syntax in MD bodies (SKILL.md / AGENT.md):

| In MD body | Result |
|---|---|
| `{{<skill-id>.params.<key>}}` (long form) | Replaced with the value (after `<<ENV>>` resolution) at `shell_exec` time |
| `{{params.<key>}}` (short form) inside a SKILL.md | Auto-rewritten to `{{<this-skill-id>.params.<key>}}` at `activate_skill` |
| `{{<id>.secrets.<key>}}` | Hard-rejected — kept as literal, server logs a whitelist warning |
| `{{general.compact.keep_messages}}` | Same — kept literal |
| `{{args}}`, `{{workspace_root}}`, etc. | Built-ins, replaced at render time |

Enforced in two places:
- [md-vars.ts](../../../packages/server/src/prompts/md-vars.ts) `renderMdBody` — only matches `^[\w-]+\.params\.[\w-][\w.-]*$`.
- [workspace-tools.ts](../../../packages/server/src/tools/workspace-tools.ts) `substituteSecrets` — same regex on `{{}}` placeholders.

A malicious skill that tries `curl -H "Bearer {{aws-bedrock-claude-invoke.secrets.secret_access_key}}"` gets the literal placeholder, not the value.

## Orphans

Values present in `settings.yaml` whose namespace doesn't appear in any current schema declaration are surfaced as **orphans** in a dedicated tab. They aren't deleted automatically — uninstalling a skill keeps its values around so re-installing pops them back in. Users prune them on their own schedule via the orphan tab's per-key Remove buttons.

`general.*` is intentionally excluded from orphan detection — its declared keys are enumerated by the built-in schema, so anything else there is treated as either a typo or a forward-compat field, not an orphan.

## API

| Operation | Method | Endpoint | Purpose |
|---|---|---|---|
| Read merged settings (legacy) | GET | `/api/settings?projectId=xxx` | Raw read, used by older tooling |
| Read schema + resolved values | GET | `/api/settings/schema?projectId=xxx` | Drives the new Settings page |
| Replace scope | PUT | `/api/settings` | Bulk replace one yaml file |
| Patch single key | PATCH | `/api/settings` | Set a leaf at `<dotted-key>` |
| Delete key | DELETE | `/api/settings` | Remove a leaf (used for Reset / Remove orphan) |

### `/api/settings/schema` response

```json
{
  "scope": "global" | "workspace",
  "sections": [
    {
      "namespaceId": "aws-bedrock-claude-invoke",
      "source": "provider",
      "displayName": "AWS Bedrock Claude (Invoke API)",
      "description": "...",
      "fields": [
        {
          "key": "access_key_id",
          "kind": "secret",
          "description": "AWS Access Key ID",
          "description_zh": "...",
          "default": null,
          "secret": true,
          "value": "AK****ST",
          "hasValue": true,
          "source": "global",
          "inheritedFromGlobal": false
        }
      ]
    }
  ],
  "orphans": [
    { "namespaceId": "tavily", "kind": "param", "key": "api_key" }
  ]
}
```

### PATCH body

```json
{
  "scope": "global" | "workspace",
  "projectId": "...",            // required if scope=workspace
  "key": "aws-bedrock-claude-invoke.secrets.access_key_id",
  "value": "AKIA…"
}
```

### DELETE body

Same shape minus `value`. Removes the leaf at `key`. For Reset behaviour: workspace scope DELETE → field falls back to global / default; global scope DELETE → field becomes unset.

## i18n

The admin UI is bilingual (en/zh). Field descriptions are localized via `description_zh` with fallback to `description`. Fixed UI labels live in `packages/admin/src/shared/i18n/`.

## Config caching

`config.ts` reads `settings.yaml` lazily with mtime-watching: every read stats the file and reparses if the mtime has changed. UI saves bump the mtime, so the server picks up new secrets on the next call without a restart. See [packages/server/src/config.ts](../../../packages/server/src/config.ts) `getSettings()`.

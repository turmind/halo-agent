# Settings — Requirements

Global + workspace configuration. The shape mirrors VSCode's `contributes.configuration` model: **schema** (declared by each package — provider yaml, skill yaml, server built-ins) is separate from **values** (stored in the user's `settings.yaml`).

## Storage layout

```yaml
# ~/.halo/secrets/settings.yaml — values only
general:                                  # built-in declarer (server itself)
  server:
    trust_proxy: false                    # true only behind a reverse proxy you control — see below
  session:
    max_queue_size: 256
    max_nesting_depth: 16
  compact:
    keep_messages: 5
    max_summary_input: 15000
    ...
  sandbox:
    hidden_dirs: "~/.kube"                # extras — appended to the built-in list, never replace it
    hidden_files: "~/.pgpass"             # extras — appended to the built-in list, never replace it
    writable_dirs: ""                     # e.g. ~/.kiro,~/.local/share/kiro-cli — rw bind-mounts in bwrap; ignored for readonly sessions
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

tavily-web-search:                        # skill id from skills/<id>/config.yaml
  params:
    api_key: <<TAVILY_API_KEY>>
```

The path always reads as `<namespace-id>.<kind>s.<key>`:
- `<namespace-id>` is `general`, a provider id, a skill id, or an agent id
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

Built-in skills declare theirs the same way — today `extension`, with a plain `hub_repo` param (the hub `/extension install <id>` pulls from; empty = turmind/halo-hub), and `web-search`, with plain `fast_region` / `deep_region` params (AWS regions for its two Bedrock gears; empty = us-east-1 fast, us-west-2 deep / us-east-1 for sol). `halo setup` asks only for built-in skills' `secret: true` params; plain params are configured in Settings → Skills only.

Global agents declare theirs the same way in `agents/<agent-id>/agent-config.yaml` (same `params:` / `secrets:` lists; shown under Settings → Agents).

### General — built-in

Declared in [packages/server/src/settings-schema.ts](../../../packages/server/src/settings-schema.ts) `generalSection()`. The server itself is the implicit declarer. Keys: `language`, `theme`, `agent.max_retries`, `server.*`, `session.*`, `compact.*`, `sandbox.*`, `logging.*`, `observability.*` (read once at boot — restart to apply), `evolution.*`, `limits.*`. All `general.*` keys are `globalOnly`: `config.ts` resolves them through `settingsValue()` against `~/.halo/secrets/settings.yaml` only, so a workspace `settings.yaml` cannot override them. Per-workspace layering applies to namespaced `params` / `secrets` (`getServerSecret(ns, key, workspaceRoot)`, `substituteSecrets`).

`server.trust_proxy` (boolean, default `false`, `globalOnly`): whether the brute-force rate limiter (`middleware/brute-force.ts` `getClientIp`) trusts the `x-forwarded-for` header for client IP resolution. Direct-connect deployments leave it `false` and get the socket address. Behind a reverse proxy (nginx / Cloudflare / etc.), set it to `true` so the real client IP is honored instead of the proxy's — but only when that proxy is one you control and rewrites the header itself, otherwise a client can forge XFF to dodge lockouts.

`sandbox.hidden_dirs` / `sandbox.hidden_files` / `sandbox.writable_dirs` are `globalOnly` — they define the security boundary agents run inside, so a workspace `settings.yaml` cannot override them (a workspace overriding them could lift its own sandbox constraints). `hidden_dirs` / `hidden_files` hold **extra** entries: the effective list is the built-in default (`DEFAULT_HIDDEN_DIRS` / `DEFAULT_HIDDEN_FILES` in `tools/sandbox.ts`, the single source — `~/.halo/secrets`, `~/.aws`, `~/.ssh`, `~/.gnupg`, `~/.docker`, `~/.config/gh`, `~/.halo/global/internal-sessions`, `~/.halo/global/logs`; `~/.npmrc`, `~/.bash_history`, `~/.gitconfig`, `~/.git-credentials`, `~/.netrc`, the global `evo` / `cron` / `runs` databases + `-wal` / `-shm`) plus the user's entries, deduped (`config.ts` `resolveSandboxPaths()`, used by both the server and the CLI). A default entry cannot be removed from the list in settings. The lists apply only to workspace / readonly sessions (bwrap / Seatbelt, or `assertPathAllowed` without an OS sandbox); Full sessions, the admin file explorer (`validatePath`, workspace-bound only) and the terminal never consult them. The schema `default` is empty so the placeholder doesn't suggest copying the built-ins; the field description names them. `writable_dirs` is a plain list (no built-ins).

`evolution.*` controls the self-evolution subsystem (see [design/evolution.md](../design/evolution.md)). All `evolution.*` keys are `globalOnly` — they live in `~/.halo/secrets/settings.yaml` only, not workspace settings. Notable knobs: `evolution.level` (`L0` = manual only: `/evo` drafts, a reviewer approves; `L1` = L0 plus automatic drafting on pre-compact), `evolution.max_concurrent_run` / `max_concurrent_apply` (wrapper concurrency caps), `evolution.run_timeout_minutes` / `apply_timeout_minutes` (heartbeat timeouts), `evolution.max_attempts` (per-row retry cap), `evolution.triggers.pre_compact` (snapshot session before compaction).

Goal mode's entry points are offline (the `/goal` command, admin banner and creation of new goal sessions are hidden). To reopen them, set `general.goal_mode_enabled` — a global-only boolean, default `false`, read from `~/.halo/secrets/settings.yaml` only (a workspace `settings.yaml` has no effect) and not shown in the Settings UI — then restart the Halo server and refresh the browser (existing goal bindings and history are not touched either way):

```yaml
general:
  goal_mode_enabled: true
```

The value is read once at process start, so unlike other settings it is **not** picked up by the mtime-watching reload.

There is no "default provider" setting: a newly created agent's `model:` is a copy of the **default agent's** `model:` mapping — for workspace scope `<project>/.halo/agents/default/agent.yaml` when it exists, else the global `~/.halo/global/agents/default/agent.yaml`; for global scope the global one. When that file is missing or has no `model` mapping, the scaffold falls back to the provider registry (`aws-bedrock-claude-invoke` if installed, else the first provider on disk), deriving model id / endpoint / prompt caching / thinking from that provider's YAML. Only `model` is copied; `context` stays the scaffold default. Existing agents are not retroactively touched. A leftover `general.agent.default_provider` in `settings.yaml` is ignored. Implementation: [packages/server/src/routes/agent-configs.ts](../../../packages/server/src/routes/agent-configs.ts) `scaffoldModelBlock()`.

**Advanced fold**: on the General page, `language` and `theme` are shown in the open; every other General field is in an "Advanced" area, collapsed by default (schema flag `advanced: true`, set in `generalSection()`).

**Restart-required fields**: `agent.max_retries`, `session.max_queue_size`, `session.max_nesting_depth`, `compact.keep_messages`, `compact.max_summary_input`, `compact.max_message_slice`, `logging.level` and the four `observability.*` keys are read once at server start (object literals in `config.ts`; observability is mapped onto `OTEL_*` env by `initObservability()` at boot). They carry `restartRequired: true`; after a save or Reset of one of them the Settings page shows a notice above the section listing the saved keys and saying the Halo server must be restarted (dismissable; it stays until dismissed). Every other General key is read live.

### Field attributes

| Attribute | Required | Purpose |
|---|---|---|
| `key` | yes | Leaf key under the namespace |
| `type` | no | `string` (default) / `int` / `float` / `boolean` / `enum` — picks the input widget |
| `options` / `optionLabels` | no | For `type: enum`: the allowed values, and optional display labels parallel to them |
| `description` | no | English description rendered as help text |
| `description_zh` | no | Chinese description (UI picks based on lang) |
| `default` | no | Placeholder shown when the value is unset; supports `<<ENV>>`. For provider / skill / agent fields it is display-only: an unset param's `{{<id>.params.<key>}}` stays literal at substitution, so the consumer applies its own fallback (the `extension` skill's `ext.sh` treats `{{…}}` as "use the default hub"; `web-search`'s `search.py` as "use the default region") |
| `secret` | no | `true` → masked in API responses + password input in UI |
| `restartRequired` | no | `true` → read once at server start; the Settings page shows a restart notice after saving it. Built-in `general` section only |
| `advanced` | no | `true` → rendered in the collapsed "Advanced" area. Built-in `general` section only (every field except `language` / `theme`) |
| `globalOnly` | no | `true` → read from global settings only; workspace overrides are ignored at runtime. UI disables the workspace input and shows a "global only" hint; `PUT` / `PATCH` / `DELETE` of such a key at workspace scope is rejected with 400. Set by the built-in `general` section only — provider / skill / agent yaml declarations don't read it |

## Scope: global vs. workspace

| Scope | File | Priority |
|---|---|---|
| Global | `~/.halo/secrets/settings.yaml` | Base |
| Workspace | `<project>/.halo/settings.yaml` | Overrides global, key by key |

Read order: `<schema default> <- <global> <- <workspace>` (workspace layer applies to namespaced `params` / `secrets` only — see General above).

The Settings page shows source badges per field:
- `workspace` (blue, override applied here)
- `global` (green, value set at the global layer)
- `inherited from global` (grey, value pulled from global because workspace has none)
- `unset` (no value at any layer; the `default` is shown as placeholder)

A Reset button on each field removes the value at the current scope, letting it fall back to the lower scope (or unset).

## Environment variable injection

Values can carry `<<ENV_NAME>>` placeholders. They're expanded:
- At `shell_exec` time inside values resolved through `{{<id>.params.<key>}}` — see [workspace-tools.ts](../../../packages/server/src/tools/workspace-tools.ts) `substituteSecrets`.
- At read time when server-side code calls `getServerSecret(namespaceId, key)` — see [config.ts](../../../packages/server/src/config.ts).

**Trust boundary**: `<<ENV>>` is only expanded inside settings-resolved values. Raw cmd text the agent writes is not scanned — `shell_exec "echo <<HOME>>"` keeps the literal. This prevents an agent from naming an env var and forcing the server to dump it.

Env var unset → the `<<ENV_NAME>>` literal stays verbatim, plus `[MdVars] Env var "X" not set — keeping <<X>> literal` in the server log. The Settings UI returns the literal too — the browser never sees the real env value.

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

`params` / `secrets` values present in `settings.yaml` that no current schema declaration covers (the whole namespace is gone, or just that key) are surfaced as **orphans** in a dedicated tab. They aren't deleted automatically — uninstalling a skill keeps its values around so re-installing pops them back in. Users prune them on their own schedule via the orphan tab's per-key Remove buttons.

`general.*` is intentionally excluded from orphan detection — its declared keys are enumerated by the built-in schema, so anything else there is treated as either a typo or a forward-compat field, not an orphan.

## Security view (change password + logout)

A **Security** entry in the left nav (below the System group) opens a page with two cards. Like `__orphans` it's a synthetic nav target, not a schema section — the credential lives in `~/.halo/secrets/config.yaml` (`server.password`, scrypt hash), not `settings.yaml`, and the header shows that path accordingly.

**Change password** — three inputs: current password, new password, confirm. Live client-side feedback while typing: strength rule (≥8 chars, at least one letter and one digit), new ≠ current, confirm matches; the submit button stays disabled until all pass. Submit posts to `POST /api/auth/change-password` (see [dev/api.md](../dev/api.md)) — the server re-runs the same checks authoritatively; a server rejection is shown verbatim under the form. Success shows an inline confirmation and clears all three fields. When the password is supplied by the `HALO_PASSWORD` env var the endpoint refuses with 400, since the stored hash is not what login checks. Existing sessions stay signed in (`jwt_secret` is not rotated). Forgotten password (can't provide the current one) is out of scope here — that's `halo setup`'s reset path.

**Log out** — the login state is an httpOnly JWT cookie, so JS can't clear it directly: the button calls `POST /api/auth/logout` (server expires the cookie via Set-Cookie) and reloads; the boot auth check then lands on the login page. This browser only — no server-side token blacklist.

## API

| Operation | Method | Endpoint | Purpose |
|---|---|---|---|
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
          "default": "...",                        // omitted when the schema declares none
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

Same shape minus `value`. Removes the leaf at `key`. For Reset behaviour: workspace scope DELETE → field falls back to global / default; global scope DELETE → field becomes unset. Like PUT / PATCH it fires the settings-change notification; deleting a key that is already absent is a no-op (no write, no notification). Like PATCH, a `globalOnly` key at workspace scope is rejected with 400 and the file is left untouched.

## i18n

The admin UI is bilingual (en/zh). Field descriptions are localized via `description_zh` with fallback to `description`. Fixed UI labels live in `packages/admin/src/shared/i18n/`.

## Config caching

`config.ts` reads `settings.yaml` lazily with mtime-watching: every read stats the file and reparses if the mtime has changed. UI saves bump the mtime, so the server picks up new secrets, params and most General keys on the next read without a restart. The exceptions are the `restartRequired` General keys (see General above) and `general.goal_mode_enabled`, which are read once at boot — those need a server restart. See [packages/server/src/config.ts](../../../packages/server/src/config.ts) `getSettings()`.

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
- `<namespace-id>` is `general`, a provider id, a skill id, an agent id, or `ext-<extension-id>` (a canvas extension)
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
id: aws-bedrock-claude-invoke       # provider identity — also the settings namespace below
runtime: bedrock-invoke             # implementation class; not part of the settings schema
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

Built-in skills declare theirs the same way — today `extension`, with plain `hub_base` (the https base URL holding each hub extension's `<id>/update.json`, read by `/extension install <id>` and the admin's update check; point it at a mirror; empty = the GitHub raw `extensions/` directory of `hub_repo`) and `hub_repo` (the hub `/extension models` pulls release zips from, and where the default `hub_base` comes from; empty = turmind/halo-hub) params, and `web-search`, with plain `fast_region` / `deep_region` params (AWS regions for its two Bedrock gears; empty = us-east-1 fast, us-west-2 deep / us-east-1 for sol). `halo setup` asks only for built-in skills' `secret: true` params; plain params are configured in Settings → Skills only.

Global agents declare theirs the same way in `agents/<agent-id>/agent-config.yaml` (same `params:` / `secrets:` lists; shown under Settings → Agents).

### Extension params/secrets — `halo-extension.json` `settings`

An installed canvas extension declares its own config in its manifest: `"settings": { "params": [field…], "secrets": [field…] }`, same field format as a skill's `config.yaml` (`key`, `description`, `description_zh`, `default`, `type`, `options`) but validated strictly — a malformed field makes the whole manifest an error (red row in Settings → Extensions) instead of being skipped. Each such extension becomes one section with `source: "extension"`, namespace **`ext-<extension-id>`** (the prefix keeps it from colliding with a skill / provider namespace) and the manifest `name` as title, listed in the left nav under its own group **Extension settings / 扩展配置**, right below the Extensions entry. Every field is `globalOnly` (stored in `~/.halo/secrets/settings.yaml` only; a workspace write is rejected with 400) and every `secrets` field is masked. Only server code reads the values (e.g. the Meeting Recorder's Amazon Transcribe region and keys) — they never reach the extension, the manifest or the hub. The section appears / disappears live: installing, removing or switching an extension on / off pushes `extension:changed`, and the open Settings page re-fetches the schema. A switched-off extension has no section, but its values are kept — they are not listed as orphans and are back as they were when it is switched on. See [design/canvas-extensions.md → Extension settings](../design/canvas-extensions.md#extension-settings).

### General — built-in

Declared in [packages/server/src/settings-schema.ts](../../../packages/server/src/settings-schema.ts) `generalSection()`. The server itself is the implicit declarer. Keys: `language`, `theme`, `agent.max_retries`, `server.*`, `session.*`, `compact.*`, `sandbox.*`, `logging.*`, `observability.*` (read once at boot — restart the server to apply; cron / evolution runs pick a change up on their next run), `outbound_proxy.*`, `evolution.*`, `limits.*`. All `general.*` keys are `globalOnly` except `evolution.level` and `evolution.auto_apply_threshold`: `config.ts` resolves the `globalOnly` ones through `settingsValue()` against `~/.halo/secrets/settings.yaml` only, so a workspace `settings.yaml` cannot override them. Per-workspace layering applies to namespaced `params` / `secrets` (`getServerSecret(ns, key, workspaceRoot)`, `substituteSecrets`).

`server.trust_proxy` (boolean, default `false`, `globalOnly`): whether the brute-force rate limiter (`middleware/brute-force.ts` `getClientIp`) trusts the `x-forwarded-for` header for client IP resolution. Direct-connect deployments leave it `false` and get the socket address. Behind a reverse proxy (nginx / Cloudflare / etc.), set it to `true` so the real client IP is honored instead of the proxy's — but only when that proxy is one you control and rewrites the header itself, otherwise a client can forge XFF to dodge lockouts.

`sandbox.hidden_dirs` / `sandbox.hidden_files` / `sandbox.writable_dirs` are `globalOnly` — they define the security boundary agents run inside, so a workspace `settings.yaml` cannot override them (a workspace overriding them could lift its own sandbox constraints). `hidden_dirs` / `hidden_files` hold **extra** entries: the effective list is the built-in default (`DEFAULT_HIDDEN_DIRS` / `DEFAULT_HIDDEN_FILES` in `tools/sandbox.ts`, the single source — `~/.halo/secrets`, `~/.aws`, `~/.ssh`, `~/.gnupg`, `~/.docker`, `~/.config/gh`, `~/.halo/global/internal-sessions`, `~/.halo/global/logs`; `~/.npmrc`, `~/.bash_history`, `~/.gitconfig`, `~/.git-credentials`, `~/.netrc`, the global `evo` / `cron` / `runs` databases + `-wal` / `-shm`) plus the user's entries, deduped (`config.ts` `resolveSandboxPaths()`, used by both the server and the CLI). A default entry cannot be removed from the list in settings. The lists apply only to workspace / readonly sessions (bwrap / Seatbelt, or `assertPathAllowed` without an OS sandbox); Full sessions, the admin file explorer (`validatePath`, workspace-bound only) and the terminal never consult them. The schema `default` is empty so the placeholder doesn't suggest copying the built-ins; the field description names them. `writable_dirs` is a plain list (no built-ins).

#### Outbound proxy

For a machine whose way out is a local proxy (e.g. Hiddify / Clash in system-proxy mode on `127.0.0.1:12334`). Command-line tools ignore the OS proxy setting, so without this they connect directly. Three `globalOnly` fields, all read live (the mtime-cached settings, one `stat` per spawn / request) — no restart:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `outbound_proxy.enabled` | boolean | `false` | Master switch. On with an empty `url` = off, no error |
| `outbound_proxy.url` | string | `''` (placeholder `http://127.0.0.1:12334`) | Proxy address. Must parse with scheme `http:` or `https:` and carry **no user-info** — `PUT` / `PATCH` reject `user:pass@…` with 400 (`… put them in Token …`) so a credential never lands in a plain-text field. A hand-edited bad value is ignored at read time (proxy off, one `[OutboundProxy]` warning that never echoes the URL) |
| `outbound_proxy.token` | string, **secret** | `''` | Optional credential: `user:password`, or a bare token (= user name, empty password). Masked in `GET /api/settings/schema` like any secret |

**What goes through it** (when on):
- **Spawned children** — `shell_exec` at every access level, Terminals, notebook kernels, evolution runs. `cleanChildEnv()` (`child-env.ts`) adds `http_proxy`, `https_proxy`, `HTTP_PROXY`, `HTTPS_PROXY`, `no_proxy`, `NO_PROXY`. The bwrap (`--clearenv` + `--setenv`) and macOS Seatbelt (allowlisted env) paths add the same vars from the same function. Neither isolates the network, so a proxy on the host's loopback is reachable from inside.
- **web_fetch** and **A2A requests to remotes** (agent card + JSON-RPC, `a2a/outbound.ts`) — an undici `ProxyAgent` passed per request. It is never the global dispatcher: model provider calls share the global `fetch` and keep their own route. A2A's `general.a2a.url_allowlist` check still runs on the target before the request goes to the proxy. A2A push webhooks to callers and inbound image URL fetches stay direct.

**Not covered**: model provider calls, channel connections (Telegram / Slack / Feishu …), the hub / update checks.

**no_proxy**: `localhost,127.0.0.1,::1`, plus whatever `NO_PROXY` / `no_proxy` the server process itself inherited, deduped (an inherited `*` makes the list just `*`). A child gets that list. web_fetch / A2A match it the way curl 8.x does, so in-process requests and a child's curl route alike:
- a host name matches an entry equal to it or to a parent domain, case-insensitive, a leading dot ignored — `corp.example` and `.corp.example` both match `corp.example` and `a.corp.example`, not `notcorp.example`;
- an IP address (v4, or v6 as in `http://[fd00::1]/`) matches an entry that is that address or a CIDR containing it — `10.0.0.0/8`, `fd00::/8`; an IP entry never matches a host name;
- `*` alone matches everything;
- nothing else is a pattern: `*.corp.example` is compared literally (matches no real host), and an entry with a port (`host:8080`) never matches — ports play no part.

web_fetch applies this per redirect hop: a redirect into a no_proxy host connects directly, one out of it goes through the proxy.

**Off** = Halo sets no proxy variables at all. Proxy variables the server process inherited from its own environment are not removed — they are the operator's.

**Token transport** — Basic auth both ways, `base64(user:password)`:
- children: in the proxy URL's user-info, percent-encoded (`http://<user>:<pass>@host:port`) — the one form curl, git and pip all read;
- web_fetch / A2A: the `Proxy-Authorization` header (on the CONNECT for https and http alike). While the proxy is on, a web_fetch call carrying its own `Proxy-Authorization` header (any case) is refused with a tool error before any request — no_proxy targets included.

`<<ENV_NAME>>` in the token expands from the server's environment, as in any secret; an unset variable stays literal.

The credential never appears in logs (only the user-info-free origin is printed: `[OutboundProxy] on: http://host:port (with token)`). In `shell_exec` results (e.g. `env` output) its URL form `<user:pass>@` (percent-encoded or not) and its base64 are masked at any length; the bare token / encoded user-info on their own only from 4 characters (shorter strings would mangle ordinary output). In bwrap sessions only the command itself gets the proxy variables, not the file tools' helper processes.

**Terminals** get their env when they are opened: a Terminal already open keeps the old setting, a newly opened one picks up the change.

`evolution.*` controls the self-evolution subsystem (see [design/evolution.md](../design/evolution.md)). `evolution.level` and `evolution.auto_apply_threshold` can be set **per workspace**: `<workspace>/.halo/settings.yaml` overrides `~/.halo/secrets/settings.yaml`, which overrides the schema default (an open workspace can sit at L0 while a private one auto-applies), and the workspace Settings page edits them like any non-`globalOnly` field. The rest of `evolution.*` is `globalOnly` — it lives in `~/.halo/secrets/settings.yaml` only, not workspace settings. Notable knobs: `evolution.level` (`L0` = manual only: `/evo` drafts, a reviewer approves; `L1` = L0 plus automatic drafting on pre-compact; `L2` = L1 plus auto-applying prompt-only changes that pass the gates; `L3` = L2 plus auto-applying capability changes — auto-applied changes still pass the regression check and can be rolled back from the Evolution tab; only changes learned from a `full`-access session auto-apply; a cron run's own turn never drafts on pre-compact), `evolution.auto_apply_threshold` (int 0–100, default 80 — minimum average score at L2/L3, on top of the fixed floors confidence high / behavior ≥ 70 / lint 100 / all sandbox checks; a save outside 0–100 is rejected with 400), `evolution.max_concurrent_run` / `max_concurrent_apply` (wrapper concurrency caps), `evolution.run_timeout_minutes` / `apply_timeout_minutes` (heartbeat timeouts), `evolution.max_attempts` (per-row retry cap), `evolution.triggers.pre_compact` (snapshot session before compaction).

Goal mode's entry points are offline (the `/goal` command, admin banner and creation of new goal sessions are hidden). To reopen them, set `general.goal_mode_enabled` — a global-only boolean, default `false`, read from `~/.halo/secrets/settings.yaml` only (a workspace `settings.yaml` has no effect) and not shown in the Settings UI — then restart the Halo server and refresh the browser (existing goal bindings and history are not touched either way):

```yaml
general:
  goal_mode_enabled: true
```

The value is read once at process start, so unlike other settings it is **not** picked up by the mtime-watching reload.

There is no "default provider" setting: a newly created agent's `model:` is a copy of the **default agent's** `model:` mapping — for workspace scope `<project>/.halo/agents/default/agent.yaml` when it exists, else the global `~/.halo/global/agents/default/agent.yaml`; for global scope the global one. When that file is missing or has no `model` mapping, the scaffold falls back to the provider registry (`aws-bedrock-claude-invoke` if installed, else the first provider on disk), deriving model id / endpoint / prompt caching / thinking from that provider's YAML. Only `model` is copied; `context` stays the scaffold default. Existing agents are not retroactively touched. A leftover `general.agent.default_provider` in `settings.yaml` is ignored. Implementation: [packages/server/src/routes/agent-configs.ts](../../../packages/server/src/routes/agent-configs.ts) `scaffoldModelBlock()`.

**Advanced fold**: on the General page, `language` and `theme` are shown in the open; every other General field is in an "Advanced" area, collapsed by default (schema flag `advanced: true`, set in `generalSection()`).

**Restart-required fields**: `agent.max_retries`, `session.max_queue_size`, `session.max_nesting_depth`, `compact.keep_messages`, `compact.max_summary_input`, `compact.max_message_slice`, `logging.level` and the four `observability.*` keys are read once at server start (object literals in `config.ts`; observability is mapped onto `OTEL_*` env by `initObservability()` at boot). For observability that applies to the server's own exporter (cron runs included — they run in the server process) only: evolution runs are `halo cli` children that don't inherit those settings-derived `OTEL_*` vars (`cleanChildEnv()` strips them), so they use a new value on their next run — as the field descriptions say. They carry `restartRequired: true`; after a save or Reset of one of them the Settings page shows a notice above the section listing the saved keys and saying the Halo server must be restarted (dismissable; it stays until dismissed). Every other General key is read live.

### Field attributes

| Attribute | Required | Purpose |
|---|---|---|
| `key` | yes | Leaf key under the namespace |
| `type` | no | `string` (default) / `int` / `float` / `boolean` / `enum` — picks the input widget |
| `options` / `optionLabels` | no | For `type: enum`: the allowed values, and optional display labels parallel to them |
| `description` | no | English description rendered as help text |
| `description_zh` | no | Chinese description (UI picks based on lang) |
| `placeholder` | no | Example shown in an empty text input, display only — unlike `default` it is not a value anything falls back to (e.g. `outbound_proxy.url`). Built-in `general` section only |
| `default` | no | Placeholder shown when the value is unset; supports `<<ENV>>`. For provider / skill / agent fields it is display-only: an unset param's `{{<id>.params.<key>}}` stays literal at substitution, so the consumer applies its own fallback (the `extension` skill's `ext.sh` treats `{{…}}` as "use the default hub"; `web-search`'s `search.py` as "use the default region") |
| `secret` | no | `true` → masked in API responses + password input in UI |
| `restartRequired` | no | `true` → read once at server start; the Settings page shows a restart notice after saving it. Built-in `general` section only |
| `advanced` | no | `true` → rendered in the collapsed "Advanced" area. Built-in `general` section only (every field except `language` / `theme`) |
| `globalOnly` | no | `true` → read from global settings only; workspace overrides are ignored at runtime. UI disables the workspace input and shows a "global only" hint; `PUT` / `PATCH` / `DELETE` of such a key at workspace scope is rejected with 400. Set by the built-in `general` section and forced on every extension field — provider / skill / agent yaml declarations don't read it |

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

- **Settings page hint**: each field in the `GET /api/settings` response carries `envMissing`, the names of `<<X>>` placeholders in its effective value whose variable is unset in the server process (names only, never values). The page shows an amber warning under that field's input naming the variables, and explains that background servers and the desktop app don't read `~/.bashrc` / `~/.zshrc`. The check runs against the server's `process.env`, not the user's shell.
- **Model provider credentials** (`api_key`, `access_key_id` / `secret_access_key`): an unset placeholder is never sent as the key. Every model call in that session fails before the request with one `account`-class error naming the provider, field and variable, with no retries; opening and reading the session still work. A variable added while the session is in memory takes effect once the session's agent is rebuilt. See [guide/secrets-and-credentials.md → Missing env var](../guide/secrets-and-credentials.md#missing-env-var).

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

`params` / `secrets` values present in `settings.yaml` that no current schema declaration covers (the whole namespace is gone, or just that key) are surfaced as **orphans** in a dedicated tab. They aren't deleted automatically — uninstalling a skill keeps its values around so re-installing pops them back in. A switched-off extension's values (its `ext-<id>` namespace and the skills it ships) are not orphans and are never listed here. Outbound A2A tokens `a2a.secrets.<remote>` are declared by `~/.halo/secrets/a2a-remotes.yaml` (one field per `auth: bearer` remote, shown under **System → A2A remotes**), so they aren't orphans either — only a token whose remote has left the list is. Users prune them on their own schedule via the orphan tab's per-key Remove buttons.

`general.*` is intentionally excluded from orphan detection — its declared keys are enumerated by the built-in schema, so anything else there is treated as either a typo or a forward-compat field, not an orphan.

## Left nav

Groups top to bottom: **System** (General · A2A remotes — only while a2a-remotes.yaml has a bearer remote · Security · Extensions, each with a leading icon), **Extension settings**, **Model providers**, **Agents**, **Skills**, and **Orphans** when there are any. Each group header is a quiet toggle (chevron + smaller muted label) that collapses its items; all groups start expanded, and the collapsed ones are remembered per browser (`localStorage` `halo_settings_navCollapsed`, collapsed ids only — so a group that appears later starts expanded).

## Sync latest models

The **Model providers** group ends with a **Sync latest models** row (refresh icon, styled like the nav items, opens no page). One click has the server fetch the hub's newest `models-v*` release and install the provider yamls in it that are newer than the copy in effect — the same rules as `/extension models` ([design/storage.md → Model registry format](../design/storage.md#model-registry-format), API [dev/api.md → Model sync](../dev/api.md#canvas-preview-extensions)).

- **Running**: the row reads "Syncing…" with a spinning icon and is disabled until the request returns.
- **Confirm**: when an install would send requests to a URL the provider didn't use before (a new provider, a changed default endpoint / presets, an added model endpoint), nothing is written yet. A "Confirm endpoint changes" dialog lists each such provider with its endpoint change lines; **Cancel** (or a click outside) sends nothing more, **Install** re-checks the hub and writes.
- **Result**: a "Models synced (<release>)" dialog with the summary line and one row per provider yaml — installed / up to date / skipped / refused, plus the reason (e.g. "needs a newer halo").
- **Failure**: a "Model sync failed" dialog with the server's error text (rate-limited, no release, network…), not the raw HTTP status.
- **GitHub hubs only**: the hub is the extension skill's `hub_repo` (Settings → Skills → extension; empty = turmind/halo-hub). Requests are anonymous, 60 per hour per IP. For a Gitea / Forgejo / GitLab hub the server refuses with a pointer to `/extension models` in a chat, which handles those.
- The provider list and model pickers refresh from the `models:changed` push — no reload, no polling. Existing agents keep the model / endpoint in their own `agent.yaml`.

## Extensions view and update notices

**Settings → Extensions** (System group) lists the installed canvas preview extensions — on and off in one list sorted by id, plus refused directories as red rows — with **Install from zip** in the header. Each valid row offers:

- an **on / off switch**. Off = the extension acts as uninstalled everywhere (no previews, Open with, activity-bar or chat-bar entry, skills or settings section) while its files and settings values stay; the row is dimmed with an "Off" tag. A fresh install starts on; an update keeps the switch; uninstalling forgets it. A tab with unsaved changes stays open on a just-switched-off extension with a "turned off — save your changes" banner;
- **Update** when its update.json names a newer version (a blue "Latest X" under the name). One click downloads, verifies and installs it; open tabs pick the new version up as with any upgrade. A newer version that needs a newer Halo shows "X needs Halo Y — upgrade Halo first" and no button. A downgrade is never offered. Other grey lines: "No update info at the source", "No update source configured" (a non-GitHub `hub_repo` with no `hub_base`), or why the source couldn't be read (invalid / refused / unreachable);
- **Remove** (with a confirm).

The header's **Check for updates** re-checks every extension (at most once a minute), and "Last checked hh:mm" shows when the last check finished, followed by "· N updates available" when some can be updated, or "· all up to date" when every extension is on its latest version (nothing is added while a check runs, or when any row has no verdict or a grey note). Opening the view checks automatically only when the last check is over a day old; results are pushed to every open admin, with no polling and no badge.

**Halo itself**: the foot of the Settings sidebar shows "Halo v<version>" and **Check for updates**. It is checked when Settings is opened (again at most once a day; the button forces it, at most once a minute) against npm's `latest` — no badge elsewhere, no automatic upgrade. A newer release shows "New version X", the command `halo upgrade && halo server restart` with a copy button, a hint that a systemd system unit needs `sudo` (see [dev/deploy.md → Upgrade flow](../dev/deploy.md#upgrade-flow)) and a Release notes link. In the desktop app it shows only "Download the new installer"; a source build shows "Source build — not checked"; a failed check shows one grey line. Design: [design/canvas-extensions.md → Updates](../design/canvas-extensions.md#updates-updatejson).

## Security view (change password + logout)

A **Security** entry in the left nav (inside the System group, below General) opens a page with two cards. Like `__orphans` it's a synthetic nav target, not a schema section — the credential lives in `~/.halo/secrets/config.yaml` (`server.password`, scrypt hash), not `settings.yaml`, and the header shows that path accordingly.

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

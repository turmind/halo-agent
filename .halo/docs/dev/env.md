# Development Environment

## Ports

- **8080** is code-server — don't touch, don't occupy, don't kill
- **9527** is Hono (Halo server); one process serves API + WebSocket + static frontend

## Browser testing

- URL: `http://localhost:9527/?folder=<url-encoded absolute workspace path>`
- Password: set via `halo setup` (stored as scrypt hash in `~/.halo/secrets/config.yaml server.password`) **or** `HALO_PASSWORD` env (plaintext — preferred for Docker / CI). Env wins over hash if both are set.
- Workspace path: any absolute directory you want to bind

## Deploy commands

### Frontend build (web only)

```bash
cd packages/admin && npx next build --no-lint && node scripts/copy-monaco.mjs
```

### Backend redeploy (server only)

```bash
cd packages/server && npx tsc
kill -9 $(ss -tlnp | grep ':9527' | grep -oP 'pid=\K\d+') 2>/dev/null
sleep 1
nohup node dist/index.js >> /dev/null 2>&1 &   # HALO_PASSWORD read from env/config
```

### Full deploy in one go

```bash
cd packages/admin && npx next build --no-lint && node scripts/copy-monaco.mjs
cd ../server && npx tsc
kill -9 $(ss -tlnp | grep ':9527' | grep -oP 'pid=\K\d+') 2>/dev/null
sleep 1
nohup node dist/index.js >> /dev/null 2>&1 &   # HALO_PASSWORD read from env/config
```

## Prerequisites

- Node.js ≥ 22 (better-sqlite3 native binding is bound to v22)
- pnpm ≥ 9
- AWS credentials configured (`~/.aws/credentials` or env vars) with Bedrock access
- bubblewrap (`sudo apt install bubblewrap`) — OS-level sandbox for non-full access levels. Without it, only app-level path validation is active and `shell_exec` is blocked for non-full sessions

### nvm PATH

If the shell doesn't auto-load nvm:

```bash
export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH
```

Your deployment scripts should also prepend this line.

## Runtime directories

- SQLite: `data/halo.db` (auto-created on first start)
- Session files: `.halo/sessions/{agentId}/{sessionId}.json`
- Global config: `~/.halo/global/`
- Per-project config: `<workspace>/.halo/`

## Configuration sources

Three config file types, precedence **env vars > config.yaml / settings.yaml > code defaults**:

| File | Scope | Contents |
|---|---|---|
| `~/.halo/secrets/config.yaml` | System | Port, password, CORS, timeouts, limits, logging — "infrastructure" settings |
| `~/.halo/secrets/settings.yaml` | User | Model, region, session behaviour — "preferences" |
| `<project>/.halo/settings.yaml` | Project | Overrides of global settings |

`init.ts` seeds these on first run with a per-category policy. Refresh trigger: `halo setup` always re-runs the seed, and the server's startup check re-runs it automatically when `~/.halo/global/.template-version` is behind the bundled `TEMPLATE_VERSION` (see `init.ts:TEMPLATE_VERSION` + `index.ts` startup block).

- **Always overwritten** (platform-owned, refreshed when the template version moves): `~/.halo/global/{prompts,models,docs}/`, `INSTRUCTIONS.md`, the built-in agent ids (`default`, `executor`, `deep-executor`, `__evo_agent__`, `__score__`, `__apply_agent__`), built-in skill ids (`agent`, `skill`, `workspace`, `cron`, `acp`, `send-file`, `self`, `aws-knowledge`, `nova-web-search`, `halo`).
- **Built-in agents** keep the user's `model:` block on overwrite — the admin UI lets users change which model an agent uses, and that choice survives upgrades.
- **Optional skills** (`tavily-web-search`) install only when picked via `halo setup`; the opt-in list is `~/.halo/global/.installed-optional-skills`. Picked skills are force-overwritten alongside the always-overwritten set.
- **`secrets/config.yaml`** is leaf-merged: existing leaf `value`s preserved, new leaves added when a server upgrade introduces them.
- **`secrets/settings.yaml`** is created empty if missing and never touched again. Defaults live in `settings-schema.ts`.

## Environment variable overrides

Source: `packages/server/src/config.ts`

| Variable | Default | Config path | Description |
|---|---|---|---|
| `HALO_PORT` | `9527` | `config.yaml server.port` | Hono listen port |
| `HALO_PASSWORD` | (none) | `config.yaml server.password` (scrypt hash) | Plaintext login password. When set, takes precedence over the stored hash and bypasses scrypt entirely — intended for Docker / systemd / CI. It also satisfies the **startup gate**: the server refuses to boot with no password configured, and env plaintext counts as a first-class credential there, so an env-only deployment (`halo setup -y && HALO_PASSWORD=... halo server start`, no stored hash) boots fine. The hash is set by `halo setup` for interactive installs. |
| `HALO_CORS_ORIGINS` | empty (reflect any origin) | `config.yaml server.cors_origins` | CORS allowlist (comma-separated). Empty = reflect any incoming Origin so credentials work cross-origin. Set explicit list to enforce strict CORS. |
| `HALO_FRONTEND_DIR` | `packages/admin/out` | — | Static frontend dir (resolved as absolute path from project root) |
| `HALO_MAX_CONTEXT_TOKENS` | `200000` | — | Model max context |
| `HALO_SHELL_TIMEOUT` | `120000` | `config.yaml timeout.shell_exec` | Shell command timeout (ms) |
| `HALO_WEB_FETCH_TIMEOUT` | `10000` | `config.yaml timeout.web_fetch` | web_fetch timeout |
| `HALO_MODEL_TIMEOUT` | `1800000` | `config.yaml timeout.model_request` | Per model-call wall-clock cap (ms, 30 min). A bare fetch has no default timeout, so a half-open connection would hang the request forever; on expiry the call aborts and the agent loop retries with backoff. |
| `HALO_SESSION_GRACE` | `300000` | `config.yaml timeout.session_grace` | WS-disconnect session grace |
| `HALO_TERMINAL_GRACE` | `300000` | `config.yaml timeout.terminal_grace` | Terminal disconnect grace |
| `HALO_MAX_CACHED_SESSIONS` | `50` | — | In-memory session cache |
| `HALO_LOG_MAX_SIZE` | `10485760` | `config.yaml logging.max_file_size` | Log file size cap (10 MB) |
| `HALO_LOG_MAX_FILES` | `5` | `config.yaml logging.max_files` | Retained rotated logs |

settings.yaml only (no env override):
- `general.session.max_queue_size` (default 256)
- `general.session.max_nesting_depth` (default 16)
- `general.agent.max_retries` (default 5)
- `general.compact.keep_messages` (default 5) — recent messages to keep uncompacted
- `general.compact.max_summary_input` (default 15000) — local compaction fallback input cap
- `general.compact.max_message_slice` (default 800) — local compaction per-message cap
- `general.compact.summarize_timeout_sec` (default 300) — self-compact timeout
- `general.sandbox.hidden_dirs` (default `~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker`) — bwrap tmpfs overlays, scope: global
- `general.sandbox.hidden_files` (default `~/.npmrc,~/.bash_history,~/.gitconfig`) — bwrap /dev/null binds, scope: global
- `general.logging.level` (default `warn`) — log level: debug | info | warn | error

`<provider-id>.secrets.*` (server-only, hard-rejected by `{{}}` substitution; declared in `models/<provider-id>.yaml` `secrets:`):
- `aws-bedrock-claude-invoke.secrets.access_key_id` / `.secret_access_key` — AWS / Bedrock credentials
- `kimi.secrets.api_key` — Kimi (Moonshot AI)
- `deepseek.secrets.api_key` — DeepSeek

When a provider manifest declares a `default: <<NAME>>` for a secret, `halo setup` offers a "Use env $NAME" action. Picking it **writes the literal `<<NAME>>` placeholder into settings.yaml**, which the standard env-var interpolation ([storage.md](../design/storage.md#env-var-interpolation-env_name)) expands against `process.env` at read time. There is no separate runtime env fallback — the placeholder in the file is the only mechanism (an unset env var leaves the literal `<<NAME>>` visible in the request, failing loudly).

`<skill-id>.params.*` (referenceable from skills via `{{<skill-id>.params.<key>}}`, or short form `{{params.<key>}}` inside SKILL.md; declared in `skills/<id>/config.yaml`):
- `tavily-search.params.api_key` — example only; declared by whichever skill needs it

Hardcoded (config.ts, no override):
- `auth.tokenMaxAge` — 14 days
- `auth.refreshAfter` — 24 hours
- `model.compressAt` — default 0.8 (auto-compact threshold; configurable via `general.compact.compress_at` in settings.yaml)

settings.yaml-driven `general.limits.*` (no env override):
- `general.limits.shell_output_bytes` (default 5 MiB)
- `general.limits.web_fetch_bytes` (default 50 KiB)
- `general.limits.grep_default_matches` (default 50)
- `general.limits.tool_result_render_chars` (default 8000)
- `general.limits.ws_event_buffer` (default 5000)
- `general.limits.terminal_scrollback_bytes` (default 50000)

Two ways to authenticate:

1. **Interactive** — run `halo setup`, pick "Set / change password". The value is scrypt-hashed and written to `~/.halo/secrets/config.yaml server.password`. Best for personal installs.
2. **Env** — export `HALO_PASSWORD=...` before launching the server. The plaintext value is compared directly (no hashing) and takes precedence over any stored hash. A stored hash isn't required at all — env plaintext alone satisfies the startup gate, so env-only deployments are legal. Best for Docker / systemd / CI where a secrets manager already protects the env.

## Verify

```bash
curl http://localhost:9527/api/health
# expect: {"status":"ok", ...}

curl -s -o /dev/null -w "%{http_code}" http://localhost:9527
# expect: 200
```

## Coding conventions

- TypeScript strict, ESM only
- camelCase variables/functions, PascalCase types, kebab-case filenames
- React functional components; styling via Tailwind only; UI prefers shadcn/ui
- Log format `[Module] message`
- Bedrock model ID: `global.anthropic.claude-sonnet-4-6`, default region `us-east-1` (configured per agent via `agent.yaml model.endpoint`)
- File operations are sandboxed by bwrap (OS-level) + `assertPathAllowed` (app-level fallback) for non-full sessions

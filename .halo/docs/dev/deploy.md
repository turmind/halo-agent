# Deployment

## Local maintenance — default short path

For this personal-use workspace: **version/tag → required build → install → restart → basic version/health/startup-log checks**. For an already published version, just **install → restart → checks**; don't rebuild or republish it. Reuse applicable passed tests rather than rerunning a full suite.

No default backups, rollback preparation/scripts/instructions, or extra per-release plans/checklists/report files. A short CHANGELOG summary and a brief result are enough. Explicit authorization for the named service is sufficient; don't ask for another GO. Diagnose/fix failures within the authorized scope instead of automatic rollback.

Confirm the service/user/HOME/port in `dev-environment.local.md`. If the agent is inside the service being restarted, carry the install/restart/basic checks in one independent systemd task; from outside it (e.g. dev → prod), operate directly. No deployment framework is needed.

For this host's `/usr` installation and `ubuntu` service user, after authorization:

```bash
(
set -e
version='x.y.z'  # exact requested version
curl -sfI "https://registry.npmjs.org/@turmind/halo/-/halo-$version.tgz" >/dev/null  # tarball replicated? (a fresh publish can 404 for ~15 min)
sudo sh -c 'umask 022; npm install -g --prefix /usr --no-audit --no-fund "@turmind/halo@$1"' sh "$version"
installed=$(sudo -u ubuntu env HOME=/home/ubuntu /usr/bin/halo --version)
test "$installed" = "halo $version"  # mismatch or launch failure stops before restart
sudo systemctl restart halo.service
curl --fail --retry 10 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:9527/api/health  # status ok, requested version
sudo journalctl -u halo.service --since '2 minutes ago' -n 40 --no-pager
)
```

**Fresh-publish gate:** right after `npm publish`, `npm view` may already show the version while the tarball still 404s for several minutes (1.6.0: ~15 min, the first prod install failed `E404` before restart). The `curl -sfI` line stops the sequence before install; wait and rerun, never republish.

**Permission gate:** root npm installs must use `umask 022`, then pass `halo --version` as the actual service user. Secrets/logs can use 077, but it must not leak into public package installation: the 1.5.0-alpha install inherited 077, made root-only package directories and left the ubuntu service failing with 203/EXEC.

**Public release is a separate requested target:** synchronize the five package versions/tag, build and publish npm once, create the GitHub release and attach the Windows exe; verify the exact npm version/dist-tag and GitHub asset. macOS dmg remains the user's step unless requested. See the [publication command reference](#public-release-command-reference) only for the needed commands.

The setup, architecture and troubleshooting material below is retained as on-demand reference, not a mandatory routine-deployment checklist.

## Architecture overview

Halo only needs **one Node process** (Hono on port 9527 by default). API, WebSocket, and static frontend live in the same process.

```
Browser ──────────────▶ Hono (:9527)
                        ├── /api/*   → API routes
                        ├── /ws      → WebSocket (chat + terminal)
                        └── /*       → Static files (packages/admin/out/)
```

Next.js is build-time only (`next build` → static export to `out/`) — no Next.js process at runtime.

Nginx is **not required**. Use it only for domain routing, SSL termination, or when the port is shared with other services.

## Prerequisites

- Node.js ≥ 22 — Ubuntu 24.04's apt `nodejs` is 18, too old; use NodeSource (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`), `brew install node@22`, or nvm / fnm. On an older Node, `halo` exits 1 at launch with the version it found and these install hints instead of crashing. On a just-booted cloud VM the first `apt-get install` can fail on the dpkg lock (`Could not get lock …`, exit 100) while cloud-init / the SSM agent is still installing packages — wait a minute and rerun
- pnpm 11 — source builds only (pinned by the root `packageManager`; `corepack enable` picks it up)
- AWS credentials — optional, only for the Bedrock providers (`~/.aws/credentials`, env vars, or an instance role)
- bubblewrap (Linux) — needed for the `workspace` / `readonly` access levels: `sudo apt install bubblewrap`; on Ubuntu 23.10+ / 24.04 also the [AppArmor profile](#bubblewrap-on-ubuntu-2310-and-2404-apparmor)

### bubblewrap on Ubuntu 23.10 and 24.04 (AppArmor)

Ubuntu 23.10+ ships `kernel.apparmor_restrict_unprivileged_userns = 1`, and the `bubblewrap` package brings no AppArmor profile, so `apt install bubblewrap` alone isn't enough. Check with:

```bash
bwrap --ro-bind / / --die-with-parent -- /bin/true
# bwrap: setting up uid map: Permission denied   ← blocked by AppArmor
```

Halo's boot probe sees the same failure. The server warns once at startup, `[Server] OS sandbox unavailable (bwrap cannot create namespaces: bwrap: setting up uid map: Permission denied) — workspace/readonly sessions get no shell_exec. Fix: …` with a link to this section, and then runs without an OS sandbox. `halo cli` / `tui` print the same line, tagged `[cli]`, but only for `--access workspace|readonly`; without bubblewrap installed, the fix it names is `sudo apt install bubblewrap`. Fix it with a profile that lets only `bwrap` create user namespaces:

```bash
sudo apt-get install -y bubblewrap
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
halo server restart && curl -s --retry 15 --retry-connrefused --retry-delay 1 localhost:9527/api/health   # "sandbox":"bwrap"
# a unit-run server is restarted through systemctl (Option C: may need the printed `sudo systemctl restart halo`)
```

Alternative: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (persist it in `/etc/sysctl.d/`). That also works, but it lifts the restriction for **every** program, not just bwrap.

Check: `GET /api/health` reports `"sandbox":"bwrap"`; `"sandbox":null` means non-full sessions still have no OS sandbox (and no `shell_exec`).

## 1. Install dependencies and build

```bash
cd /path/to/halo
pnpm install

pnpm --filter @turmind/halo-core build
pnpm --filter @turmind/halo-server build
pnpm --filter @turmind/halo-admin build   # next build + copy-monaco; never a bare next build (Monaco would 404)
```

## 2. Runtime data locations

No directory needs to be created by hand. SQLite databases are created automatically on first use: per-workspace state at `<workspace>/.halo/halo.db`, plus global queues at `~/.halo/global/evo.db`, `~/.halo/global/cron.db`, `~/.halo/global/runs.db` and `~/.halo/global/a2a.db`, and channel accounts at `~/.halo/secrets/channels/channels.db`.

## 3. Run `halo setup`

Seeds `~/.halo/global/` with templates (agents, skills, prompts, models, docs), creates `secrets/config.yaml`, and walks you through password / port / model API keys / optional skills.

```bash
halo setup        # interactive — picks up arrow-key UI on TTYs
```

Re-run any time to change the password, refresh model keys, or toggle optional skills. Built-in agent / skill files are force-overwritten on every run; user-created agents and skills are left alone.

For Docker / CI builds where stdin isn't a TTY, see [Non-interactive (Docker / CI) details](#non-interactive-docker--ci-details) below.

## 4. Environment variables (optional)

Full list in [env.md](env.md). The most common one is `HALO_PASSWORD`, which acts as a plaintext password and bypasses the scrypt hash stored by `halo setup`. Use it when an external secret store (k8s / systemd / Docker secrets) already protects the value:

```bash
echo 'export HALO_PASSWORD=your_password_here' >> ~/.bashrc
source ~/.bashrc
```

When `HALO_PASSWORD` is set, the password chosen via `halo setup` is ignored at runtime.

## 5. Start the server

> **Single-instance lock**: on start the server writes `~/.halo/global/server.lock` (flock when the `flock` command exists, otherwise a pid probe) and removes it on exit. If the process recorded in the lock is still alive, a new server refuses to start and prints a `kill <pid>` hint. The reason: the WeChat long-poll loop is decoupled from the HTTP server, so several processes side by side would fan the same WeChat message out to several sessions. A stale lock (process gone) is detected and cleared automatically. To restart by hand, kill the old one first: `kill $(cat ~/.halo/global/server.lock)`.

Options A and B below run a **source checkout**; for the npm install see [systemd for the npm install](#option-c-systemd-for-the-npm-install).

### Option A: quick start

```bash
cd /path/to/halo/packages/server
HALO_PASSWORD=your_password nohup node dist/index.js > /tmp/server.log 2>&1 &
```

### Option B: systemd

```bash
sudo tee /etc/systemd/system/halo.service <<'EOF'
[Unit]
Description=Halo Server
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/halo/packages/server
ExecStart=/path/to/node dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HALO_PASSWORD=your_password

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now halo
```

### Option C: systemd for the npm install

With `@turmind/halo` installed via npm (see [§8](#8-install-via-npm-recommended)) on Linux with systemd, the simple path is `halo server start -d`. It writes and enables the user unit `~/.config/systemd/user/halo.service` (`Restart=on-failure`, `RestartSec=5`), turns on linger so it starts at boot, and saves your shell's environment to `~/.halo/secrets/server.env` for it. If linger can't be enabled it still starts, and warns `sudo loginctl enable-linger <user>`.

Write the system unit below when you want a system-level unit instead. If `start -d` already made the user unit, `systemctl --user disable --now halo` first, or both start at boot. Once a unit in `/etc/systemd/system/` runs `halo server start` as you (`User=` you, same HOME), `start -d` starts it instead of creating a user unit. The system unit runs the `halo` binary itself — no `WorkingDirectory`, and no `HALO_PASSWORD` once `halo setup` has stored the password hash (run setup as the same user):

```bash
sudo tee /etc/systemd/system/halo.service <<'EOF'
[Unit]
Description=Halo Server
After=network.target

[Service]
Type=simple
User=YOUR_USER
ExecStart=/usr/bin/halo server start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now halo
```

Use `which halo` for the `ExecStart` path (`/usr/bin/halo` with apt / NodeSource Node). Each start prints `[Server] Halo <version> listening on port 9527 on all network interfaces — local: http://localhost:9527` and a network-exposure line to stderr, whatever the log level. For a system unit, look in the journal (`journalctl -u halo`).

Under either unit kind, `halo server stop|restart|status` find the unit that owns the server (the lock pid's cgroup) and go through `systemctl` (`--user` for the user unit). A system unit may need sudo: when polkit refuses, the command prints the exact `sudo systemctl restart|stop halo` line to run. Running that directly is equally valid. `stop` only stops the unit; it starts again at boot until you disable it (`systemctl --user disable halo`, or `sudo systemctl disable halo`). Upgrade with `halo upgrade && halo server restart`.

**Known limits**: the user unit pins the Node binary that ran `start -d` (`process.execPath`), so after an nvm Node upgrade run `halo server restart` once to rewrite it.

### Crash semantics — why `Restart=on-failure` is load-bearing

The server **exits 1 on any uncaught exception** (`process.on('uncaughtException')`
logs the stack, then `exit(1)` after a 100ms drain for queued stdout/WS frames).
It does not try to keep serving: past an unwound handler the process may hold
half-taken locks and half-written files, and since the db is the source of truth
— every daemon (cron / evo ticker / channels) reconciles from it on boot — a
restart is a full recovery while a zombie process silently corrupts state.

So the supervisor is what turns a crash into a ~5s blip: the units above — and
the user unit `halo server start -d` writes — pair `Restart=on-failure` (fires
exactly on non-zero exit) with `RestartSec=5`. Docker deployments want an
equivalent `restart:` policy. Under a bare `nohup
node dist/index.js` / foreground `halo server start` there is still no
supervisor — a crash is a hard stop, with the stack in
`~/.halo/global/logs/server.log` for whoever restarts it.
`unhandledRejection` is only logged, not fatal.

**Off systemd, `halo server start -d` brings its own bounded supervisor** —
on macOS, Windows, Linux without systemd, a HOME that isn't your passwd home,
or a user manager the shell can't reach (on Linux `-d` prints a one-line note
saying which). The detached process `-d` spawns is not the server: it re-execs
`halo server start` (foreground) with `HALO_SUPERVISE=1`, and *that* process
supervises the real server as its child (`packages/cli/src/server-supervisor.ts`).
Policy:

- **Restarts only on failure** — non-zero exit, or death by any signal other
  than `SIGTERM` / `SIGINT`. `SIGKILL` (OOM killer) and `SIGSEGV` count as
  crashes and *are* restarted; the same split systemd's `Restart=on-failure`
  makes. A clean `exit(0)` is never restarted.
- **Bounded**: at most **5 restarts per 5-minute sliding window**, then it gives
  up (exit 1) with a log line telling you to fix the cause and re-run `halo
  server start -d`.
- **2s pause between attempts**, so an instant-crash loop can't spin the CPU.
- Every decision lands in the daemon log as `[respawn] …` — the stdout/stderr
  capture `~/.halo/logs/server.log`, which `halo server logs` tails. Only this
  supervisor writes them; under the user unit a crash restart is systemd's
  `RestartSec=5` (`systemctl --user status halo` shows it).

`halo server stop` (and `--force`) is not mistaken for a crash: it stamps the
server pid into a marker file `~/.halo/global/server.stop` *before* signalling,
and the supervisor stands down when it sees a marker naming the pid it just
lost. Signals alone couldn't carry that intent (on Windows a `SIGTERM` surfaces
as a plain `code 1`), and the marker is also what stops a respawn when `stop`
arrives while the supervisor is mid-backoff. Stamping the pid rather than a bare
flag keeps `restart` unambiguous — the new supervisor can't consume the outgoing
one's marker.

Pid ownership is unchanged: `~/.halo/global/server.lock` is still written and
flock'd by the **server** process itself, so `halo server stop|restart|status`
target the server's own pid (or, for a unit-run server, its unit). The
supervisor has no pidfile of its own; killing it directly leaves the server
running as an orphan (same end state as the pre-supervisor `-d`), and `halo
server stop` still stops it. On a systemd host, `halo server restart` moves a
supervised `-d` server under the user unit.

## 6. Verify

```bash
curl http://localhost:9527/api/health
# expect: {"status":"ok", ...}

curl -s -o /dev/null -w "%{http_code}" http://localhost:9527
# expect: 200
```

Browser: http://localhost:9527

## 7. Redeploy after code changes

```bash
cd /path/to/halo

cd packages/admin && npx next build --no-lint && node scripts/copy-monaco.mjs && cd ../..
pnpm --filter @turmind/halo-server build

# use the pid in the lock file so the old process really exits (an orphan would keep long-polling)
kill $(cat ~/.halo/global/server.lock) 2>/dev/null
sleep 2
cd packages/server && HALO_PASSWORD=your_password nohup node dist/index.js > /tmp/server.log 2>&1 &
```

## 8. Install via npm (recommended)

The whole monorepo is bundled and published to npm as a single package:

```bash
npm install -g @turmind/halo
```

This installs the `halo` binary on `$PATH`. Subcommands available:

| Command | Purpose |
|---|---|
| `halo setup` | Interactive password / port / model keys / optional skills setup |
| `halo setup --non-interactive` (alias `-y`) | Skip every prompt — seed templates only, supply password via `HALO_PASSWORD` env. Use in Dockerfiles / CI. |
| `halo upgrade` | Bump the npm install in place. Compares the bundled version against `npm view @turmind/halo version`; no-op if already latest, otherwise runs `npm install -g @turmind/halo@latest` and prints a server-restart hint. On EACCES, suggests retrying with `sudo`. |
| `halo server start` | Launch HTTP/WS server (foreground). Add `-d` for daemon — on Linux with systemd, a user unit that starts at boot ([Option C](#option-c-systemd-for-the-npm-install)). |
| `halo server stop` / `restart` / `status` / `logs` | Server lifecycle; a unit-run server goes through `systemctl` |
| `halo tui` | Interactive TUI client |
| `halo cli "<prompt>"` | One-shot prompt → reply, exit |
| `halo agents` / `halo sessions` | List agents / sessions |
| `halo acp` | Stdio bridge that lets an ACP client (e.g. Zed / JetBrains) drive a halo server — see [acp-adapter.md](acp-adapter.md) |
| `halo agentcore --workspace <path>` | Foreground A2A server for an Amazon Bedrock AgentCore Runtime container — see [design/agentcore.md](../design/agentcore.md) |

### Upgrade flow

**Knowing there is one.** Settings (bottom of the left sidebar, next to "Halo v<version>") checks npm's `latest` for `@turmind/halo` when Settings is opened — at most once a day, or on **Check for updates** (at most once a minute) — and when a newer release is out shows "New version X", the command below with a copy button, and a Release notes link. It only notifies: nothing is downloaded or installed, and the server never restarts itself. The server reads the registry from `npm_config_registry` when it is an https URL (a mirror), else registry.npmjs.org; it has no proxy support, so a server that reaches the internet only through a proxy shows "Could not check". Source builds show "Source build — not checked"; the desktop app links to the new installer instead. Rules: [design/canvas-extensions.md → Updates](../design/canvas-extensions.md#updates-updatejson).

**Doing it.** Run as the user that installed Halo:

1. `halo upgrade` — bumps the on-disk npm package
2. `halo server restart` (under a user or system unit alike; `sudo systemctl restart halo` also works for a system unit) — server's startup check sees `~/.halo/global/.template-version` is behind the new bundled `TEMPLATE_VERSION`, runs `ensureHaloHome` automatically, then starts (`halo cli` / `halo tui` run the same check on start, so a CLI-only install refreshes without a server). Refreshes `docs/`, built-in agents, built-in skills, system prompts, and the model registry. User-owned files (USER.md, custom agents/skills, INSTRUCTIONS.md overrides) are left alone. See `init.ts` for the per-category overwrite policy.

Under a systemd **system** unit, either step may need sudo: a global npm install under `/usr` fails `halo upgrade` with EACCES (it says to retry with sudo; keep `umask 022`, as in [Local maintenance](#local-maintenance--default-short-path)), and when polkit refuses the restart, `halo server restart` prints the `sudo systemctl restart halo` line to run. Extensions are updated separately, from Settings → Extensions (each one's own update.json; no restart needed).

**1.x → 2.0** (new session store): stop the server → `halo sessions migrate v1 v2 -w <ws>` once per workspace → start it — see [guide/cli.md → Session store migration](../guide/cli.md#session-store-migration-halo-sessions-migrate-v1-v2). On prod, 30 workspaces / 1171 sessions migrated in ~93 s, ~1.6 min of downtime in total. First run `find <ws>/.halo -not -user <service user>`: a root-owned file there fails the migration with `EACCES` (agentcore-workspace did in the 2.0 prod upgrade).

### Public release command reference

Use only for a new public release; the retained details here are not extra preparation for installing an existing version.

1. **Versions**: align the five workspace `package.json` files (`packages/{cli,server,core,admin,desktop}/package.json`) with the tag — the root `package.json` has no version field.
2. **CHANGELOG**: a short version/date summary is enough; keep the existing `[Unreleased]` and compare-link convention without writing a separate release report.
3. **Templates**: bump `TEMPLATE_VERSION` in `packages/server/src/init.ts` when `templates/` changed. `build-bundle.mjs` enforces this against the previous release tag; an unchanged number stops bundling.
4. Commit/tag `vx.y.z`/push within authorization, then build the required artifacts: admin via `pnpm --filter @turmind/halo-admin build` (verify `packages/admin/out/monaco/vs/loader.js`), CLI via `HALO_RELEASE=1 pnpm --filter @turmind/halo-cli bundle`.
5. **npm**: publish from `packages/cli/dist-pub/` **once**, using the intended dist-tag (`--tag alpha` for an alpha, not `latest`). Confirm `npm view @turmind/halo@x.y.z version` and the intended tag via `npm view @turmind/halo dist-tags.alpha` (or `dist-tags.latest` for stable); both must equal the requested version. Registry replication can lag ~2–3 minutes: wait/recheck, never republish. `dist-pub/` is release-only; desktop staging uses `dist-dev/`. Historical reason: a second v1.3.4 publish put `1.3.4-<sha>` on `latest` for ~90s.
6. **GitHub**: `gh release create vx.y.z --notes-from-tag` (or the short CHANGELOG summary); use `--prerelease` for an alpha.
7. **Windows exe**: `(cd packages/desktop && HALO_STAGE_FULL=1 CI=true pnpm dist:win)`, then `gh release upload vx.y.z "packages/desktop/dist/Halo Setup x.y.z.exe"`. Verify it appears in `gh release view vx.y.z --json assets`; v1.3.0 and v1.3.1 missed this asset. macOS dmg is the user's step unless requested.

**npm token gotcha**: `npm publish` on this package needs a granular access token created with **"Bypass 2FA"** checked — scope / permission alone yields `403 Two-factor authentication or granular access token with bypass 2fa enabled is required`. `npm whoami` and `npm token list` succeed with a non-bypass token, so neither is a valid pre-flight; check `GET https://registry.npmjs.org/-/npm/v1/tokens` (with the token as bearer) and look for `"bypass_2fa": true` on the token in use before starting a release.

The published package contains a single bundled JS entry (`dist/index.js`, ~1.7 MB) plus the evo wrapper the server spawns as its own process (`dist/evo-wrapper.js`, ~130 KB; `build-bundle.mjs` fails without it), all built-in templates (agents / skills / prompts / models), bundled platform docs, and the admin Web UI static export. Total install footprint is about 280 MB on disk (`du`; mostly `node_modules`).

Two log files: `~/.halo/logs/server.log` is the stdout/stderr capture of `halo server start -d`, whether the user unit or the off-systemd supervisor runs it (what `halo server logs` tails; the supervisor's `[respawn]` lines appear only off systemd; a system unit logs to the journal instead); `~/.halo/global/logs/server.log` is the server's structured, rotated log (level `general.logging.level`, default `warn`).

### Non-interactive (Docker / CI) details

`halo setup --non-interactive` (alias `-y`) skips every prompt. It only:

- Seeds / refreshes `~/.halo/global/` from the bundled templates (per the per-category overwrite policy in `init.ts`)
- Generates `server.jwt_secret` if missing
- Binds every built-in agent (default / executor / deep-executor plus the internal ones) to the provider named by `HALO_DEFAULT_PROVIDER`, when set (an unknown id only warns)
- For that provider, writes each env-backed key into `~/.halo/secrets/settings.yaml` as a `<<NAME>>` placeholder when `NAME` is set in setup's env (e.g. `DEEPSEEK_API_KEY` → `deepseek.secrets.api_key: "<<DEEPSEEK_API_KEY>>"`) — never the key itself; an unset `NAME` only warns. Bedrock is skipped: the AWS credential chain reads `AWS_*` on its own
- **Does not** set a password — supply one via `HALO_PASSWORD` env
- **Does not** store any literal model key — `HALO_PASSWORD` is the admin password only

The placeholder is expanded on read (see [env.md](env.md)). Without `HALO_DEFAULT_PROVIDER`, or for another provider, write it yourself; e.g. for DeepSeek:

```yaml
deepseek:
  secrets:
    api_key: "<<DEEPSEEK_API_KEY>>"
```

The variable must be set wherever the file is read — the server and `halo cli` / `tui` alike; under systemd add `Environment=DEEPSEEK_API_KEY=…` or an `EnvironmentFile=` to the unit. If you create the file yourself instead of editing the one `halo setup` wrote, `chmod 600` it.

Minimal Dockerfile:

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
RUN npm install -g @turmind/halo
ENV HALO_PASSWORD=changeme HALO_DEFAULT_PROVIDER=deepseek
ENV HALO_PORT=9527
EXPOSE 9527
CMD halo setup -y && halo server start   # key from `docker run -e DEEPSEEK_API_KEY=…`; setup writes its placeholder
```

## 9. Observability (OpenTelemetry collector)

Halo exports traces, metrics and logs over OTLP http/protobuf when `general.observability.endpoint` is set — off by default, no vendor code in the server itself. Point it at any OpenTelemetry collector:

```bash
# settings.yaml (global scope) or via the admin Settings page
general:
  observability:
    endpoint: http://localhost:4318       # collector's OTLP/HTTP port, NOT 4317 (gRPC, unsupported)
    service_name: halo
    headers: ''                            # e.g. authorization=Bearer <token> for a hosted backend
    capture_content: false                 # true to include prompt/completion/tool text on spans
```

All four keys take effect on restart: `halo server restart`.

For a hosted backend (Honeycomb, Grafana Cloud, etc.) use its `https://` OTLP endpoint and put its auth token in `headers` — TLS with CA-signed certs works out of the box. Self-signed / mTLS collectors need the standard `OTEL_EXPORTER_OTLP_CERTIFICATE` / `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` / `OTEL_EXPORTER_OTLP_CLIENT_KEY` env vars.

For routing into AWS CloudWatch / X-Ray (sigv4auth collector config, AgentCore Evaluations) see [design/observability.md](../design/observability.md).

## 10. Optional: Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:9527;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Behind a reverse proxy, set `general.server.trust_proxy: true` in `settings.yaml` (global scope only). Without it, brute-force rate-limiting / lockout resolves the client IP from the direct socket address — which behind a proxy is the proxy's own IP, so every client collapses into one bucket and can't be told apart. Only enable this when the proxy in front is one you control and it rewrites `x-forwarded-for` itself; otherwise a client can forge the header and bypass lockouts. Default is `false` (direct-connect deployments).

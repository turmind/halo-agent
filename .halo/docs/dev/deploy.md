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
sudo sh -c 'umask 022; npm install -g --prefix /usr --no-audit --no-fund "@turmind/halo@$1"' sh "$version"
installed=$(sudo -u ubuntu env HOME=/home/ubuntu /usr/bin/halo --version 2>&1)
test "$installed" = "halo $version"  # CLI writes to stderr; mismatch or launch failure stops before restart
sudo systemctl restart halo.service
curl --fail --retry 10 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:9527/api/health  # status ok, requested version
sudo journalctl -u halo.service --since '2 minutes ago' -n 40 --no-pager
)
```

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

- Node.js ≥ 22
- pnpm ≥ 9
- AWS credentials configured (`~/.aws/credentials` or env vars) with Bedrock access

## 1. Install dependencies and build

```bash
cd /path/to/halo
pnpm install

pnpm --filter @turmind/halo-core build
pnpm --filter @turmind/halo-server build
pnpm --filter @turmind/halo-admin build   # next build + copy-monaco; never a bare next build (Monaco would 404)
```

## 2. Runtime data locations

No directory needs to be created by hand. SQLite databases are created automatically on first use: per-workspace state at `<workspace>/.halo/halo.db`, plus global queues at `~/.halo/global/evo.db`, `~/.halo/global/cron.db` and `~/.halo/global/runs.db`.

## 3. Run `halo setup`

Seeds `~/.halo/global/` with templates (agents, skills, prompts, models, docs), creates `secrets/config.yaml`, and walks you through password / port / model API keys / optional skills.

```bash
halo setup        # interactive — picks up arrow-key UI on TTYs
```

Re-run any time to change the password, refresh model keys, or toggle optional skills. Built-in agent / skill files are force-overwritten on every run; user-created agents and skills are left alone.

For Docker / CI builds where stdin isn't a TTY, see the **Docker** section below.

## 4. Environment variables (optional)

Full list in [env.md](env.md). The most common one is `HALO_PASSWORD`, which acts as a plaintext password and bypasses the scrypt hash stored by `halo setup`. Use it when an external secret store (k8s / systemd / Docker secrets) already protects the value:

```bash
echo 'export HALO_PASSWORD=your_password_here' >> ~/.bashrc
source ~/.bashrc
```

When `HALO_PASSWORD` is set, the password chosen via `halo setup` is ignored at runtime.

## 5. Start the server

> **单实例锁**：server 启动时会写 `~/.halo/global/server.lock`（Linux 用 flock，macOS/Windows 回退到 pid 探测），退出时自动清理。如果 lock 里记录的进程还活着，新 server 会拒绝启动并打印 `kill <pid>` 提示。原因是 WeChat 长轮询循环跟 HTTP server 解耦，多个进程并存会导致同一条微信消息被 fan out 到多个 session。陈旧 lock（进程已不在）会被自动识别并清除。要手动重启先 kill 旧的：`kill $(cat ~/.halo/global/server.lock)`。

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

### Crash semantics — why `Restart=on-failure` is load-bearing

The server **exits 1 on any uncaught exception** (`process.on('uncaughtException')`
logs the stack, then `exit(1)` after a 100ms drain for queued stdout/WS frames).
It does not try to keep serving: past an unwound handler the process may hold
half-taken locks and half-written files, and since the db is the source of truth
— every daemon (cron / evo ticker / channels) reconciles from it on boot — a
restart is a full recovery while a zombie process silently corrupts state.

So the supervisor is what turns a crash into a ~5s blip: the unit above pairs
`Restart=on-failure` (fires exactly on non-zero exit) with `RestartSec=5`.
Docker deployments want an equivalent `restart:` policy. Under a bare `nohup
node dist/index.js` / foreground `halo server start` there is still no
supervisor — a crash is a hard stop, with the stack in
`~/.halo/global/logs/server.log` for whoever restarts it.
`unhandledRejection` is only logged, not fatal.

**`halo server start -d` brings its own bounded supervisor.** The detached
process `-d` spawns is not the server: it re-execs `halo server start`
(foreground) with `HALO_SUPERVISE=1`, and *that* process supervises the real
server as its child (`packages/cli/src/server-supervisor.ts`). Policy:

- **Restarts only on failure** — non-zero exit, or death by any signal other
  than `SIGTERM` / `SIGINT`. `SIGKILL` (OOM killer) and `SIGSEGV` count as
  crashes and *are* restarted; the same split systemd's `Restart=on-failure`
  makes. A clean `exit(0)` is never restarted.
- **Bounded**: at most **5 restarts per 5-minute sliding window**, then it gives
  up (exit 1) with a log line telling you to fix the cause and re-run `halo
  server start -d`.
- **2s pause between attempts**, so an instant-crash loop can't spin the CPU.
- Every decision lands in the daemon log as `[respawn] …`, on the same fds the
  server writes to (`~/.halo/global/logs/server.log`).

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
keep targeting the server exactly as before. The supervisor has no pidfile of
its own; killing it directly leaves the server running as an orphan (same end
state as the pre-supervisor `-d`), and `halo server stop` still stops it.

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

# 用 lock 文件里的 pid 确保旧进程彻底退出（避免孤儿进程继续长轮询）
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
| `halo server start` | Launch HTTP/WS server (foreground). Add `-d` for daemon. |
| `halo server stop` / `restart` / `status` / `logs` | Server lifecycle |
| `halo tui` | Interactive TUI client |
| `halo cli "<prompt>"` | One-shot prompt → reply, exit |
| `halo agents` / `halo sessions` | List agents / sessions |

### Upgrade flow

1. `halo upgrade` — bumps the on-disk npm package
2. `halo server restart` — server's startup check sees `~/.halo/global/.template-version` is behind the new bundled `TEMPLATE_VERSION`, runs `ensureHaloHome` automatically, then starts. Refreshes `docs/`, built-in agents, built-in skills, system prompts, and the model registry. User-owned files (USER.md, custom agents/skills, INSTRUCTIONS.md overrides) are left alone. See `init.ts` for the per-category overwrite policy.

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

The published package contains a single bundled JS entry (~620 KB), all built-in templates (agents / skills / prompts / models), bundled platform docs, and the admin Web UI static export. Total install footprint ≈ 120 MB after npm dedupes shared deps.

### Non-interactive (Docker / CI) details

`halo setup --non-interactive` (alias `-y`) skips every prompt. It only:

- Seeds / refreshes `~/.halo/global/` from the bundled templates (per the per-category overwrite policy in `init.ts`)
- Generates `server.jwt_secret` if missing
- **Does not** set a password — supply one via `HALO_PASSWORD` env

Minimal Dockerfile:

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
RUN npm install -g @turmind/halo
ENV HALO_PASSWORD=changeme
ENV HALO_PORT=9527
EXPOSE 9527
CMD halo setup -y && halo server start
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

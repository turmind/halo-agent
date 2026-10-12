# Logging

File-backed logs: intercepts console, auto-rotates.

File: `packages/server/src/logger.ts`

## Architecture

On startup the logger intercepts `console.log` / `console.error` / `console.warn` / `console.debug`. A call that passes the level gate (`general.logging.level` / `HALO_LOG_LEVEL`, default `warn`) writes to:
1. The original console (stdout/stderr) — live monitoring
2. A disk log file — persistent history
3. The OTel logger, when observability is on (see [design/observability.md](../design/observability.md))

Any `?token=…` value in a message is replaced with `?token=<redacted>` before it reaches a sink.

## Log locations

One file for the whole server: `~/.halo/global/logs/server.log`. A single server process serves many workspaces, so there is no per-workspace log. Cron runs and evolution runs keep their own logs under `~/.halo/global/logs/{cron,evo}/`. `halo server start -d` additionally captures the process's stdout/stderr in `~/.halo/logs/server.log` — via the systemd user unit's `StandardOutput=append:` on Linux with systemd, otherwise via the built-in supervisor, which adds its `[respawn]` lines — that is the file `halo server logs` tails. A system unit's stdout goes to the journal (`journalctl -u <unit>`).

## Log format

```
time=2026-04-19T10:30:00.000Z level=info [Server] Halo 1.6.3 listening on port 9527 on all network interfaces — local: http://localhost:9527
time=2026-04-19T10:30:01.234Z level=error [WS] Chat error: ThrottlingException
time=2026-04-19T10:30:02.567Z level=warn [SessionManager] Context overflow, auto-compacting...
```

Every line is logfmt-flavored: `time=<ISO timestamp> level=<debug|info|warn|error> <message>`; the message keeps its `[Module]` prefix.

### Always-shown lines

The startup banner bypasses the level gate: `logAlways()` (`logger.ts`) writes it straight to stderr whatever `general.logging.level` is, so a foreground `halo server start` at the default `warn` still shows that it came up. It is also written to the log file / OTel as an `info` line, but only when `info` passes the gate. The banner names the real bound address (`formatListenBanner()` in `listen-banner.ts`). The server passes no hostname, so it binds every interface, and the banner says so in two lines:

```
[Server] Halo 1.6.3 listening on port 9527 on all network interfaces — local: http://localhost:9527
[Server] Reachable from the network: allow the port only from trusted sources, or put a TLS reverse proxy in front
```

A specific bound address prints one line, `[Server] Halo <version> listening on http://<addr>:<port>` (IPv6 bracketed). AgentCore mode prints only the first line. Lines printed before `initLogger()` (setup / template-refresh notices, the source-run-only `monorepo root … not found` warning) aren't filtered either, and they never reach the log file.

## Rotation

When the log file exceeds the cap:
1. Delete `server.log.{maxFiles}` (oldest)
2. Shift `server.log.N` → `server.log.N+1`
3. Rename `server.log` → `server.log.1`
4. New `server.log` starts fresh

### Config

| Config key | Default | Env var | Purpose |
|---|---|---|---|
| `logging.max_file_size` (`config.yaml`) | 10 MB | `HALO_LOG_MAX_SIZE` | Rotation threshold |
| `logging.max_files` (`config.yaml`) | 5 | `HALO_LOG_MAX_FILES` | Retained rotated files |
| `general.logging.level` (`settings.yaml`) | `warn` | `HALO_LOG_LEVEL` | Minimum level written: debug \| info \| warn \| error |

Defined in `packages/server/src/config.ts`.

## Initialization

```typescript
import { initLogger } from './logger.js'
initLogger()
```

Called once from `packages/server/src/index.ts` at startup. Steps:
1. Replace console methods with the interceptor
2. Each interceptor calls the original method and appends to the log file (the directory is created on first write)

## Error handling

Log writes use synchronous `fs.appendFileSync` and fail silently — logging must not crash the server.

## Viewing logs

```bash
# live stdout (if started with nohup > /tmp/server.log)
tail -f /tmp/server.log

# file logs (always written, regardless of nohup redirection)
tail -f ~/.halo/global/logs/server.log
```

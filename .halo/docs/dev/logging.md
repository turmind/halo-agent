# Logging

File-backed logs: intercepts console, auto-rotates.

File: `packages/server/src/logger.ts`

## Architecture

On startup the logger intercepts `console.log` / `console.error` / `console.warn`. Every call writes twice:
1. The original console (stdout/stderr) — live monitoring
2. A disk log file — persistent history

## Log locations

| Scenario | Directory | File |
|---|---|---|
| Default (no workspace) | `~/.halo/logs/` | `server.log` |
| Workspace open | `<project>/.halo/logs/` | `server.log` |

When the WS handler receives a `subscribe` or `chat` with `projectId`, it calls `setLogDir()` to switch to the project's log directory.

## Log format

```
2026-04-19T10:30:00.000Z INFO  [Server] Hono server listening on http://localhost:9527
2026-04-19T10:30:01.234Z ERROR [WS] Chat error: ThrottlingException
2026-04-19T10:30:02.567Z WARN  [Orchestrator] Context overflow, auto-compacting...
```

Every line: `ISO timestamp` + `level (INFO/ERROR/WARN)` + `message`.

## Rotation

When the log file exceeds the cap:
1. Delete `server.log.{maxFiles}` (oldest)
2. Shift `server.log.N` → `server.log.N+1`
3. Rename `server.log` → `server.log.1`
4. New `server.log` starts fresh

### Config

| Config key | Default | Env var | Purpose |
|---|---|---|---|
| `logging.maxFileSize` | 10 MB | `HALO_LOG_MAX_SIZE` | Rotation threshold |
| `logging.maxFiles` | 5 | `HALO_LOG_MAX_FILES` | Retained rotated files |

Defined in `packages/server/src/config.ts`.

## Initialization

```typescript
import { initLogger } from './logger.js'
initLogger()
```

Called once from `packages/server/src/index.ts` at startup. Steps:
1. Create the log directory
2. Replace console methods with the interceptor
3. Each interceptor calls the original method and appends to the log file

## Workspace switching

```typescript
import { setLogDir } from './logger.js'
setLogDir('/path/to/project')
```

Called from `packages/server/src/ws/handler.ts` when the client subscribes to a workspace.

## Error handling

Log writes use synchronous `fs.appendFileSync` and fail silently — logging must not crash the server.

## Viewing logs

```bash
# live stdout (if started with nohup > /tmp/server.log)
tail -f /tmp/server.log

# file logs (always written, regardless of nohup redirection)
tail -f ~/.halo/logs/server.log

# project-specific logs
tail -f /path/to/your-project/.halo/logs/server.log
```

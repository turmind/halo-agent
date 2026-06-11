# Terminal — Requirements

xterm.js terminal with a node-pty backend, multi-tab, reconnect-resilient.

## Core behaviour

### Multi-tab
- Each tab owns an independent PTY
- Every terminal has a unique `terminalId` for routing
- Tabs close independently
- All tabs on a client share one WebSocket connection (multiplexed by `terminalId`)

### Working directory

| Scenario | Initial cwd |
|---|---|
| Default workspace terminal | Current project's workspace root (`activeProject.path`) |
| Skill mini-workspace terminal | The skill directory (cwd prop passed by caller) |
| No workspace bound | `?folder=` URL param, falling back to server `$HOME` |

Derivation in [packages/admin/src/features/terminal/terminal-panel.tsx:108](../../../packages/admin/src/features/terminal/terminal-panel.tsx#L108); backend resolution in [packages/server/src/ws/terminal-manager.ts:46](../../../packages/server/src/ws/terminal-manager.ts#L46).

Workspace switch does **not** migrate existing terminals — they keep their original cwd. Close and reopen to pick up the new workspace root.

### Reconnect resilience

When the WebSocket drops:

1. PTYs are **not killed** — they move into a module-level `detachedTerminals` pool (`packages/server/src/ws/terminal-manager.ts`)
2. Output during detach is buffered (ring buffer, up to `config.limits.terminalOutputBuffer` = 50 KB per terminal)
3. Grace period: `config.timeout.terminalGrace` (default 5 min)
4. On reconnect, the client sends `terminal:reattach` (sent on initial mount **and** on every subsequent `_connected` event)
5. Server replays the entire output buffer, reattaches live I/O, and responds with `terminal:reattached { terminalIds: [...] }`
6. If the grace timer expires first, the PTY is killed and the detach entry removed

Connection-level liveness and reconnect (server keepalive tolerance, client self-check timer, auth-expiry handling) are owned by the shared WS client — see [design/ws.md](../design/ws.md#client-side-liveness--reconnect).

On the reattach handler ([packages/admin/src/features/terminal/terminal-panel.tsx](../../../packages/admin/src/features/terminal/terminal-panel.tsx)), each id in `terminalIds` is dispatched by whether a local xterm instance already exists:

- **Already exists** (typical after a transient WS reconnect): only a `terminal:resize` is sent so server PTY dimensions resync; the existing instance keeps its scrollback and continues receiving live output.
- **Does not exist** (first mount, or the previous instance was disposed): a fresh xterm container is created and bound to that id. Bracketed paste mode is resynced by locally writing `\x1b[?2004h` into the new instance — bash enabled the mode on the PTY at spawn time, but that sequence went to the disposed instance; without the resync, a multi-line paste into the reattached terminal would be sent unbracketed and execute line by line.

### Environment
- Shell: `$SHELL` or `/bin/bash`
- Terminal type: `xterm-256color`
- Default size: 80 × 24 (resize requests override)
- Strips `npm_config_prefix` env (avoids nvm warnings when starting node)

### Lifecycle

```
          ┌─────────────┐
create ──▶│ in this WS  │
          │ session map │
          └──────┬──────┘
                 │ WS drops
                 ▼
          ┌─────────────┐
          │  detached   │  (grace timer = 60s, ring buffer active)
          │    pool     │
          └──┬───────┬──┘
   reattach  │       │  grace expires
             ▼       ▼
       ┌─────────┐  kill PTY, clean up
       │ replay +│
       │ live IO │
       └─────────┘
```

Close semantics:
- Explicit `terminal:close` — PTY killed immediately, detach entry (if any) cleaned up
- WS drop → 60 s no reattach → PTY killed
- Server shutdown — all PTYs die with the process

## WebSocket protocol

| Direction | Type | Fields | Purpose |
|---|---|---|---|
| C→S | `terminal:start` | `terminalId?`, `cwd?`, `cols?`, `rows?` | Spawn a new PTY |
| C→S | `terminal:input` | `terminalId`, `data` | Send user keystrokes |
| C→S | `terminal:resize` | `terminalId`, `cols`, `rows` | Resize PTY (screen resize) |
| C→S | `terminal:close` | `terminalId` | Explicit close |
| C→S | `terminal:reattach` | — | Reattach all detached terminals after reconnect |
| S→C | `terminal:ready` | `terminalId` | PTY spawned and ready |
| S→C | `terminal:output` | `terminalId`, `data` | PTY stdout/stderr |
| S→C | `terminal:exit` | `terminalId`, `exitCode` | PTY exited |
| S→C | `terminal:reattached` | `terminalIds` | Reattach completed for these |

Source: [packages/server/src/ws/terminal-manager.ts](../../../packages/server/src/ws/terminal-manager.ts).

## Config

| Config key | Default | Purpose |
|---|---|---|
| `config.timeout.terminalGrace` | 300,000 ms | Detach retention period |
| `config.limits.terminalOutputBuffer` | 50,000 bytes | Detach output ring buffer cap |

Defined in [packages/server/src/config.ts](../../../packages/server/src/config.ts).

## Test cases

| # | Scenario | Expected |
|---|---|---|
| T1 | Start, run `ls` | Output arrives; prompt returns |
| T2 | Start in skill mini-workspace | cwd is the skill directory (`pwd` confirms) |
| T3 | Resize window | PTY cols/rows update; long-running process (e.g. `watch ls`) reflows |
| T4 | Disconnect mid-command (`sleep 5 && echo done`) → reconnect within grace period | Buffered output replayed; `done` visible |
| T5 | Disconnect → wait > grace period → reconnect | Terminal gone (PTY killed at grace expiry) |
| T6 | Open 3 tabs, close 1 explicitly | Other 2 keep their PTYs; closed one gets `terminal:exit` |
| T7 | `exit` from within shell | `terminal:exit` with exitCode=0; tab shows closed |
| T8 | Paste a 10 KB block | Sent as `terminal:input` without choking; shell echoes in chunks |

Follows the pattern of [test/session.md](../test/session.md).

## Related design

- Detach / reattach plumbing: [design/architecture.md#terminalmanager](../design/architecture.md#terminalmanager--pty-management)
- WS envelope shape: [design/ws.md](../design/ws.md)

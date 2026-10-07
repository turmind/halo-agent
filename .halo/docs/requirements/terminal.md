# Terminal — Requirements

xterm.js terminal with a node-pty backend, multi-tab, reconnect-resilient.

## Core behaviour

### Multi-tab
- Each tab owns an independent PTY; the first one is spawned only when the Terminal tab is first opened
- Every terminal has a unique `terminalId` for routing
- Tabs close independently
- All tabs on a client share one WebSocket connection (multiplexed by `terminalId`)
- The tab list is a column of Chrome-style **vertical tabs** on the right of the terminal (same `VerticalTabRow` / `ResizableSidebar` components as the chat session tabs). Each row has a terminal icon and its name, and a ✕ that closes just that terminal; it appears on hover only, and not at all while a single terminal is left. A "+" at the bottom opens a new terminal
- The list can be **resized** by dragging its left edge (120–480px, default 160px), and **collapsed** to a `w-10` rail of square icons with a "+" at the bottom. Both settings persist globally in `localStorage` (`halo_terminal_sidebar_open`, `halo_terminal_sidebar_width`)

### Working directory

| Scenario | Initial cwd |
|---|---|
| Default workspace terminal | Current project's workspace root (`activeProject.path`) |
| Explorer context menu → open in terminal | A new terminal in the right-clicked folder (or the file's parent) |
| No workspace bound | `?folder=` URL param, falling back to server `$HOME` |

Derivation in `createTerminal` in [packages/admin/src/features/terminal/terminal-panel.tsx](../../../packages/admin/src/features/terminal/terminal-panel.tsx); backend resolution in `TerminalManager.start` in [packages/server/src/ws/terminal-manager.ts](../../../packages/server/src/ws/terminal-manager.ts).

Workspace switch reloads the page and does **not** migrate existing terminals — they keep their original cwd and are only reattached in their own workspace (within the grace period); the new workspace starts a fresh terminal at its root.

### Reconnect resilience

When the WebSocket drops:

1. PTYs are **not killed** — they stay in the module-level `terminals` map with `currentWs = null` (`packages/server/src/ws/terminal-manager.ts`)
2. Output during detach is buffered (ring buffer, up to `config.limits.terminalOutputBuffer` = 50 KB per terminal)
3. Grace period: `config.timeout.terminalGrace` (default 5 min)
4. On reconnect, the client sends `terminal:reattach` with its `browserId` and workspace path (sent on initial mount **and** on every subsequent `_connected` event); only PTYs of that browser × workspace are claimed
5. Server replays the entire output buffer, reattaches live I/O, and responds with `terminal:reattached { terminalIds: [...] }`
6. If the grace timer expires first, the PTY is killed and the detach entry removed

Connection-level liveness and reconnect (server keepalive tolerance, client self-check timer, auth-expiry handling) are owned by the shared WS client — see [design/ws.md](../design/ws.md#client-side-liveness--reconnect).

When the WS drops, the bottom panel remounts `TerminalPanel` (fresh key on `_disconnected`): local xterm instances are disposed without sending `terminal:close`, and the new panel reattaches like a page load. The local scrollback is lost; the server replays only what was buffered while detached. On the reattach handler ([packages/admin/src/features/terminal/terminal-panel.tsx](../../../packages/admin/src/features/terminal/terminal-panel.tsx)), each id in `terminalIds` is dispatched by whether a local xterm instance already exists:

- **Already exists** (a reattach without a remount): only a `terminal:resize` is sent so server PTY dimensions resync; the existing instance keeps its scrollback and continues receiving live output.
- **Does not exist** (first mount, or after the remount above): a fresh xterm container is created and bound to that id. Bracketed paste mode is resynced by locally writing `\x1b[?2004h` into the new instance — bash enabled the mode on the PTY at spawn time, but that sequence went to the disposed instance; without the resync, a multi-line paste into the reattached terminal would be sent unbracketed and execute line by line.

### Environment
- Shell: `$SHELL` or `/bin/bash` (`ComSpec` / `powershell.exe` on Windows); bash / zsh / sh / fish start as login shells (`-l`)
- Terminal type: `xterm-256color`
- Default size: 80 × 24 (resize requests override)
- Strips `npm_config_prefix` env (avoids nvm warnings when starting node)
- Font: JetBrains Mono 13px, line height 1 (no extra leading — box-drawing / TUI rows join up)

### Copy & paste
Keys depend on the client's OS (the keyboard in front of the user — the PTY is always the server's):

| Client | Copy | Paste |
|---|---|---|
| macOS | `Cmd+C` | `Cmd+V` |
| Windows / Linux | `Ctrl+C` **with a selection** (copies and clears the selection; no selection → `^C` / SIGINT as usual) · `Ctrl+Shift+C` | `Ctrl+V` · `Ctrl+Shift+V` (literal `^V` is given up) |

- Keyboard copy / paste ride the browser's native copy / paste events (paste stays bracketed), so they work on a plain-http origin too
- **Right-click menu** (inside the terminal): Copy (disabled with no selection) · Paste · Select all · Clear. Menu copy / paste use the async Clipboard API; when paste is refused (plain-http origin or no clipboard-read permission) the menu says to use the keyboard shortcut instead
- Key mapping: `terminalClipboardKey` in [packages/admin/src/features/terminal/terminal-clipboard.ts](../../../packages/admin/src/features/terminal/terminal-clipboard.ts); menu in `terminal-context-menu.tsx`

### Lifecycle

```
          ┌─────────────┐
create ──▶│ in this WS  │
          │ session map │
          └──────┬──────┘
                 │ WS drops
                 ▼
          ┌─────────────┐
          │  detached   │  (grace timer = 5min, ring buffer active)
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
- WS drop → grace expires (default 5 min) without reattach → PTY killed
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
| `config.limits.terminalOutputBuffer` (setting `general.limits.terminal_scrollback_bytes`) | 50,000 bytes | Detach output ring buffer cap |

Defined in [packages/server/src/config.ts](../../../packages/server/src/config.ts).

## Test cases

| # | Scenario | Expected |
|---|---|---|
| T1 | Start, run `ls` | Output arrives; prompt returns |
| T2 | Explorer → right-click a folder → Open in Integrated Terminal | A new terminal whose cwd is that folder (`pwd` confirms) |
| T3 | Resize window | PTY cols/rows update; long-running process (e.g. `watch ls`) reflows |
| T4 | Disconnect mid-command (`sleep 5 && echo done`) → reconnect within grace period | Buffered output replayed; `done` visible |
| T5 | Disconnect → wait > grace period → reconnect | Terminal gone (PTY killed at grace expiry) |
| T6 | Open 3 tabs, close 1 explicitly | Other 2 keep their PTYs; closed one gets `terminal:exit` |
| T7 | `exit` from within shell | `terminal:exit` with the shell's exit code; the terminal prints `[Process exited]` and its tab stays until closed |
| T8 | Paste a 10 KB block | Sent as `terminal:input` without choking; shell echoes in chunks |
| T9 | Windows/Linux: select text → `Ctrl+C`; then `Ctrl+C` again with nothing selected | First copies and clears the selection; second sends `^C` (interrupts a running `sleep 30`) |
| T10 | Right-click in the terminal → Paste | Clipboard text inserted at the prompt (or the "use the shortcut" hint on a plain-http origin) |

Follows the pattern of [test/session.md](../test/session.md).

## Related design

- Detach / reattach plumbing: [design/architecture.md#terminalmanager](../design/architecture.md#terminalmanager--pty-management)
- WS envelope shape: [design/ws.md](../design/ws.md)

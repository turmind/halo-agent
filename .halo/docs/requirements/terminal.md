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

Workspace switch reloads the page and does **not** migrate existing terminals — they keep their original cwd and are reattached only in their own workspace; the new workspace shows its own terminals, or starts a fresh one at its root if it has none.

### Shared, persistent terminals

A workspace's terminals belong to the workspace, not to a browser: the admin has one login, so every page that opens the workspace — another tab, another browser, another device — sees and drives the same terminals.

- **Persistence**: a PTY ends only when it is closed with ✕, when its shell exits, or when the server restarts. Closing the browser, losing the connection, or leaving for days doesn't end it — there is no grace timer.
- **Full restore**: the server mirrors each PTY into a headless xterm (`@xterm/headless`). A page that attaches gets a serialized snapshot of it (`@xterm/addon-serialize`): the scrollback (`general.limits.terminal_scrollback_lines`, default 5000 lines), the screen, a full-screen program's alternate screen (vim, htop), and the terminal modes — bracketed paste, application cursor keys, mouse tracking and SGR mouse encoding, hidden cursor. Output made while nobody was attached is part of the snapshot.
- **Live sync**: every attached page receives the output and can type; all input goes to the one PTY.
- **Close everywhere**: ✕ on any page sends `terminal:close` and the PTY ends; every attached page gets `terminal:exit` and prints `[Process exited]`.
- **Size**: the PTY follows its *driver*, the page that last typed into it. Each page reports its size (`terminal:resize`); when a page types and its size differs from the PTY's, the PTY (and the mirror) switch to that size. A resize from a page that isn't the driver is only recorded, unless no driver is attached any more — then it applies at once. Pages with a different size than the driver see the driver's layout reflowed into their own width.

### Reconnect resilience

1. On mount (once the workspace is known — with split view on, the panel mounts before the page has resolved its workspace) **and** on every `_connected`, the panel sends `terminal:reattach { workspacePath }`. The server attaches the connection to every PTY of that workspace and subscribes it to the workspace
2. The server answers `terminal:reattached { terminals: [{ id, name }] }`, then one `terminal:snapshot` per PTY, then live `terminal:output`. Snapshot and live stream join exactly: output that arrives while a snapshot is being taken is queued for that page and sent right after it — nothing lost, nothing repeated
3. A PTY another page starts later is pushed to every subscribed page as `terminal:opened { terminalId, name }` + its snapshot — no polling
4. When a connection closes, the server only removes it from the PTYs' attached sets and from the workspace subscription; no timer is started

Connection-level liveness and reconnect (server keepalive tolerance, client self-check timer, auth-expiry handling) are owned by the shared WS client — see [design/ws.md](../design/ws.md#client-side-liveness--reconnect).

When the WS drops, the bottom panel remounts `TerminalPanel` (fresh key on `_disconnected`): local xterm instances are disposed without sending `terminal:close`, and the new panel reattaches like a page load — its screen comes back from the snapshots. In the panel ([packages/admin/src/features/terminal/terminal-panel.tsx](../../../packages/admin/src/features/terminal/terminal-panel.tsx)):

- `terminal:reattached` / `terminal:opened`: a tab is added for each id not shown yet, named as the server says (the name the creating page gave in `terminal:start`).
- `terminal:snapshot`: the local xterm (created if missing) is `reset()`, sized to the snapshot's `cols × rows`, given the snapshot, then fit to its container; the fitted size is reported with `terminal:resize`.
- If 2 s after the connection is up the panel still has no terminal, it starts one (the timer is armed only while connected, so an outage doesn't add a PTY per remount).

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

### Local echo (predictive)
Keystrokes show up before the server's echo comes back, so typing over a slow link doesn't lag. This is a port of VS Code's terminal type-ahead ([packages/admin/src/features/terminal/type-ahead/](../../../packages/admin/src/features/terminal/type-ahead/)), and it is always on. No setting turns it off.

- A predicted character is drawn **dim**. When the PTY echoes the same character, it is redrawn normally. When the PTY sends something else, the prediction is rolled back: the original cell and cursor come back, then the real output is written. This happens, for example, when another page typed into the same terminal first (see Shared, persistent terminals). No residue is left.
- Predicted keys: printable characters, Backspace, ←/→ (also `Esc b` / `Esc f`), and Enter when the cursor isn't on the last row. Any other key ends prediction until the PTY answers: Tab, ↑/↓, Ctrl-keys and the like. This is why **Tab completion and history paging are not predicted**.
- The first keystroke on a line is drawn only after the PTY has echoed one. A prompt that doesn't echo starts nothing.
- Not predicted:
  - while the title names `vim`, `vi`, `nano` or `tmux`;
  - in any full-screen program on the alternate screen (htop, less in full-screen mode…);
  - at a `less`-style `:` prompt on the bottom row.
- A prediction the PTY never echoes is withdrawn after a timeout: at least 500 ms, or 1.5 × the slowest confirmed echo, whichever is longer. **Password prompts**: if the prompt is on a line where echo was already confirmed, a typed character may flash dim and then be withdrawn. At a fresh prompt nothing is drawn.
- A `terminal:snapshot` drops all pending predictions without rolling them back, because the snapshot replaces the whole screen.

### Lifecycle

```
               terminal:start
                     │
                     ▼
   ┌──────────────────────────────────┐   page attaches
   │ PTY + headless mirror            │◀── (reattach / opened):
   │ attached pages: 0..n             │    snapshot, then live
   │ (output + exit go to all)        │
   └──┬──────────────┬─────────────┬──┘
      │ page leaves  │ ✕ / shell   │ server
      │ (WS drops)   │ exits       │ restart
      ▼              ▼             ▼
   still running   exit to all   gone
   (0 pages ok,    pages, PTY
    no timer)      removed
```

Close semantics:
- Explicit `terminal:close` (✕ on any page) — PTY killed immediately; every attached page gets `terminal:exit`
- The shell exits by itself — every attached page gets `terminal:exit` with its exit code
- Server shutdown — all PTYs die with the process
- WS drop / browser closed — **not** an end: the PTY keeps running with no page attached, for as long as it takes

## WebSocket protocol

| Direction | Type | Fields | Purpose |
|---|---|---|---|
| C→S | `terminal:start` | `terminalId?`, `cwd?`, `cols?`, `rows?`, `workspacePath?`, `name?` | Spawn a new PTY in the workspace; `name` is the tab name every page shows. Pushed to the workspace's other subscribers |
| C→S | `terminal:input` | `terminalId`, `data` | Send user keystrokes; makes the sender the PTY's size driver. Rejected without `terminalId` |
| C→S | `terminal:resize` | `terminalId`, `cols`, `rows` | Report this page's size; applied if it is the driver or no driver is attached. Rejected without `terminalId` |
| C→S | `terminal:close` | `terminalId` | Explicit close — ends the PTY for every page |
| C→S | `terminal:reattach` | `workspacePath` | Attach to every PTY of the workspace and subscribe to it |
| S→C | `terminal:ready` | `terminalId` | PTY spawned and ready (to its creator) |
| S→C | `terminal:output` | `terminalId`, `data` | PTY stdout/stderr, to every attached page |
| S→C | `terminal:exit` | `terminalId`, `exitCode` | PTY ended (close or shell exit), to every attached page |
| S→C | `terminal:reattached` | `terminals: [{ id, name }]` | The workspace's PTYs, all now attached; a snapshot follows for each |
| S→C | `terminal:opened` | `terminalId`, `name` | Another page started a PTY in a subscribed workspace; a snapshot follows |
| S→C | `terminal:snapshot` | `terminalId`, `data`, `cols`, `rows` | Serialized scrollback + screen + modes at attach time, taken at `cols × rows`; live output continues right after it |

Source: [packages/server/src/ws/terminal-manager.ts](../../../packages/server/src/ws/terminal-manager.ts).

## Config

| Config key | Default | Purpose |
|---|---|---|
| `config.limits.terminalScrollbackLines` (setting `general.limits.terminal_scrollback_lines`) | 5000 lines | Scrollback the server-side mirror keeps per terminal (restored on attach); applies to terminals opened after a change |

`timeout.terminal_grace` / `HALO_TERMINAL_GRACE` and `general.limits.terminal_scrollback_bytes` are gone; a value left in an existing `config.yaml` / `settings.yaml` is ignored.

Defined in [packages/server/src/config.ts](../../../packages/server/src/config.ts).

## Test cases

| # | Scenario | Expected |
|---|---|---|
| T1 | Start, run `ls` | Output arrives; prompt returns |
| T2 | Explorer → right-click a folder → Open in Integrated Terminal | A new terminal whose cwd is that folder (`pwd` confirms) |
| T3 | Resize window | PTY cols/rows update; long-running process (e.g. `watch ls`) reflows |
| T4 | Disconnect mid-command (`sleep 5 && echo done`) → reconnect | Screen restored from the snapshot: scrollback from before the drop plus `done` |
| T5 | Disconnect (or close the browser) → come back hours later | The terminal is still there, scrollback and running programs intact |
| T5b | Run `vim` (or `htop`) → refresh the page | vim's screen is back as it was; keys and mouse work in it; after `:q` the shell's scrollback is back |
| T5c | Open the same workspace in two browsers | Both show the same terminals; typing in either shows on both; ✕ in one prints `[Process exited]` in both |
| T5d | Open a terminal in browser A while B has the workspace open | B gets the new tab with A's name, live |
| T5e | Open the workspace on another device | Same terminals with their full scrollback; another workspace's terminals don't appear |
| T5f | Two browsers with different window sizes, type in the narrow one, then in the wide one | `stty size` follows whoever typed last |
| T6 | Open 3 tabs, close 1 explicitly | Other 2 keep their PTYs; closed one gets `terminal:exit` |
| T7 | `exit` from within shell | `terminal:exit` with the shell's exit code; the terminal prints `[Process exited]` and its tab stays until closed |
| T8 | Paste a 10 KB block | Sent as `terminal:input` without choking; shell echoes in chunks |
| T9 | Windows/Linux: select text → `Ctrl+C`; then `Ctrl+C` again with nothing selected | First copies and clears the selection; second sends `^C` (interrupts a running `sleep 30`) |
| T10 | Right-click in the terminal → Paste | Clipboard text inserted at the prompt (or the "use the shortcut" hint on a plain-http origin) |
| T11 | Over a slow link (e.g. 300 ms RTT), type `ls -la` after a first confirmed character | Characters appear at once, dim. They turn normal as the echo arrives. Backspace and ←/→ are instant too |
| T12 | Two browsers on one terminal, type different characters in both at the same moment | Each page ends up showing exactly what the shell echoed. A dim prediction from the losing page is rolled back with no stray character left |
| T13 | Type in `vim`, `nano`, `tmux`, `htop`, `less` | Nothing is drawn ahead of the program's own output |
| T14 | `sudo -k; sudo true`, then type the password | Nothing stays on screen. At most a dim character flashes and is withdrawn within about 0.5 s |
| T15 | Type, then Tab to complete or ↑ for history | The completion or history entry appears only when the shell sends it. The characters typed before it are kept |

Follows the pattern of [test/session.md](../test/session.md).

## Related design

- Attach / snapshot plumbing: [design/architecture.md#terminalmanager](../design/architecture.md#terminalmanager--pty-management)
- WS envelope shape: [design/ws.md](../design/ws.md)

# Explorer — Requirements

VS Code-style file tree sidebar with multi-select, drag-drop, right-click menu.

## Workspace switching

### Initialization
- URL `?folder=/abs/path` → use that directly as workspace
- No `?folder` → reopen the last workspace (`halo_last_folder` in localStorage); if none is stored or it no longer resolves, fall back to `GET /api/fs/home`. Either way the path is written back into the URL; UI behaves identically
- The path is resolved through `POST /api/fs/workspace/resolve`, which rejects non-directories and filesystem roots and seeds the workspace's `.halo/` scaffold
- There's always a valid workspace; every frontend feature (file tree / sessions / agents / settings) depends on it

### Path input
- Explorer top bar has a path input + 📁🔍 picker button
- Pressing Enter calls `GET /api/fs/exists?path=...` first — a miss (or a non-directory) shows an alert, no switch
- **Recent-workspaces dropdown**: focusing the input shows the most-recently-used list; typing filters it by substring. The current workspace is left out. Each row shows the folder name + full path; clicking one switches to it; a hover "×" removes a single entry. Entries are recorded only after a switch validates the path (so invalid paths never land), in canonical resolved form, MRU-ordered and deduped, capped at 8. Persisted in localStorage (`halo_recent_workspaces`)

### Desktop windows (multi-window)
Desktop app only — the browser has one tab per window natively.
- **New window**: `Cmd+N` (macOS, via the File menu) / `Ctrl+N` (Windows/Linux, bound at the webContents level since those platforms have no app menu). Each window is a fresh view onto the **one shared local server** — no second server process spawns.
- **Per-window workspace**: windows share the server origin, hence one localStorage, so a window tracks its own workspace via its URL `?folder=` (not localStorage, which would clobber across windows). Different windows can sit on different workspaces; the same workspace can be open in two windows.
- **Quit semantics** (platform split): on macOS, closing every window keeps the app in the Dock (only `Cmd+Q` truly exits) and clicking the Dock icon reopens a window; on Windows/Linux there's no Dock to resummon from, so closing the last window quits.
- **Quick toggles entry** (bottom of the activity bar, below Settings; browser and desktop): a gear with a thin segmented status bar under it — one segment per available item, in fixed order network → notify → pin → keep-awake (browser: network + notify, or network alone without the Web Notification API; desktop: all four). Network segment: emerald = fresh, pulsing amber = stale, red = down (the gear itself also turns red when down); notify / pin segments: primary when on; keep-awake: amber when on (it stops the screen locking, so it gets its own colour); off = dimmed muted grey. The native hover title lists every item's state. Clicking opens a panel (titled "Status & window") to the right of the entry: a read-only network row, then one switch row per toggle; switches apply immediately and the panel stays open; outside click, Esc or a second entry click closes it. Segments, rows and the hover summary all come from one item list (`useQuickToggleItems` in `features/workspace/quick-toggles.tsx`).
- **Pin (always-on-top)** acts per-window — each window pins independently.
- **Keep screen awake** (desktop only) acts per-window and isn't persisted — a restart or a new window starts off, a reload keeps it. While any opted-in window is neither minimized nor hidden (merely covered by other windows still counts), the app holds one display-sleep blocker, so the screen won't dim or lock when you step away.
- **Activity awareness**: while the agent streams a reply the sidebar's workspace name carries an amber pulsing dot (emerald when idle) and the window title gains a `●` prefix (`● Halo — <name>` busy vs `Halo — <name>` idle) — both are plain web behaviour that Electron mirrors to the native title bar.
- **Finish notification** (works in both the desktop app and a plain browser): an opt-in toggle in the quick-toggles panel, **off by default**, persisted per-machine in localStorage (`halo_notify_on_finish`). It's shown whenever a notification can be raised — the desktop shell (`window.haloNotify` bridge) or a browser with the Web Notification API; turning it on in a browser requests Notification permission from within the toggle click (the required user gesture). When on, a turn finishing in **any loaded chat tab** — on screen or in the background — triggers two decoupled cues (sessions no tab has loaded, or released by a reconnect, never ring; tab switches and snapshot replays aren't completions; queued messages drained back to back ring once, after the last one): a **self-synthesized WebAudio chime** that always plays (regardless of focus — an audible "it's done" even while you're watching the tab, and not subject to the OS per-site notification-sound setting), plus — **only when the window is unfocused** — a banner (desktop: native notification + Dock bounce / taskbar flash; browser: a Web Notification whose click refocuses the tab) whose body names the session by its title ("“<title>” finished responding."; generic text if the title isn't known). Focused → chime only, no banner.

### Directory picker (FolderPicker modal)
Visual directory browser opened by the 📁🔍 button:
- Top: breadcrumb input (paste paths here) + ⬆ up + 🏠 home
- Middle: `GET /api/fs/browse?path=...` pulls the current directory's children
  - Drops entries starting with `.`
  - Single click = select (updates the current path only)
  - Double click = enter
- Bottom: Cancel / Open. Open triggers the same switch flow as Enter (including existence check).

## Core behaviour

### File tree (lazy)
- Root level: `GET /api/files/tree?projectId=xxx` returns only the first level
- Subdirectories: only fetched on expand via `?path=<subdir>`
- Every directory node carries `hasChildren: boolean` so the arrow renders correctly
- Directories first, alphabetical
- Hides only well-known noise: `.git`, `.DS_Store`, `node_modules`, `__pycache__`. Other dotfiles (`.gitignore`, `.env`, `.vscode/` etc.) are shown — modern IDE convention
- No max depth limit
- Expansion state lives in localStorage; restored on refresh and lazily reloaded
- WebSocket `file:changed` events incrementally update loaded branches; unloaded branches are left alone (re-fetched on expand)
- **Reconnect reconciliation**: because the tree is kept in sync purely by `file:changed` deltas, events missed while the socket was down (laptop lid, network drop) would leave it stale forever. On WS *re*connect (not first connect) the root level is silently refetched; expanded directories self-heal because their fresh nodes come back without children, which re-arms the lazy-load along the persisted expanded-paths spine

### Selection model
VS Code-style highlight selection (no checkboxes):
- **Click**: select and highlight; a file also opens in the editor after a short (300 ms) delay, a folder toggles open/closed
- **Double click**: open the file in an editor tab right away (cancels the delayed open)
- **Bundle directory** (a folder whose suffix an installed bundle extension claims, e.g. `Standup.htrans/`, shown with a package icon): click, double-click or Enter **opens** it in its extension like a file; only the chevron expands it
- **Ctrl/Cmd + click**: toggle multi-select
- **Shift + click**: range select

### Drag-move
- Selected files/folders drag onto a target dir
- Multi-file drag supported
- Each file goes through `POST /api/files/rename` with `{oldPath, newPath}`
- Moving (also deleting / renaming) a bundle directory — or a folder containing one — whose tab is busy (e.g. recording) first asks the "Close anyway?" confirm; on OK the tab is closed before the file operation, on Cancel nothing happens
- **Spring-loaded expand** (applies to both tree-internal drags and OS-file drops): a collapsed folder does **not** expand the moment a drag passes over it — it unfolds only after the drag hovers on it for ~600ms (VSCode/Finder behaviour; the timer cancels on drag-leave). Dropping into a collapsed folder expands it immediately to show the result

### Right-click menu

Items shown depend on the click target. With several items selected the menu offers only Delete; on the workspace root row only New File / New Folder / Open in Integrated Terminal / Reveal in File Manager apply:

| Action | Shown when | API / behavior |
|---|---|---|
| New File / New Folder | Always | `POST /api/files/new` · `mkdir`; auto-expands the parent folder so the inline input is visible. A New File name ending in a bundle suffix (`Standup.htrans`) creates the bundle **directory** and opens it |
| Open in Integrated Terminal | Always | Spawns a terminal at the target dir (or file's parent) |
| Reveal in File Manager | Desktop app only | Opens the OS file manager (Finder / Explorer / Linux FM) at the target — a folder opens itself, a file is highlighted in its parent dir. Hidden in a plain browser (gated on the `window.haloReveal` IPC bridge exposed by the desktop preload) |
| Open to the Side | File or bundle directory | Splits the editor and opens the file (or bundle) in the right pane |
| Download | File only | `GET /api/files/download?path=...` |
| Rename | Single file/folder | `POST /api/files/rename` |
| Delete | Single or multi-select | `DELETE /api/files?path=...` (with confirm) |
| Open as Workspace | Folder only | Switches the active workspace to that folder, reusing the path-input switch flow (validate → persist → reload). Shown at the bottom of the menu |

The menu auto-clamps to the viewport, so right-clicking near the window edge does not clip the bottom items.

### Modification indicator
Files with unsaved editor edits show a coloured dot in the tree (synced from `editorStore.modifiedPaths`).

### Git decorations
When the workspace is a git repo, the tree also colors file/folder names + badges by git status, and dims `.gitignore`'d paths — driven by `/api/git/status` + `/api/git/ignored`. See [source-control.md](source-control.md#explorer-git-decorations). (A real change wins over ignored; a non-repo workspace carries no decorations.)

### File type icons
Extension-to-icon mapping across common filetypes.

### Quick Open
- `Cmd+P` / `Ctrl+P` opens fuzzy file search
- Query via `GET /api/files/search?projectId=X&q=...&limit=50` (150 ms debounce)
- Empty query doesn't display (avoids scanning the whole project)
- Enter opens in a new tab

### `@` file mention (chat input)
- Typing `@` in the chat input opens the file selector
- Query via `GET /api/files/search?projectId=X&q=<after-@>&limit=15` (120 ms debounce)
- Selecting inserts a path chip

### `@scope` directory reference (chat input)
- Typing `@scope ` opens a directory-only selector (query via `GET /api/files/search?...&dirsOnly=1`)
- Unlike `@` mention (which lifts the path into a separate chip list), `@scope <dir>` stays as **literal text** in the message — the server expands it into that directory's scoped `.halo/INSTRUCTIONS.md` for the turn (see [prompt-system.md](../design/prompt-system.md#directory-scoped-instructions-scope))

Quick Open and `@` mention both use the search API (not the lazy tree) so unexpanded files can still be found.

# Explorer — Requirements

VS Code-style file tree sidebar with multi-select, drag-drop, right-click menu.

## Workspace switching

### Initialization
- URL `?folder=/abs/path` → use that directly as workspace
- No `?folder` → call `GET /api/fs/home`, take the home directory as fallback, write it back into the URL; UI behaves identically
- There's always a valid workspace; every frontend feature (file tree / sessions / agents / settings) depends on it

### Path input
- Explorer top bar has a path input + 📁🔍 picker button
- Pressing Enter calls `GET /api/fs/exists?path=...` first — a miss shows an alert, no switch

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

### Selection model
VS Code-style highlight selection (no checkboxes):
- **Click**: select and highlight
- **Double click**: open in editor tab
- **Ctrl/Cmd + click**: toggle multi-select
- **Shift + click**: range select

### Drag-move
- Selected files/folders drag onto a target dir
- Multi-file drag supported
- Each file goes through `POST /api/files/rename` with `{oldPath, newPath}`

### Right-click menu

Items shown depend on the click target:

| Action | Shown when | API / behavior |
|---|---|---|
| New File / New Folder | Always | `POST /api/files/new` · `mkdir`; auto-expands the parent folder so the inline input is visible |
| Open in Integrated Terminal | Always | Spawns a terminal at the target dir (or file's parent) |
| Open to the Side | File only | Splits the editor and opens the file in the right pane |
| Download | File only | `GET /api/files/download?path=...` |
| Rename | Single file/folder | `POST /api/files/rename` |
| Delete | Single or multi-select | `DELETE /api/files?path=...` (with confirm) |

The menu auto-clamps to the viewport, so right-clicking near the window edge does not clip the bottom items.

### Modification indicator
Files with unsaved editor edits show a coloured dot in the tree (synced from `editorStore.modifiedPaths`).

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

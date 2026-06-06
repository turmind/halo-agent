# Workspace — User Guide

Overall interface layout plus the three sidebar features.

## Layout

```
+---+-------------+---------------------------+
| A |  Sidebar     |  Main Content Area        |
| c |              |                           |
| t |  (tab-       |  (editor / agent configs/  |
| i |   dependent) |   …)                       |
| v |              +---------------------------+
| i |              |  Bottom Panel             |
| t |              |  (Chat | Terminal)        |
| y |              |                           |
+---+--------------+---------------------------+
```

- **Activity Bar** is the leftmost icon column
- **Sidebar** is resizable
- **Bottom Panel** is resizable; the header has a Chat / Terminal switch

The Skills tab is an exception — it takes the full right side, no Bottom Panel.

## Activity Bar tabs

| Icon | Tab | Purpose |
|---|---|---|
| 📄 Files | Explorer | File tree + Monaco editor |
| 📨 Messages | Sessions | Session history + debug viewer |
| 🪄 Wand | Skills | Skill editing (mini workspace) |
| 👥 Users | Agents | Agent configuration (Form/YAML/MD) |
| ⚙️ Gear | Settings | Settings editor (Form/YAML) |

## Switching workspace

The Explorer top bar has a path input + 📁🔍 picker button:

- Absolute path + Enter → existence check, then switch (alert on miss)
- Click 📁🔍 → directory picker modal:
  - Breadcrumb input (paste paths here)
  - ⬆ up / 🏠 home
  - Single click to select / double click to enter
  - Open button to confirm

The URL carries `?folder=/abs/path`, persisting the workspace across refreshes. When `folder` is absent, Halo falls back to the home directory.

## Explorer (file tree)

VS Code style:
- Click: select
- Double click: open in a new Tab
- Ctrl/Cmd + click: toggle multi-select
- Shift + click: range select
- Drag: move files/folders (multi-select drag supported)

Right-click menu: New File / New Folder / Rename / Delete / Download.

**Quick Open**: `Cmd/Ctrl+P` opens fuzzy file search — server-side, full-project, independent of expansion state.

### Skipped directories
`node_modules`, `__pycache__`, `.halo` (knowledge dir, not shown in the tree; use `file_read` directly).

## Editor

Monaco, multi-tab:
- Drag tabs to reorder
- Unsaved tabs show a red dot
- Closing an unsaved tab prompts for confirmation
- **Auto-refresh**: detects agent-written file changes by mtime and updates contents
- **Tab persistence**: stored in localStorage, survives refreshes

Special-file previews:
- Markdown: Preview toggle in the top-right
- PDF / DOCX / XLSX: rendered in-browser
- Images / video / audio: native players

## Terminal

Bottom-panel Terminal tab:
- xterm.js frontend + node-pty backend
- Multi-instance (each tab owns its own PTY)
- cwd = current project root
- Reconnect grace: 60 s

## Settings

`⚙️ Settings` tab. Form / YAML split view:
- Auto-generated controls (text / number / password / toggle) per declared field
- Each row shows source (`workspace` / `inherited from global` / `unset`) + Reset

Scope: Global / Workspace toggle. Same key: workspace overrides global, leaf by leaf.

Sections are grouped by declarer:
- **System** — server-built-in knobs (session limits, compaction, sandbox, logging)
- **Model Providers** — secrets declared by each `models/<id>.yaml` (AWS, Kimi, DeepSeek, …)
- **Skills** — params/secrets declared by each `skills/<id>/config.yaml`
- **Orphans** — values in settings.yaml whose namespace isn't currently declared (uninstalled skill leftovers); manual cleanup only

Common settings:
- `general.session.max_queue_size` — per-session message queue cap
- `general.session.max_nesting_depth` — max session nesting depth
- `general.compact.keep_messages` — recent messages kept intact during compaction
- `general.logging.level` — `debug` / `info` / `warn` / `error`
- `<provider-id>.secrets.api_key` — provider credentials (Kimi / DeepSeek bearer token)
- `<provider-id>.secrets.access_key_id` / `.secret_access_key` — AWS Bedrock
- `<skill-id>.params.<key>` — values an agent can inject into its own `shell_exec` via `{{<skill-id>.params.<key>}}`

See [requirements/settings.md](../requirements/settings.md), [secrets-and-credentials.md](secrets-and-credentials.md), and the [skills.md placeholder section](skills.md#placeholders-template-variables).

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + P` | Quick Open |
| `Cmd/Ctrl + S` | Save file |
| `Cmd/Ctrl + W` | Close tab |

## Bottom panel switching

Two tabs in the header: Chat / Terminal. Current tab lives in `editorStore.bottomTab` and survives refresh.

## Login / logout

The login page runs through `POST /api/auth/login`; the JWT lives in an HTTP-only cookie:
- 14-day expiry
- Auto-refresh after 24 hours of access
- Click the avatar in the top-right to log out

**Where to set the password**: `~/.halo/secrets/config.yaml`'s `server.password`, or the `HALO_PASSWORD` env var.

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

The docked Bottom Panel belongs to the Explorer tab; every other tab fills the whole right side (a floating panel stays visible on any tab).

## Activity Bar tabs

| Icon | Tab | Purpose |
|---|---|---|
| 📄 Files | Explorer | File tree + Monaco editor |
| 🌿 Branch | Source Control | Changes, commit, push, history (hidden for non-git workspaces) |
| 📨 Messages | Sessions | Session history + debug viewer |
| ⚡ Zap | Skills | Skill editing (mini workspace) |
| 🤖 Bot | Agents | Agent configuration (Form / Edit) |
| 💬 Chat bubble | Channels | Web / Telegram / Slack / Feishu / WeCom / WeChat accounts |
| ✨ Sparkles | Evolution | Self-evolution runs and review |
| 🕐 Clock | Cron | Scheduled agent runs |
| 🎚️ Sliders | Settings | Settings form (bottom of the bar) |

Below Settings sits the **quick toggles** gear. The thin bar under it has one segment per item: network (green = connected, amber = probing, red = disconnected; the gear turns red too), finish notification, and in the desktop app also pin-on-top and keep-screen-awake (amber when on). Hover for a summary. Click to open a panel where you switch them; it stays open until you click outside, press Esc, or click the gear again.

## Switching workspace

The Explorer top bar has a path input + 📁🔍 picker button:

- Absolute path + Enter → existence check, then switch (alert on miss)
- Click 📁🔍 → directory picker modal:
  - Breadcrumb input (paste paths here)
  - ⬆ up / 🏠 home
  - Single click to select / double click to enter
  - Open button to confirm

The URL carries `?folder=/abs/path`, persisting the workspace across refreshes. When `folder` is absent, Halo reopens the last workspace you used, or the home directory if there isn't one.

## Explorer (file tree)

VS Code style:
- Click a file: select, then open it after a short delay (300 ms)
- Double click: open the file right away; on a folder, expand / collapse it
- Click a folder: expand / collapse
- Ctrl/Cmd + click: toggle multi-select
- Shift + click: range select
- Drag: move files/folders (multi-select drag supported)

Right-click menu: New File / New Folder / Open in Integrated Terminal / Reveal in File Manager (desktop app only) / Open to the Side / Download / Rename / Delete / Open as Workspace (folders).

**Quick Open**: `Cmd/Ctrl+P` opens fuzzy file search — server-side, full-project, independent of expansion state.

### Skipped directories
`.git`, `.DS_Store`, `node_modules`, `__pycache__`.

## Editor

Monaco, multi-tab:
- Drag tabs to reorder
- Unsaved tabs show an amber dot
- Closing an unsaved tab prompts for confirmation
- **Auto-refresh**: detects agent-written file changes by mtime and updates contents
- **Tab persistence**: stored in localStorage, survives refreshes

Special-file previews:
- Markdown: Preview toggle in the top-right
- PDF / DOCX / XLSX: rendered in-browser
- Images / video / audio: native players

### Preview extensions

File types the editor has no built-in viewer for (e.g. `.glb` 3D models) show a "no built-in preview" page with a link to [halo-hub](https://github.com/turmind/halo-hub), where ready-made viewer extensions live: 3D models (`glb` — `.glb` / `.gltf` / `.obj` / `.stl`), draw.io diagrams (`drawio`, editable), Excalidraw whiteboards (`excalidraw`, editable) and Jupyter notebooks (`ipynb`, read-only). Extensions are installed **server-wide** (`~/.halo/global/extensions/<id>/`) and take effect in every open tab immediately — no restart, no page reload.

Three ways to install:
- **Settings → Extensions**: upload the extension `.zip`; the same panel lists what's installed (version, file types) and removes extensions
- **Ask the agent**: `/extension install glb` pulls the latest `glb-v*` release from the configured hub — halo-hub unless you change **Settings → Skills → extension → `hub_repo`** (a GitHub / Gitea / Forgejo / GitLab repo URL, `owner/repo` for GitHub, or any git URL / local repo, which installs from `glb-v<x.y.z>` tags); `/extension install /path/to/x.zip` or an `https://…zip` URL also work. `/extension list` and `/extension remove <id>` round it out (full-access sessions only)
- **By hand**: drop an unpacked extension directory into `~/.halo/global/extensions/` — the server watches that directory

Once installed, matching files open in the extension's viewer. If more than one viewer can show a file, the preview header gets an **Open with** menu (per tab, not remembered). Extensions that declare the `save` capability can edit the file: the tab shows the usual dirty dot, and the header **Save** button writes it back (Ctrl/Cmd+S doesn't apply to extension tabs). If the file changed on disk in between, you're asked before overwriting.

## Terminal

Bottom-panel Terminal tab:
- xterm.js frontend + node-pty backend
- Multi-instance (each terminal owns its own PTY), listed as a collapsible vertical tab strip on the right
- cwd = current project root
- Reconnect grace: 5 min (`timeout.terminal_grace`)

## Settings

`⚙️ Settings` tab. Form view:
- Auto-generated controls (text / number / password / toggle) per declared field
- Each row shows source (`workspace` / `inherited from global` / `unset`) + Reset

Scope: Global / Workspace toggle. Same key: workspace overrides global, leaf by leaf.

Sections are grouped by declarer:
- **System** — server-built-in knobs (session limits, compaction, sandbox, logging)
- **Security** — change password, log out
- **Extensions** — installed canvas preview extensions
- **Model Providers** — secrets declared by each `models/<id>.yaml` (AWS, Kimi, DeepSeek, …)
- **Agents** — params/secrets declared by each global agent's `agent-config.yaml`
- **Skills** — params/secrets declared by each `skills/<id>/config.yaml`
- **Orphans** — values in settings.yaml whose namespace isn't currently declared (uninstalled skill leftovers); manual cleanup only

Common settings:
- `general.session.max_queue_size` — per-session message queue cap
- `general.session.max_nesting_depth` — max session nesting depth
- `general.compact.keep_messages` — recent messages kept intact during compaction
- `general.logging.level` — `debug` / `info` / `warn` / `error`
- `general.observability.endpoint` — OTLP collector URL; leave empty to keep observability off (see [design/observability.md](../design/observability.md))
- `<provider-id>.secrets.api_key` — provider credentials (Kimi / DeepSeek bearer token)
- `<provider-id>.secrets.access_key_id` / `.secret_access_key` — AWS Bedrock
- `<skill-id>.params.<key>` — values an agent can inject into its own `shell_exec` via `{{<skill-id>.params.<key>}}`

See [requirements/settings.md](../requirements/settings.md), [secrets-and-credentials.md](secrets-and-credentials.md), and the [skills.md placeholder section](skills.md#placeholders-template-variables).

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + P` | Quick Open |
| `Cmd/Ctrl + S` | Save file |
| `Alt + W` | Close editor tab (browser; the desktop app uses `Cmd/Ctrl + W`) |
| `Cmd/Ctrl + \`` | Switch the bottom panel between Chat and Terminal |
| `Esc` | Leave editor maximize |

## Bottom panel switching

Two tabs in the header: Chat / Terminal, plus maximize and float / dock buttons. The panel opens on Chat after a refresh.

## Login / logout

The login page runs through `POST /api/auth/login`; the JWT lives in an HTTP-only cookie:
- 14-day expiry
- Auto-refresh after 24 hours of access
- Log out via **Settings → Security** (returns to the login page; this browser only)

**Password**: set initially by `halo setup` (or the `HALO_PASSWORD` env var); change it later in **Settings → Security** (needs the current password). Forgot it? Re-run `halo setup` to reset.

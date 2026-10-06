# Workspace Layout — Requirements

Overall workspace layout: Activity Bar + Sidebar + main content; the Explorer tab adds a resizable bottom panel.

## Layout structure

The Explorer tab uses the layout with the docked bottom panel:

```
+---+-------------+---------------------------+
| A |  Sidebar     |  Main Content Area        |
| c |              |                           |
| t |  (tab-       |  (Canvas / agent configs/ |
| i |   dependent) |   …)                       |
| v |              +---------------------------+
| i |              |  Bottom Panel             |
| t |              |  (Chat | Terminal)        |
| y |              |                           |
| B |              |                           |
| a |              |                           |
| r |              |                           |
+---+--------------+---------------------------+
```

Every other tab uses the full height with no docked bottom panel (Skills: SkillsMain = file tree + Canvas).

The Bottom Panel (Chat + Terminal) can also be **floated** into a draggable window that survives activity-tab switching, or **maximized** over the whole viewport — see "Bottom panel" below.

## Activity Bar tabs

| Icon | Tab | Sidebar | Main content | Bottom panel |
|---|---|---|---|---|
| FolderTree | Explorer | File tree + ops | Canvas (Monaco + previews) | Chat + Terminal |
| MessageSquare | Sessions | Session list | Session message viewer | — |
| GitBranch | Source Control | Changes + commit box | Diff / history graph | — |
| Bot | Agents | — | Agent config editor + Test (full width) | — |
| Zap | Skills | Skill list | SkillsMain (full height) | — |
| MessageCircle | Channels | Channel list | Channel config editor | — |
| Sparkles | Evolution | Run list + status filters | Evolution main (run/apply review) | — |
| Clock | Cron | Job list | Cron job detail / form + run audit | — |
| Settings2 | Settings | — | Settings panel | — |

The Source Control entry is hidden in workspaces that are not git repos.

Below Settings sits the quick-toggles entry (network status, finish notification, and on desktop pin / keep-screen-awake) — see [explorer.md → Desktop windows](explorer.md#desktop-windows-multi-window).

## Resizable panels
- **Sidebar width**: drag between sidebar and main content
- **Bottom panel height**: drag between main content and bottom panel
- Sizes persisted via localStorage

## Bottom panel

Two tabs:
- **Chat**: the main chat panel
- **Terminal**: xterm multi-tab terminal

Current tab stored in `editorStore.bottomTab`.

### Floating mode
The tab bar has a maximize button and, at the far right, a float button. Toggling the float button detaches the panel into a draggable window:
- **Default position/size**: bottom-right corner, 480×640 with a 24px margin
- **Drag**: grab the tab bar (anywhere except buttons) to reposition
- **Resize**: four edges (N/S/E/W) + four corners (NW/NE/SW/SE), minimum size 320×240
- **Visible from any activity tab** — Explorer's in-layout bottom panel is hidden while floating; Canvas takes full height
- **Only one instance** is mounted; dock / undock / maximize just move it, so terminals and their scroll buffers survive
- **State is in `sessionStorage`** (`halo_bottom_floating` + `halo_bottom_float_rect`) — page refresh reverts to docked mode
- **Agent "Test" button** dispatches `halo:navigate → explorer` to surface Chat; this jump is suppressed while floating since Chat is already globally visible
- **Close (✕) button** on the float window's tab bar docks it back

## Shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl + P | Quick Open (fuzzy file search) |
| Cmd/Ctrl + S | Save current file |
| Cmd/Ctrl + ` | Toggle the bottom panel between Chat and Terminal |
| Alt + W | Close current tab (Cmd+W cannot be overridden in browsers; the desktop app uses Cmd/Ctrl + W) |

## Auth

Login page sits in front of the Activity Bar:
- Password login via `POST /api/auth/login`
- JWT in an HTTP-only cookie
- Auto-refresh after 24 hours
- Token lifetime up to 14 days

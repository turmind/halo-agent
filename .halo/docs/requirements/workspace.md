# Workspace Layout — Requirements

Overall workspace layout: Activity Bar + Sidebar + main content + a resizable bottom panel.

## Layout structure

Most tabs use the standard layout (with bottom panel):

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

**Skills** is an exception — SkillsMain (file tree + Canvas) uses the full height, no bottom panel.

The Bottom Panel (Chat + Terminal) can also be **floated** into a draggable window that survives activity-tab switching — see "Bottom panel" below.

## Activity Bar tabs

| Icon | Tab | Sidebar | Main content | Bottom panel |
|---|---|---|---|---|
| FolderTree | Explorer | File tree + ops | Canvas (Monaco + previews) | Chat + Terminal |
| MessageSquare | Sessions | Session list | Session message viewer | Chat + Terminal |
| Zap | Skills | Skill list | SkillsMain (full height) | — |
| Bot | Agents | — | Agent config editor + Test (full width) | Chat + Terminal |
| MessageCircle | Channels | Channel list | Channel config editor | Chat + Terminal |
| Settings2 | Settings | — | Settings panel | Chat + Terminal |

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
The tab bar has a float button on the far right. Toggling it detaches the panel into a draggable window:
- **Default position/size**: bottom-right corner, 480×640 with a 24px margin
- **Drag**: grab the tab bar (anywhere except buttons) to reposition
- **Resize**: four edges (N/S/E/W) + four corners (NW/NE/SW/SE), minimum size 320×240
- **Visible from any activity tab** — Explorer's in-layout bottom panel is hidden while floating; Canvas takes full height
- **Only one instance** mounted at a time (xterm DOM gets rebuilt once on dock/undock; server-side terminal sessions are preserved and reattached, scroll buffer is lost)
- **State is in `sessionStorage`** (`halo_bottom_floating` + `halo_bottom_float_rect`) — page refresh reverts to docked mode
- **Agent "Test" button** dispatches `halo:navigate → explorer` to surface Chat; this jump is suppressed while floating since Chat is already globally visible
- **Close (✕) button** on the float window's tab bar docks it back

## Shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl + P | Quick Open (fuzzy file search) |
| Cmd/Ctrl + S | Save current file |
| Alt + W | Close current tab (Cmd+W cannot be overridden in browsers) |

## Auth

Login page sits in front of the Activity Bar:
- Password login via `POST /api/auth/login`
- JWT in an HTTP-only cookie
- Auto-refresh after 24 hours
- Token lifetime up to 14 days

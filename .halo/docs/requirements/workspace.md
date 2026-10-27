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

**Extension entries.** An installed [canvas extension](../design/canvas-extensions.md#activity-bar-entries) whose manifest declares `activity` adds one button after Cron (several sort by the manifest's `order`, then id; the built-in tabs never move). It uses the extension's icon (tinted like the built-in icons; a puzzle piece when it has none) and its title / description in the hover drawer, in the admin's language. Clicking it shows the extension's page full-width in the main area with no sidebar, like Agents / Settings; leaving the tab closes the page (anything it was playing or refreshing stops). The last-used page is restored after a reload; if that extension has been removed, or doesn't run on this device, the workspace opens on Explorer instead. With no such extension installed, the bar is unchanged.

**Short windows.** When the window is too short for every view button, the upper group (built-in views + extension entries) scrolls (no visible scrollbar); Settings and the quick-toggles entry stay pinned at the bottom.

Below Settings sits the quick-toggles entry (network status, finish notification, and on desktop pin / keep-screen-awake) — see [explorer.md → Desktop windows](explorer.md#desktop-windows-multi-window).

### Hover drawer
The bar is icon-only (48px) at rest. Resting the **mouse** on it for 300 ms widens it into a 240px drawer that shows each view's name plus a one-line description (the quick-toggles entry too); leaving closes it after a 200 ms grace, and moving back in within that grace keeps it open. The view icons no longer carry native tooltips.
- **No reflow**: the bar is an absolute layer over a fixed 48px slot, so the drawer overlays the sidebar / main area instead of pushing them.
- **Mouse only**: touch and pen never open it, and neither do touch-primary devices — a tap still just switches view.
- **Stays open** while the quick-toggles panel (anchored to the drawer's right edge) is up. **Esc** or picking a view closes it.

## Resizable panels
- **Sidebar width**: drag between sidebar and main content
- **Bottom panel height**: drag between main content and bottom panel
- Sizes persisted via localStorage

## Bottom panel

Two tabs:
- **Chat**: the main chat panel
- **Terminal**: xterm multi-tab terminal

Current tab stored in `editorStore.bottomTab`.

The middle of the tab bar shows the current tab's title — the session title on Chat ("New session" for a draft, "Untitled session" until it has one), the active terminal's name on Terminal. It is truncated with an ellipsis when it doesn't fit (full text on hover) and hidden when the bar is too narrow.

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

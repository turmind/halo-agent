# Phone Layout — Requirements

On a phone the admin is its own single-column layout, chat first with a bottom nav. It is not the desktop workspace scaled down. Each page reuses its desktop component; only the shell around it and the proportions change. How it is built: [design/ui-style.md → Phone layout](../design/ui-style.md#phone-layout). Desktop layout: [workspace.md](workspace.md).

## When it applies

- The viewport is narrower than 768px, **or** it is a touch screen less than 500px tall, i.e. a phone turned landscape (844×390). Rotating a phone keeps the phone layout, so a canvas viewer such as a game keeps running through the rotation instead of being remounted.
- The switch is live: resizing a desktop window under 768px moves to the phone layout, widening it moves back. A desktop window with a mouse, or any screen at least 768×500, always gets the desktop layout unchanged.

## Shell

One full-screen view at a time, with a top bar (title, back, actions) and a bottom nav of four entries:

| Entry | Shows |
|---|---|
| **Chat** | The Explorer chat. The top bar's list button opens the session list as a sheet, and **+** starts a new session |
| **Files** | The file tree. Tapping a file opens it full screen in the canvas, and the top bar's back returns to the tree. The canvas stays mounted, so a viewer keeps running while you are on another entry |
| **Sessions** | Session list → session detail |
| **More** | Every other page (Source Control, Agents, Skills, Channels, Evolution, Triggers, extension pages such as Halo City, Terminal, Settings) plus the quick toggles |

- **List → detail → back.** A page that is a list plus a detail (Sessions, Channels, Triggers, Evolution, Source Control…) shows the list first. Picking a row opens its detail, and the top bar's back returns to the list. Agents and Settings get the same two levels: the list or section nav first, then the editor or section.
- Tapping the entry you are already on returns it to its root (the tree, the list, the More page list).
- Leaving the canvas ends a maximized canvas.
- Jumps from inside a page (path links, an agent's **Test**, links into a Settings section) land on the matching entry.
- **Remembers where you were.** The current view (chat / files / sessions / more, or the canvas) is kept in `localStorage` (`halo_mobile_view`) and restored after a reload. A canvas that was maximized restores onto the canvas.
- Chat and Terminal share one slot. Chat sits under the Chat entry, Terminal under More. The desktop's split view, floating window and maximized panel preferences are left as they are and simply not used on the phone.

## Touch

- **Bottom sheets.** Dialogs, and menus that open at the pointer (row and tab context menus), slide up from the bottom edge at full width. Dropdowns anchored to a button stay where they are.
- **Long press = right-click.** Holding a row (file tree, sessions…) for 500 ms without moving opens its context menu, iOS included, which never fires one natively. The tap that ends the press does not also open the row.
- **No focus zoom.** Text fields are 16px, so iOS Safari doesn't zoom in when one is focused. Rows are at least 40px tall, and the chat input's icon buttons are 40px.
- **Keyboard.** The shell follows the visible viewport, so the chat input stays above the on-screen keyboard.
- **Notch / home bar.** The shell keeps clear of the safe areas, and the page is laid out edge to edge (`viewport-fit=cover`).

## Not on the phone

Desktop interactions that need a mouse or a wide screen are not offered: drag and drop, split view (canvas panes, Chat + Terminal side by side), and the floating chat window. With one view on screen there is also no activity bar, hover drawer or resizable sidebar.

## Fitting the width

- **Nothing scrolls sideways.** No page, form, bubble or dialog is wider than the screen. Long ids, paths and URLs wrap inside their bubble or card. Code blocks and tables scroll horizontally inside themselves, and the editor and terminal keep their own scrolling.
- **Forms go single column.** A form grid that holds a text field, select or textarea becomes one column. A grid of only number fields or checkboxes becomes two columns. Grids that size themselves (`repeat(…)`) are left alone.
- **Strips wrap.** Header and toolbar strips (session viewer, agent editor, cron detail…) and rows with items at both ends wrap onto a second line instead of squeezing, and a report title wraps as a unit.
- **One scroll per detail.** The Triggers (cron) detail and the Evolution detail scroll as one column, header included, rather than a fixed header over a scrolling body. Forms with a pinned footer bar (the cron form's Save) keep the footer in place.

## Viewer extensions full screen

A canvas viewer extension without `save` (an emulator, a 3D viewer) can go full screen on the phone: the canvas top bar shows a **Full screen** button whenever the open file is such a viewer. Behavior: [editor.md → Immersive mode](editor.md#maximize).

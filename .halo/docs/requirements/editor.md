# Canvas — Requirements

Monaco-based multi-tab code editor + binary file previewer — surfaced in the UI as **Canvas**.

> Naming note: "Canvas" is the user-visible name (header label, this doc). Source code still uses `editor`
> (`packages/admin/src/features/editor/`, `useEditorStore`, `EditorPanel`) — those names are internal.

> Store scoping: `useEditorStore` is the **default singleton** powering the main Explorer Canvas.
> Nested `EditorPanel` instances that need isolated tabs/fileTree/selection (e.g. Skills editor)
> wrap their subtree in `<EditorStoreProvider>`; inside the provider, `useScopedEditorStore()`
> returns a fresh store instance instead of the singleton. Without a provider the hook falls
> back to the default, so regular call sites don't change. `EditorPanel` also accepts
> `showMaximize={false}` for nested contexts where viewport-fullscreen makes no sense.

## Core behaviour

### Multi-tab editing
- Click a file in Explorer (single click = select, double click = open tab)
- Each tab independently tracks content, original content, language, mtime
- Unsaved tabs show a small red dot
- Closing an unsaved tab prompts for confirmation

### Save
- `Cmd+S` / `Ctrl+S` calls `PUT /api/files`
- Server returns the new `modifiedAt`; the tab updates its mtime

### Auto-refresh (mtime-based)
When agents write files through tools, the canvas detects it:
1. Periodically poll `GET /api/files/stat`
2. If `diskMtime > tab.mtime`, pull fresh content
3. Skip if the user has unsaved edits (don't overwrite)

### Tab persistence
Open tabs and the active tab live in localStorage; survive refresh.

### Diff view
- Tracked files → `GET /api/files/diff` for git diff
- Monaco left/right compare view

### Binary previews
Non-text files go through `FilePreview`, which looks up a **plugin** in the preview registry by file extension. Built-in plugins:
- **PDF** — browser-native iframe
- **DOCX / DOC** — `mammoth` → HTML (parsed in a Web Worker so the UI stays responsive)
- **XLSX / XLS / CSV** — `xlsx` (SheetJS) → table (parsed in a Web Worker; CSV decoded as UTF-8 with BOM strip)
- **PPTX / PPT** — `pptx-preview` list mode. Fidelity is approximate — complex animations / SmartArt / embedded fonts may not render perfectly; users can download for the exact source. Flagged `heavy: true` so only the *active* pptx mounts (canvas-based rendering needs the main thread). **Speaker-notes sidebar**: notes are extracted from the pptx zip in presentation (play) order and listed on the left; clicking a note scrolls to the corresponding slide (a domIndex mapping bridges play order to pptx-preview's part-filename render order, so reordered decks still land on the right slide). Collapsible with the state remembered in localStorage (`halo.pptxNotesHidden`); the sidebar doesn't appear at all when no slide has notes. Decks with dangling `[Content_Types].xml` overrides (e.g. some WPS exports) are repaired before rendering; if zero slides render anyway, a real error UI is shown instead of a silent black wrapper
- **Images / video / audio** — native `<img>` / `<video>` / `<audio>`, supports HTTP Range for seek-without-full-download

All previews share a **standard header** (`PreviewShell`) with filename, Download, Open-as-Text, and an `extraToolbar` slot for plugin-specific buttons (e.g. DOCX Print, XLSX sheet tabs).

Fetched via `GET /api/files/download?inline=1` (supports Range, streams on the server).

Adding new file types is a plugin concern — see `dev/previews.md` for the extension guide.

### Renderable text formats (Markdown / HTML)
Markdown and HTML open as text in Monaco *and* have a rendered view — Canvas defaults to the **rendered** view since the primary audience is an AI generating reports / pages for humans to read.
- Header shows an **Edit / Preview** toggle (same `textRenderMode` state for both formats)
- **Markdown** → `MarkdownPreview` (react-markdown + GFM; relative image `src` rewritten to the download endpoint so local images work)
- **HTML** → sandboxed iframe (`sandbox="allow-same-origin"`; scripts, top-navigation, forms, pop-ups all blocked — safe against hostile HTML)
- Toggle to Edit → Monaco source, Cmd+S saves as usual

### Preview caching (MRU)
Recently opened preview tabs stay mounted (up to 5, MRU) so switching between them doesn't re-fetch or re-parse. Plugins flagged `heavy: true` bypass the cache — only the active instance mounts, others unmount. Closing a preview tab removes it from the cache immediately (aborting any in-flight fetch).

### File metadata in header
The Canvas header shows `(size · Created … · Modified …)` for the active tab. Both text tabs and preview tabs populate this — preview tabs fetch `GET /api/files/stat` on open (and on tab restore from localStorage) since they never read content.

### Selection tracking
Canvas tracks current selection and cursor. When `contextEnabled` is on, the selection is auto-injected into chat messages as context.

### Maximize
The header has a maximize button on the far right. Toggling it expands Canvas to fill the entire viewport — activity bar, sidebar, and bottom panel are hidden. The state persists in localStorage so reloads keep the mode. Press `Esc` to exit — except when focus is inside an input, Monaco, or Quick Open, so those can handle `Esc` first.

Canvas (including Monaco instances, file tree, and open tab contents) stays mounted across activity-tab switches and maximize toggles — switching away and back does **not** reload content.

## Shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl + P | Quick Open (fuzzy file search) |
| Cmd/Ctrl + S | Save current tab |
| Alt + W | Close current tab (Cmd+W cannot be overridden in browsers) |
| Esc | Exit maximized Canvas (when not inside an input / Monaco / Quick Open) |

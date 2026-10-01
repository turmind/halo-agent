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
- Tracked files → `GET /api/git/diff` (returns `{ original, modified }`) for git diff
- Monaco left/right compare view

### Binary previews
Non-text files go through `FilePreview`, which looks up a **plugin** in the preview registry by file extension. Built-in plugins:
- **PDF** — browser-native iframe
- **DOCX / DOC** — `mammoth` → HTML (parsed in a Web Worker so the UI stays responsive)
- **XLSX / XLS** — `xlsx` (SheetJS) → table, parsed whole in a Web Worker (zip can't stream); rendered with client-side paging (500 rows/page over the in-memory parse — no truncation, just paged)
- **CSV / TSV** — server-paginated table: each page (100 rows) is parsed and fetched from the server on demand, so large files open instantly. Delimiter is sniffed from the header line (comma/semicolon/tab; `.tsv` forces tab); total row count is a lazy lower bound ("N+") until the last page is reached
- **Parquet** — server-paginated table (schema + 100-row pages), same pager as CSV/SQLite
- **SQLite / DB (.db / .sqlite / .sqlite3)** — server-paginated table with a table-selector sidebar (name + row count per table); opened read-only, one page (100 rows) per request
- **PPTX / PPT** — `pptx-preview` list mode. Fidelity is approximate — complex animations / SmartArt / embedded fonts may not render perfectly; users can download for the exact source. Flagged `heavy: true` so only the *active* pptx mounts (canvas-based rendering needs the main thread). **Speaker-notes sidebar**: notes are extracted from the pptx zip in presentation (play) order and listed on the left; clicking a note scrolls to the corresponding slide (a domIndex mapping bridges play order to pptx-preview's part-filename render order, so reordered decks still land on the right slide). Collapsible with the state remembered in localStorage (`halo.pptxNotesHidden`); the sidebar doesn't appear at all when no slide has notes. Decks with dangling `[Content_Types].xml` overrides (e.g. some WPS exports) are repaired before rendering; if zero slides render anyway, a real error UI is shown instead of a silent black wrapper
- **Images / video / audio** — native `<img>` / `<video>` / `<audio>`, supports HTTP Range for seek-without-full-download

All previews share a **standard header** (`PreviewShell`) with filename, Download, Open-as-Text, and an `extraToolbar` slot for plugin-specific buttons (e.g. DOCX Print, XLSX sheet tabs).

Fetched via `GET /api/files/download?inline=1` (supports Range, streams on the server).

Adding new file types is a plugin concern — see `dev/previews.md` for the extension guide.

### Preview extensions (installable viewers)
File types without a built-in plugin can be handled by an **installed extension**: a static HTML bundle under `~/.halo/global/extensions/<id>/` (server-wide, not per workspace) that Canvas loads in a sandboxed iframe (scripts + same-origin, like the HTML preview — an extension is trusted like a skill the user chose to install). Design: `design/canvas-extensions.md`.
- **Resolution order** for a file extension: `default`-priority extensions (newest install wins) → built-in plugins → `option`-priority extensions. `.glb` with the `glb` extension installed opens in the viewer directly; an `option` extension only shows up in the header's **Open with** menu
- **Opening and tab restore**: whether a file opens as text or in a viewer is decided when it is clicked, restored after a page reload, or opened to the side. Since an installed extension may claim a type (`.glb`) or even a text suffix (`.json`), a file that would open as text first waits for the page's initial extension list (up to 3 s), so a `.glb` tab survives a reload as a viewer rather than coming back as text. Files that already have a built-in viewer open without waiting. If the list isn't back within 3 s (or failed to load), files open as if no extension were installed — a `.glb` opens as text; a list that arrives later still updates the viewer of tabs that are already previews
- **Open with** (header menu, shown only when there are >2 candidates counting *Open as text*): switches the current tab's viewer; the choice is per tab and not persisted
- **Fallback**: a file with no built-in plugin and no installed extension shows a static page — "no built-in preview for this type; extensions for more file types are on halo-hub ↗" — plus Open as text / Download. No online lookup
- **Editable extensions** (manifest `capabilities: ["save"]`): the iframe reports dirty → tab shows the dirty dot → header **Save** button (Ctrl/Cmd+S is *not* wired for extension tabs — Monaco isn't mounted) → `PUT /api/files/raw`. If the file changed on disk since it was loaded the save gets a 409 and the user is asked "changed on disk … Overwrite?". An external change while the tab is clean reloads it; while dirty, local edits are kept silently and the conflict surfaces at the next save
- **Live install / upgrade / uninstall** (from Settings → Extensions upload / remove, the `/extension` skill, or a manual directory change): pushed over WS, no reload. An upgraded extension remounts open tabs (or shows a "updated — reload" banner if the tab is dirty); uninstalling drops clean tabs to the fallback page and keeps dirty tabs alive with a banner
- **Settings → Extensions**: lists installed extensions (name, version, file types, license/homepage) and manifest errors; upload `.zip` (≤ 100 MB) and remove. Any logged-in admin can do both — the admin cookie has no access level

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

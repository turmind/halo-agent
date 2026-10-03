# Session — Requirements

Session history viewer: hierarchy tree, message playback, debug mode, system prompt inspection.

## Core behaviour

### Session tree view
- Top-level sessions (no parentSessionId) act as roots; child sessions render indented
- Each row shows: title, message count (user turns over the session's lifetime — never shrinks when history is compacted/archived), relative time, and status icons (amber Archive for archived; StopCircle for stopped, sub-agent rows only). Sub-agent rows also carry an agent-name badge; a root row shows an "active" badge when it is the chat panel's current session
- Clicking a row previews its full message list in SessionChatPanel; double-clicking a root row opens it in an Explorer chat tab
- Collapse / expand via the arrow buttons; a row with descendants shows a non-clickable "+N" total descendant count
- Hover trash on a root row (confirm dialog) hard-deletes the session and its whole subtree via REST
- Inline title rename (admin-only): a hover pencil on any row — root **or** sub-agent — opens an inline input (Enter commits, Escape cancels, blur commits); persists via `PATCH /api/sessions/logs/:id`
- Infinite scroll loads more roots in pages; a silent reload (after streaming ends, or a delete / create / archive elsewhere) re-fetches only the first page and merges it over the rows already loaded, so the list keeps its depth and scroll position. Rows beyond the first page aren't re-checked until the next full reload (mount / project switch). No cap on depth (the 300-top-level cap was removed in 1.5.3-alpha)
- Viewed sessions are cached (LRU, 20 sessions; the one on screen is never evicted): switching back to a cached session shows the kept copy at once — transcript, archive position and reading position — and a stale copy (its log file changed, or the WS reconnected) is refetched in the background. Refetches are single-flight per session: at most one request in flight plus one queued re-pull. A session that is open in an Explorer chat tab shows that tab's live stream instead
- The Sessions tab mounts on first open and then stays mounted (CSS-hidden while another activity tab is up), so the cache and reading positions survive switching tabs

### Message viewer
- All messages rendered by role
- Assistant messages render Markdown
- System messages summarise tool calls
- For a session whose history was compacted, scrolling to the top shows a "load earlier messages" row; scrolling further or clicking it pulls one archived segment at a time. Pulled history renders expanded above the active log, with a divider marking where it ends, and is read-only (no delete)

### Debug mode
Top Debug toggle (Bug icon), persisted in `localStorage` as `halo_session_debug`. When on:
- **Normal mode**: user message + assistant reply (with inline tool-call cards, click to expand IN / OUT); sub-agent notifications hidden
- **Debug mode**: adds, on top of the normal view:
  - **Thinking** blocks (purple, expandable, with char count) inside assistant messages
  - **Usage** line after each turn — timestamp, token counts (in / out / ctx, cache read / write / hit ratio), latency (ttft / e2e), thinking effort, model ID
  - Sub-agent start / done markers labelled with the agent name

### System prompt viewer
The Prompt button (FileText icon, shown only when the session has a prompt; open state persisted as `halo_session_prompt`) shows the system prompt used by this session in a floating card. Extracted from the first `context`-type message (never rendered inline in the list); displays the full injected prompt (AGENT.md + INSTRUCTIONS.md + INDEX.md + TOOL_GUIDELINES + skills).

### Session lifecycle
- Created on the first `chat` WS message (with a new sessionId)
- Auto-saved after every `complete` event
- Sessions restore from disk on refresh / WS reconnect (loaded at subscribe time; running sessions reattach from the detached pool)
- Deleting a session removes the JSON file (plus any archived history segments) and cascade-deletes all descendants (their files and SQLite rows)
- Assistant messages persist their `contentBlocks` (text / thinking / tool calls, in the order they happened) so tool-call cards survive a refresh in the right places. Sessions written before content blocks existed carry a flat `toolCalls` array instead and still render, as a fallback

### Non-destructive /session new
`/session new` (also `/clear` and "+ New Session") **does not** destroy the old session:
1. A new draft tab opens in the chat panel with an empty conversation; the session is created on its first message or command
2. The old session keeps its tab and keeps streaming into it in the background (its row's status dot pulses amber while it runs and turns blue once new output lands unseen)
3. The old session's sub-agents keep running independently
4. Switching back shows the old tab as it is; after a reconnect it reloads from the server

(Until 1.5.3-alpha this went through the WS `session:clear` frame and reset the single chat view; that frame has been removed.)

## Session categorisation

| Scenario | Display |
|---|---|
| Main session | Sidebar top level |
| Child session (has parentSessionId) | Nested under parent |
| Stopped session (sub-agent row) | Icon decorated with StopCircle |
| Archived session | Shown dimmed (50% opacity) with an amber Archive icon — the list fetches `includeArchived=1`, so archived rows stay visible for inspection rather than being hidden |

## API

Unified session logs API (recommended):

| Operation | Endpoint |
|---|---|
| List | `GET /api/sessions/logs?projectId=...` |
| Read | `GET /api/sessions/logs/:id?projectId=...` |
| Read archived history | `GET /api/sessions/logs/:id/archive/:n?projectId=...` |
| Delete | `DELETE /api/sessions/logs/:id?projectId=...` |
| Rename | `PATCH /api/sessions/logs/:id?projectId=...` (body `{title}`) |

The List endpoint serves two consumers: this tree view (default — roots + all
descendants, paginated, rebuilt into a tree client-side) and the chat panel's
session sidebar (`rootOnly=1` — a flat list of roots). Both paginate
via `cursor` / `nextCursor`. See [dev/api.md](../dev/api.md#get-apisessionslogsprojectidabsrootonly01includearchived01cursormslimitn) for the full contract.

Implementation detail: [design/session.md](../design/session.md).

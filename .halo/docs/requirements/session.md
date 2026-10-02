# Session — Requirements

Session history viewer: hierarchy tree, message playback, debug mode, system prompt inspection.

## Core behaviour

### Session tree view
- Top-level sessions (no parentSessionId) act as roots; child sessions render indented
- Each row shows: title, agent-name badge, message count (user turns over the session's lifetime — never shrinks when history is compacted/archived), relative time, and status icons (StopCircle for stopped, amber Archive for archived)
- Clicking loads the full message list into SessionChatPanel
- Collapse / expand via arrow buttons
- Clicking the count badge (e.g. "+3") shows total descendant count
- Inline title rename (admin-only): a hover pencil on any row — root **or** sub-agent — opens an inline input (Enter commits, Escape cancels, blur commits); persists via `PATCH /api/sessions/logs/:id`
- Infinite scroll loads more roots in pages; a silent reload (after streaming ends, or a delete / create / archive elsewhere) re-fetches the **same depth** already scrolled to rather than snapping back to the first page. No cap on depth: a reload deeper than the endpoint's 500-row page limit pages through with the cursor in 500s and renders once at the end (the 300-top-level cap was removed in 1.5.3-alpha)
- Viewed sessions are cached (LRU, 20 sessions; the one on screen is never evicted): switching back to a cached session shows the kept copy at once — transcript, archive position and reading position — and a stale copy (its log file changed, or the WS reconnected) is refetched in the background. Refetches are single-flight per session: at most one request in flight plus one queued re-pull. A session that is open in an Explorer chat tab shows that tab's live stream instead
- The Sessions tab mounts on first open and then stays mounted (CSS-hidden while another activity tab is up), so the cache and reading positions survive switching tabs

### Message viewer
- All messages rendered by role
- Assistant messages render Markdown
- System messages summarise tool calls
- For a session whose history was compacted, scrolling to the top shows a "load earlier messages" row; scrolling further or clicking it pulls one archived segment at a time. Pulled history renders expanded above the active log, with a divider marking where it ends, and is read-only (no delete)

### Debug mode
Top Debug toggle (Bug icon). When on:
- **Normal mode**: user message + assistant reply (with inline tool-call cards); sub-agent notifications hidden
- **Debug mode**: every message, including:
  - **Context / System Prompt** (purple) — full injected prompt, expandable
  - **Tool Call** (blue) — full tool input JSON, expandable
  - **Tool Result** (green/red) — full tool output JSON, expandable
  - **Usage** — token counts, latency (ttft / e2e), model ID, cache hit ratio
  - Sub-agent messages carry an agent-name badge

### System prompt viewer
The Prompt button (FileText icon) shows the system prompt used by this session. Extracted from the first `context`-type message; displays the full injected prompt (AGENT.md + INSTRUCTIONS.md + INDEX.md + TOOL_GUIDELINES + skills).

### Session lifecycle
- Created on the first `chat` WS message (with a new sessionId)
- Auto-saved after every `complete` event
- Sessions restore from disk on refresh / WS reconnect (loaded at subscribe time; running sessions reattach from the detached pool)
- Deleting a session removes the JSON file (plus any archived history segments) and cascade-deletes all descendants in SQLite
- Assistant messages persist their `contentBlocks` (text / thinking / tool calls, in the order they happened) so tool-call cards survive a refresh in the right places. Sessions written before content blocks existed carry a flat `toolCalls` array instead and still render, as a fallback

### Non-destructive /session new
`/session new` (also `/clear` and "+ New Session") **does not** destroy the old session:
1. A new draft tab opens in the chat panel with an empty conversation; the session is created on its first message or command
2. The old session keeps its tab and keeps streaming into it in the background (its row shows a running mark, and an unread dot once new output lands)
3. The old session's sub-agents keep running independently
4. Switching back shows the old tab as it is; after a reconnect it reloads from the server

(Until 1.5.3-alpha this went through the WS `session:clear` frame and reset the single chat view; that frame has been removed.)

## Session categorisation

| Scenario | Display |
|---|---|
| Main session | Sidebar top level |
| Child session (has parentSessionId) | Nested under parent |
| Stopped session | Icon decorated with StopCircle |
| Archived session | Shown dimmed (50% opacity) with an amber Archive icon — the list fetches `includeArchived=1`, so archived rows stay visible for inspection rather than being hidden |

## API

Unified session logs API (recommended):

| Operation | Endpoint |
|---|---|
| List | `GET /api/sessions/logs?projectId=...` |
| Read | `GET /api/sessions/logs/:id?projectId=...` |
| Read archived history | `GET /api/sessions/logs/:id/archive/:n?projectId=...` |
| Delete | `DELETE /api/sessions/logs/:id?projectId=...` |

The List endpoint serves two consumers: this tree view (default — roots + all
descendants, paginated, rebuilt into a tree client-side) and the chat panel's
session sidebar (`rootOnly=1` — a flat list of roots). Both paginate
via `cursor` / `nextCursor`. See [dev/api.md](../dev/api.md#get-apisessionslogsprojectidabsrootonly01includearchived01cursormslimitn) for the full contract.

Implementation detail: [design/session.md](../design/session.md).

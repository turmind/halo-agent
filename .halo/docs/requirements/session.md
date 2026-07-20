# Session — Requirements

Session history viewer: hierarchy tree, message playback, debug mode, system prompt inspection.

## Core behaviour

### Session tree view
- Top-level sessions (no parentSessionId) act as roots; child sessions render indented
- Each row shows: title, agent-name badge, message count, relative time, and status icons (StopCircle for stopped, amber Archive for archived)
- Clicking loads the full message list into SessionChatPanel
- Collapse / expand via arrow buttons
- Clicking the count badge (e.g. "+3") shows total descendant count
- Inline title rename (admin-only): a hover pencil on any row — root **or** sub-agent — opens an inline input (Enter commits, Escape cancels, blur commits); persists via `PATCH /api/sessions/logs/:id`
- Infinite scroll loads more roots in pages; a silent reload (after streaming ends, or a delete / create / archive elsewhere) re-fetches the **same depth** already scrolled to rather than snapping back to the first page. Capped at 300 top-level rows — past that, "load more" stops (older sessions, e.g. from a busy Slack channel, aren't worth scrolling to)

### Message viewer
- All messages rendered by role
- Assistant messages render Markdown
- System messages summarise tool calls

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
- Deleting a session removes the JSON file and cascade-deletes all descendants in SQLite
- Assistant messages embed a `toolCalls` array so tool-call cards persist across refresh

### Non-destructive /session new
`/session new` (session:clear) **does not** destroy the old session:
1. Save current session to disk
2. Create a background handler to keep the old session's in-flight events flowing
3. Reset client state, enter empty conversation
4. The old session's sub-agents keep running independently
5. Switching back loads from the file

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
| Delete | `DELETE /api/sessions/logs/:id?projectId=...` |

The List endpoint serves two consumers: this tree view (default — roots + all
descendants, paginated, rebuilt into a tree client-side) and the chat panel's
session sidebar (`rootOnly=1` — a flat list of roots). Both paginate
via `cursor` / `nextCursor`. See [dev/api.md](../dev/api.md#get-apisessionslogsprojectidabsrootonly01includearchived01cursormslimitn) for the full contract.

Implementation detail: [design/session.md](../design/session.md).

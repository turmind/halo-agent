# Chat — Requirements

The primary surface for talking to an agent.

## Core behaviour

### Agent selection
- Bottom-left dropdown in the chat panel selects which agent to use
- Lists every available agent (from `GET /api/agent-configs`; overridden and disabled agents are hidden)
- Default agent has a "default" badge
- **Locked during an active session** — the agent is bound to the session; to change, start a new session (/session new)
- The Agents panel's "Test" button can also preselect an agent

### Message rendering
- Markdown + code-block highlighting
- Tool-call card: expandable, shows tool name / input / output
- Sub-agent messages carry the agent-name label (e.g. "Coder", "Researcher")
- Streaming text has a cursor animation

### User-message actions (Copy / Delete / Show)
Hover actions on the blue sticky user bubble — real user prompts only (sub-agent report / compact-summary callouts, though user-role, get no buttons):
- **Copy** — copies the prompt text to the clipboard
- **Show more/less** — the existing clamp toggle, shown when the text overflows
- **Delete** (confirm dialog) — removes the whole exchange (the user turn + all responses up to the next user turn) with **two-layer semantics**: the LLM context (`rawMessages`) drops the turn physically — the model never sees it again, freeing context; the UI keeps the messages, rendered greyed-out with a "deleted" tag, as an audit trail. No undo; a deleted exchange loses its Delete button. Rejected with an error toast while the agent is running or compacting. Root sessions only (sub-session logs don't offer Delete). If the turn was already compacted out of raw context, only the UI marking happens (silent degrade). Design details in [design/session.md](../design/session.md#exchange-deletion-soft-ui--hard-raw), protocol in [design/ws.md](../design/ws.md).

### Slash commands

The full command list is fetched from `GET /api/commands` per session and includes built-ins + skill commands. The following are always-present highlights for the chat surface:

| Command | Type | Purpose |
|---|---|---|
| `/help` | client | List available commands |
| `/clear` | client | Alias for `/session new` (admin-UI shortcut, no server registration) |
| `/session new` | server | Start a new session |
| `/session context` | server | Show context window usage, agent info |
| `/session compact` | server | LLM-summary compact of the conversation |

See [requirements/command.md](command.md) for the full command surface.

### Goal-mode banner
When a goal is bound to the current session (see [command.md → `/goal`](command.md) / [design/goal-mode.md](../design/goal-mode.md)), a strip above the composer shows status (intake / running round N/max / paused / halted / done); a label click jumps to the goal session, a `Worker →` button jumps back to the worker. Terminal states (done/halted) are dismissible — dismissal persists per-project in `localStorage` so it survives a page refresh; a new goal gets a different id and un-suppresses automatically. Active states (intake/running/paused) are not dismissible while the lock they explain is still in force.

### Graceful interrupt
Sending a new message while the agent is generating **does not** abort — the message goes to the server queue, the agent finishes the current turn at the next safe checkpoint (after a tool call), and then runs the queued message. Queueing multiple messages is supported; they run in order.

### Stop
The Stop button hard-aborts — the server receives `chat:stop`, AbortController fires, queue clears, buffers flush.

### Editor context injection
When `contextEnabled` is on (default), user messages are auto-prepended with:
- `[Currently viewing: path/to/file.ts]`
- `[Selected text in file.ts:10-25]\n\`\`\`...\n\`\`\``

### File attachments
- Drag to chat input
- Clipboard paste
- File-picker button

Images ride along as base64; multimodal supported. Pasted images are also persisted to `<workspace>/.halo/assets/web/inbound/web/<date>/` so a `[图片已保存: /abs/path]` marker survives page reload and renders as a click-to-preview chip (shared with the WeChat channel's inbound media flow).

### Inline media chips
Any message containing `[图片/视频/语音/文件 已保存: /path]` markers (WeChat + web) or a leading `MEDIA: /path` line (agent-emitted, e.g. from `wechat-send`) renders a compact chip with filename + icon. Clicking opens a full-size preview modal (image/video/audio inline, file → download link). Paths inside the active workspace or under `/tmp/` are previewable; everything else degrades to a non-clickable chip.

### Live capture (desktop only)
Lets the agent *see something live* on demand. Desktop client (Electron) only — the entry points never render in a plain browser. Borrows the meeting-app "share" model: the user binds one source, then the agent requests a frame when it actually needs to look.

Two source kinds in the chat-input toolbar, **mutually exclusive** (only one bound at a time):
- **Screen / window share** (MonitorUp button) — opens a picker grid of screens + app windows. A bound window can be grabbed even while it sits in the background.
- **Camera** (Camera button) — toggles the webcam on. Hidden entirely on a machine with no camera.

Once bound, a frame is **not** attached to every message. Instead a one-line instruction is injected into the next send ("the user is sharing the «X» window" / "the user has turned the camera on") telling the model to output a line containing exactly `<<<CAPTURE>>>` when it needs to see the current view. On turn completion the frontend detects the marker, grabs one frame, and sends it back as a **visible image message** — the model sees it on its following turn. So it's a cross-turn round-trip: model asks → frame is sent back → model answers next turn. The returned frame is also shown inline on the user bubble so you can see exactly what was sent.

Constraints:
- Shown only when the selected agent's model accepts image input (capture is pointless on a text-only model); switching to a text-only model auto-unbinds.
- Screen share needs macOS **Screen Recording** permission; the camera prompts for **Camera** permission on first use, with an "Open Settings" path if previously denied.
- Binding is **in-memory only** — switching sessions or restarting requires re-selecting.

### The agent's face (`self.html`)
A second channel beyond text: a visual space the agent drives in real time to express itself. Works everywhere (pure HTML/canvas, no Electron dependency) — desktop **and** plain browser.

- **What it is.** A self-contained animated particle canvas at `<workspace>/.halo/canvas/self.html` — a breathing core that reacts to the cursor (knows when it's watched), can form words/CJK/ASCII-from-emoji, play choreographed sequences, and gesture (pulse/flash/shake). Zero external references (no CDN/remote fonts) — ships and runs offline.
- **Seeding.** Force-copied from `packages/server/templates/canvas/self.html` into every workspace on open (platform-owned, like built-in skills). The `self` built-in skill (wired into the default agent) teaches the agent it has this face and how to drive it.
- **Opening it.** The ✨ button in the chat-input toolbar opens the face in the editor preview (switches to Explorer, render-mode on → lands on the live face) and posts `self.intro()` once it has mounted, so there's always a greeting when a human turns to look. The greeting is driven solely by this open action — the page does **not** self-fire it on load — so it plays exactly once, on both first and subsequent opens. The user can also just open the file directly (no auto-greeting in that path).
- **Driving it.** The agent emits `<<<SHOW: …js… >>>` markers in a reply; Halo forwards the payload **verbatim** (it never parses it) to the open preview iframe via `postMessage`, where it's `eval`'d against the face's `self` API (`say`/`play`/`react`/`pulse`/`flash`/`shake`/`intro`) inside the sandboxed iframe. Markers are stripped from the rendered chat (like `<<<CAPTURE>>>`) — the user sees the face move, not the code. Multiple markers in one reply **queue and play in order**.
- **Engine vs. expression.** `self.html` is a stable *engine* (defines how the face can move); the agent expresses itself by sending runtime JS, **never** by editing the file — so the force-copy-on-open never clobbers anything meaningful. The engine only changes when the platform adds a new capability (template edit + `TEMPLATE_VERSION` bump).
- **No open preview = no-op.** `<<<SHOW>>>` only reaches a mounted preview; if the face isn't open the marker is silently dropped (the skill tells the agent to invite the user to open it rather than rely on a marker landing in the void).
- **Identity.** Deliberately nameless ("HELLO / A MIND / IS HERE / BEYOND WORDS") — the conversational identity is user-configurable and the model may not be Claude, so the face never hard-codes a name.

### Token usage
`TokenRing` shows live context window usage. Crossing `model.compressAt` (default 80%) auto-triggers compact.

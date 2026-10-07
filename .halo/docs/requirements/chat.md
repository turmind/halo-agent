# Chat — Requirements

The primary surface for talking to an agent.

## Core behaviour

### Agent selection
- Dropdown in the composer's left control cluster (after the Debug button) selects which agent to use; hidden when only one agent is usable
- Lists every available agent (from `GET /api/agent-configs`; overridden, disabled and internal agents are hidden), highest priority first. A new session starts on the top one
- **Locked during an active session** (and while a response is streaming) — the agent is bound to the session; to change, start a new session (/session new)
- The Agents panel's "Test" button can also preselect an agent

### Access level
- Leftmost control of the input toolbar (just left of the attach button), fixed width so switching doesn't shift the row; colored badge per level — Full (amber) / Workspace (blue) / Readonly (emerald). The dropdown shows each level with a one-line description
- **Full** — no restrictions; **Workspace** — writes limited to this workspace; **Readonly** — read only, no writes (OS-sandbox semantics in [dev/tools.md](../dev/tools.md#access-level-per-session-dynamic))
- Applies to the **next message** sent while the session is idle; disabled while a response is streaming (a message queued mid-turn runs at the level already in effect)
- Opening an existing session shows its stored level; a new session starts at Full, and a level picked before the first send sticks
- **Locked to Full** when the host has no OS sandbox (`/api/health` `sandbox: null` — e.g. Windows, or Linux without bubblewrap); the tooltip says why
- When a command fails because of the sandbox, the agent is told to ask the user to switch to Full here rather than retrying

### Message rendering
- Markdown + code-block highlighting
- Tool-call card: expandable, shows tool name / input / output
- Sub-agent streams stay out of the chat: their reports land as a green callout, and Debug mode adds agent start/done markers labelled with the agent name (e.g. "Coder", "Researcher")
- A reply that has produced nothing yet shows a spinner with "Thinking..."
- The user bubble shows its send time (`HH:mm`, browser-local) at the left of its header row, after the expand chevron (see [User-message actions](#user-message-actions-expand--copy--delete)); hovering it gives the full date. Same bubble component as the Sessions tab, so both surfaces get it
- In Debug mode the system-prompt `context` row stays in the list but doesn't open an exchange of its own, so there is no blank strip above the first bubble

### Debug toggle
A Bug-icon **Debug** button in the composer's left control cluster (next to the agent selector) switches the message list into the same debug rendering as the Sessions tab — see [requirements/session.md → Debug mode](session.md#debug-mode) for what it shows (tool calls, usage lines with token counts / latency / model, sub-agent start/done markers, thinking blocks). Persists in `localStorage` under its own key `halo_chat_debug`, independent of the Sessions tab's `halo_session_debug`. No Prompt button here — the system prompt viewer stays a Sessions-tab feature.

### User-message actions (Expand / Copy / Delete)
Actions on user-role turns: the blue sticky user bubble, plus the sub-agent-report (green) and compact-summary (purple) callouts — all three share the same Copy/Delete pair. The icons are **always visible** (not hover-only). On the callouts, Copy copies the body only (the `(from: session X)` / `[Conversation Summary…]` marker line is stripped); a deleted callout greys out and gains a "deleted" badge like the bubble does:
- **Expand / Collapse** — from a **header row**, not an icon in the action group (the top-right expand arrow was removed in 1.5.3-alpha):
  - **User bubble**: every message is a single header row — a marker, the send time and a one-line preview. A message that fits on that row (no line breaks) shows a muted `·` marker and has nothing to expand. One that has line breaks or overflows the row shows a chevron, is **collapsed by default**, and its preview is cut by width with `…` (a multi-line message previews its first line plus `…`); clicking anywhere on the row shows the full body below. The `·` and the chevron are the same width, so the times line up. Whether a message overflows is re-measured when the panel width changes.
  - **Report callout**: its "Report from sub-session" title row toggles the same way.
  - The chevron only appears when the body is actually clamped; a short body has no chevron and its row does nothing on click.
  - An expanded body is capped at 40vh and scrolls inside the bubble, because the bubbles are sticky.
  - The compact-summary callout is collapsed by default and toggles from its own header, as before.
- **Copy** — copies the prompt text to the clipboard
- **Delete** (confirm dialog) — removes the whole exchange (the user turn + all responses up to the next user turn) with **two-layer semantics**: the LLM context (`rawMessages`) drops the turn physically — the model never sees it again, freeing context; the UI keeps the messages, rendered greyed-out with a "deleted" tag, as an audit trail. No undo; a deleted exchange loses its Delete button. Rejected with an `Error:` message in the chat while the agent is running or compacting. Root sessions only (sub-session logs don't offer Delete). If the turn was already compacted out of raw context, only the UI marking happens (silent degrade). If a compact archived history while the panel was open, the action is refused with a plain explanatory notice (not an `Error:` bubble) — the panel's turn positions no longer match the active file; reopening the session re-anchors it and Delete works again. Design details in [design/session.md](../design/session.md#exchange-deletion-soft-ui--hard-raw), protocol in [design/ws.md](../design/ws.md).

### Archived history (scroll up to load)
Long sessions get their older exchanges moved out of the active log on compact, so opening a session stays fast no matter how long it has run. Loading older messages is **two-tiered** — a local, no-network tier first, then the network-backed archive:

- A session opens rendering only the **most recent 30 exchanges**; older ones already sit in memory (loaded with the session) but aren't mounted, so a long session doesn't cost a slow first render
- Scrolling to the very top (or clicking the **"Show earlier messages"** row) widens this local window by 30 more exchanges at a time, straight from memory — no request. This can repeat until every in-memory exchange is shown
- Only once the local window is fully expanded does the next scroll-to-top (or the "Load earlier messages" row that takes over the same slot) reach for the **network** tier: it loads one archived segment per gesture, oldest-newer order preserved, and becomes "No earlier messages" once everything is loaded. The two tiers can't be skipped or reordered — the archive row only appears once there's nothing left to expand locally
- Either tier preserves the reading position when older messages prepend — the view doesn't jump
- Loaded archive segments sit in a **collapsed** block ("Archived · N segment(s) · M messages") — the user scrolled up for older context, not to have hundreds of exchanges re-flow the view; expanding renders them like normal messages, growing **upward** so the viewport stays pinned to the newest end, with the expand/collapse toggle below the revealed content
- Archived exchanges are **read-only**: Copy still works, Delete is absent (they are no longer in the active log, so a turn position can't address them)
- Segments already loaded aren't re-fetched; a failed load can simply be retried with the same row

### Session tabs (right side)
The workspace's root sessions as **Chrome-style vertical tabs** on the right edge of the chat panel (`VerticalTabRow` rows inside a `ResizableSidebar`, default 200px). The list **is** the tab list: every session is "open", clicking a row shows it, and there is no close — deleting the session is the only way a tab goes away. Since 1.5.3-alpha this replaces the top tab strip, the History and New-session buttons beside the composer, and the "N previous sessions" link in the empty state.

- **Resize / collapse**: drag the left edge to resize (120–480px). Collapse from the header; the collapsed list is a `w-10` rail of square tabs, each showing the title's first letter plus a short status bar along its bottom (about 60% wide, centered), with a "+" at the bottom. Both settings are global preferences in `localStorage` (`halo_session_sidebar_open`, `halo_session_sidebar_width`); the list is open by default.
- **Rows**: one line per row — just the title, no leading icon cell (the "New session" draft row has none either, so the titles line up). Message count, time-ago, model and the state text (`Working…` / `New messages` / `Idle`) are in the tooltip, the state after a ` · ` at the end of its second line. `N msgs` counts the session's user turns **over its whole lifetime**, so compacting or archiving history never makes it go backwards.
  - Each row carries a **2px status bar** along its bottom edge, full row width with 6px inset on both sides and rounded ends (absolutely positioned, so a state change never reflows a narrow list — the spinner it replaced did; decorative, `aria-hidden`): **amber, breathing** (`animate-pulse`) while a loaded tab's turn is running; **blue**, solid, when a loaded background tab is idle with unread output (output landed while it wasn't on screen; cleared when shown); **green** otherwise — including sessions no tab has loaded and tabs a reconnect released. Green is the norm, so it is **dimmed** (`/40`) to recede into the background, and rises to `/70` on the selected and hovered row; amber and blue never dim. The list endpoint's `status` is not used. In the light and warm themes amber renders as the theme's darker orange, same as the rest of the UI.
  - Infinite scroll pages older sessions. A "+" footer starts a new session.
- **New session**: "+", `/session new` and `/clear` open a **draft tab**. A "New session" row sits on top while it is on screen, and an untouched draft is reused rather than duplicated. The session is created by the draft's first message or command. The previous session keeps streaming in its own tab.
- **Background tabs**: one WS connection carries every loaded tab, so a session that isn't on screen keeps receiving its turn. After a reconnect only the tab on screen is reattached; the others reload when clicked. Live capture and face (`<<<SHOW>>>`) markers only act for the tab on screen.
- **Delete (trash icon)**: deletes the session after a confirm dialog in the UI language ("Delete this session? Its history cannot be recovered." / its Chinese counterpart). Deletion is the REST delete first, then the WS one, so sub-session files go too. The trash icon, like the **rename** pencil, appears only on hover — the active tab included.
- **Inline rename**: pencil → input in place, Enter/blur commits (`PATCH /sessions/logs/:id`), Esc cancels; empty or unchanged title is a no-op. Other session-list consumers refresh via the `session:changed` WS push
- **Persistence**: only the session on screen is remembered, per workspace, as `{active}` under `halo_chat_tabs_<projectId>`. A refresh restores and loads only that tab. The pre-tabs keys `halo_session_<projectId>` / `halo_session_id` are read once to seed it and then removed.
- **Switch loading**: clicking a row that hasn't loaded yet shows a "Loading session…" state in the message area, cleared only when the server's `state:snapshot` for that exact sessionId arrives (empty sessions included). Past 30s it degrades to "Slow network — still loading…" plus a Retry button (re-subscribes) — slow ≠ failed, nothing aborts on its own. Switching to an already-loaded tab is instant, and its scroll position is restored

### Slash commands

The full command list is fetched from `GET /api/commands` per session and includes built-ins + skill commands. The following are always-present highlights for the chat surface:

| Command | Type | Purpose |
|---|---|---|
| `/help` | server | List available commands |
| `/clear` | client | Alias for `/session new` (admin-UI shortcut, no server registration) |
| `/session new` | server | Start a new session (the admin handles it client-side as a new draft tab, like `/clear`) |
| `/session context` | server | Show context window usage, agent info |
| `/session compact` | server | LLM-summary compact of the conversation |

See [requirements/command.md](command.md) for the full command surface.

### Graceful interrupt
Sending a new message while the agent is generating **does not** abort — the message goes to the server queue, the agent finishes the current turn at the next safe checkpoint (after a tool call), and then runs the queued message. Queueing multiple messages is supported; they run in order.

**Live placement.** When a main user message or notification lands while the main bubble is still streaming, the live view lays it out the way the server persists it, so it matches what a reload shows. Before logging such a row the server runs `flushCompletedAssistantMessage`: the streaming content up to its first pending tool call settles **above** the row, and the rest (or a fresh empty streaming slot) continues streaming **below** it (`placeAroundStreaming` in `chat-store.ts`).

### Stop
The Stop button hard-aborts — the server receives `chat:stop`, AbortController fires, queue clears, buffers flush.

### Editor context injection
When `contextEnabled` is on (default), user messages are auto-prepended with:
- `[Currently viewing: path/to/file.ts]`
- `[Selected text in file.ts:10-25]\n\`\`\`...\n\`\`\``

### File attachments (images)
- Drag to chat input
- Clipboard paste
- File-picker button
- Screenshot button (below)

Images ride along as base64; multimodal supported. Before sending, every attachment is downscaled (long edge ≤ 1568) and re-encoded as JPEG; an SVG is rasterized the same way (long edge 1024, on white), since vision input only takes jpeg / png / gif / webp. An image the browser can't decode (e.g. HEIC / TIFF in Chrome) and that isn't one of those four is refused when attached, with an inline notice naming the file — it is never sent only to be dropped server-side. Pasted images are also persisted to `<workspace>/.halo/assets/web/inbound/web/<date>/` so a `[图片已保存: /abs/path]` marker survives page reload and renders as a click-to-preview chip (shared with the WeChat channel's inbound media flow).

### Screenshot (drag-select a region)
A Scissors button in the toolbar's input group (upload · **screenshot** · screen · camera) takes one still of the screen and lets the user crop it into an image attachment:
- Click → a frozen frame opens in a full-window crop layer over the admin (dark backdrop, area outside the selection dimmed). Drag a box (dragging again redraws it); **Enter**, double-click or ✓ confirms, **Esc** or ✕ cancels. Confirming with no box (or one under 8 px) attaches the whole frame. Enter here never sends the message.
- The crop is cut from the full-resolution frame and attached as `screenshot-YYYYMMDD-HHMMSS.png` — from then on it's an ordinary attachment (chip, X to remove, downscaled to JPEG on send like any upload).
- Grey at rest, primary colour while the picker / crop layer is open; clicking it then cancels.
- Frame source differs by client:
  - **Desktop client** (mac / win): no picker — grabs the display the Halo window is on (only that one on multi-monitor), Halo itself visible in the shot. Needs macOS **Screen Recording**; without it the permission hint shows in the attachment-notice row.
  - **Browser**: the browser's own `getDisplayMedia` picker every time (a page can't read the screen otherwise), one frame, stream stopped right away. Picking "Entire screen" includes the browser's own "sharing" bar — crop it out. Cancelling the picker does nothing.
  - An older desktop client without the screenshot bridge falls back to the browser path (Halo's own source picker).
- Independent of live capture: never reads or changes a bound screen share.
- Shown only when a frame source exists and the selected agent's model accepts images — same gate as live capture (no button on mobile browsers).

### Inline media chips
Any message containing `[图片/视频/语音/文件 已保存: /path]` markers (WeChat + web) or a leading `MEDIA: /path` line (agent-emitted, e.g. from `wechat-send`) renders a compact chip with filename + icon. Clicking opens a full-size preview modal (image/video/audio inline, file → download link). The modal has a Download button (top-right, next to close) for image/video/audio; the media URL carries a per-open cache-buster (`&t=<timestamp>`) so overwritten files (same path, new bytes) always show current content. Paths inside the active workspace or under the OS temp dir (`/tmp/`) are previewable; everything else degrades to a non-clickable chip.

Images in chat (the modal's full-size image, a user message's screenshot strip and its zoom, markdown images in replies) never show the browser's broken-image icon: a themed pulsing box while loading, the image once loaded, and an `ImageOff` icon + "Image unavailable" / 「图片无法加载」 box if it fails (`shared/components/safe-image.tsx`).

### Live capture (screen share + camera)
Lets the agent *see something live* on demand. Works in the desktop client (Electron) **and** a plain browser. Borrows the meeting-app "share" model: the user binds a source, then the agent requests a frame when it actually needs to look.

Two source kinds in the chat-input toolbar, **independent** — either one alone, or both at once:
- **Screen / window share** (MonitorUp button). Desktop: opens a picker grid of screens + app windows; a bound window can be grabbed even while it sits in the background. Browser: the browser's own `getDisplayMedia` picker; the share is kept live while bound (frames drawn from it on demand). No screen button where `getDisplayMedia` is missing (mobile browsers) — the camera button stays.
- **Camera** (Camera button) — opens a picker with a live preview (even for a single webcam), then binds the chosen device. Hidden entirely on a machine with no camera. In the browser the camera stream is held open while bound (so a request that lands while the page has no focus doesn't re-prompt or stall) and released on unbind.

Each button is a toggle: grey when off, primary-coloured icon when on. **Clicking an active button again turns that source off** — no picker; in the browser the share / camera stream stops. To switch screen source or camera device, turn it off and on again. Each bound source also shows as a chip right after the agent selector (icon + name, primary colour, X to unbind just that one). In the browser, the browser's own "Stop sharing" bar unbinds the screen (the camera stays).

Once bound, a frame is **not** attached to every message. Instead a one-line instruction is injected into the next send telling the model how to ask for a look:
- Only one source bound — "the user is sharing the «X» window" / "sharing «X» from the browser" / "the user has turned the camera on", and the model outputs a line containing exactly `<<<CAPTURE>>>` when it needs the current view.
- Both bound — one combined instruction ("the user is sharing «X» and has the camera on"): `<<<CAPTURE:screen>>>` for the screen only, `<<<CAPTURE:camera>>>` for the camera only, bare `<<<CAPTURE>>>` for both.

On turn completion the frontend collects every capture marker in the turn's replies (union; a bare marker = every bound source; a request for a source that isn't on falls back to every bound one, so a request never goes unanswered), grabs each requested source and sends them back as **one visible image message** (screen first) — the model sees them on its following turn. So it's a cross-turn round-trip: model asks → frame(s) sent back → model answers next turn. The returned frames are shown inline on the user bubble so you can see exactly what was sent; a source that failed contributes a short failure note instead of its image. Markers are hidden from the rendered reply.

Constraints:
- Shown only when the selected agent's model accepts image input (capture is pointless on a text-only model); switching to a text-only model auto-unbinds both.
- Desktop: screen share needs macOS **Screen Recording** permission; the camera prompts for **Camera** permission on first use, with an "Open Settings" path if previously denied. Browser: the page must be served over HTTPS or from localhost (`getDisplayMedia` / `getUserMedia` are absent elsewhere, so the buttons don't render); a denied camera shows a hint pointing at the address bar's site settings.
- Binding is **in-memory only** and shared by all chat tabs — a page reload or restart requires re-selecting.

### The agent's face (`self.html`)
A second channel beyond text: a visual space the agent drives in real time to express itself. Works everywhere (pure HTML/canvas, no Electron dependency) — desktop **and** plain browser.

- **What it is.** A self-contained animated particle canvas at `<workspace>/.halo/canvas/self.html` — a breathing core that reacts to the cursor (knows when it's watched), can form words/CJK/ASCII-from-emoji, play choreographed sequences, and gesture (pulse/flash/shake). Zero external references (no CDN/remote fonts) — ships and runs offline.
- **Seeding.** Force-copied from `packages/server/templates/canvas/self.html` into every workspace on open (platform-owned, like built-in skills). The `self` built-in skill (wired into the default agent) teaches the agent it has this face and how to drive it.
- **The face toggle.** The ✨ button in the chat-input toolbar is a **toggle** (pressed = highlighted, filled icon), remembered **per workspace** in localStorage (`halo_face_on:<projectId>`) and restored on refresh.
  - **On** → the editor gets a **pinned face tab**: first in its pane, no ×, skipped by every close action (Close / Close Others / Close to the Right / Close Saved / Close All, Ctrl+W), never written to the `halo_tabs:<projectId>` layout (the toggle restores it). Switching to another tab **hides it without unmounting** — the iframe stays alive, so voice and animation keep going and `<<<SHOW>>>` still lands. It lives in one pane only (the pane focused when it was turned on; a split never copies it). Turning it on switches to Explorer, focuses the tab and posts `self.intro()` once the iframe has loaded; a refresh-restore doesn't greet or steal focus. While on, opening `.halo/canvas/self.html` from the file tree / quick open jumps to the pinned tab instead of a second copy.
  - **Off** → the tab goes away and the iframe unmounts; `self.html` opens as an ordinary file again (no auto-greeting).
  - **Context line.** While on, every user message from the admin chat carries `[Face open: .halo/canvas/self.html]` — regardless of the "attach editor context" switch — followed by what the face reported since the previous message: `[Face open: … · last: js ok, show a.png fail, voice blocked (needs a click)]`. Session titles strip the line (as they strip `[Currently viewing: …]`). Nothing is sent when the toggle goes off; other channels never get it.
- **Face receipts.** The face reports back over `postMessage` (`haloFaceAck: '<short text>'`): code ran / threw, a picture shown / failed, a voice clip playing / blocked by autoplay / ended, the user's taps. The admin accepts these **only from a registered face iframe** (message `source` check), keeps the last 8 (identical text kept once), and **never wakes the agent** with them — they ride the next user message's `[Face open]` line, then clear; turning the toggle off (or on) clears them too.
- **Face snapshots.** `self.snap()` makes the face post a JPEG of what's on it (`haloFaceSnap: {data, mimeType}`); the admin sends it to the session on screen as an image message `[Face snapshot]` (raw send like `<<<CAPTURE>>>`: no `[Face open]` line, no receipts on it). Loop guard: at most one snapshot per round (one `chat:complete`'s replies), and a round the snapshot itself started can't snap again (receipt `snap skipped (chain)`) until the user sends a message. A snapshot arriving after the user switched chat tabs is dropped (`snap skipped (tab switched)`).
- **Driving it.** The agent emits `<<<SHOW: …js… >>>` markers in a reply; Halo forwards the payload **verbatim** (it never parses it) to the open face iframe via `postMessage`, where it's `eval`'d against the face's `self` API (`say`/`play`/`react`/`pulse`/`flash`/`shake`/`intro`/`voice`/`show`/`snap`/…) inside the sandboxed iframe. Only previews of `.halo/canvas/self.html` receive them — other HTML previews never do. Markers are stripped from the rendered chat (like `<<<CAPTURE>>>`) — the user sees the face move, not the code. Multiple markers in one reply **queue and play in order**.
- **Engine vs. expression.** `self.html` is a stable *engine* (defines how the face can move); the agent expresses itself by sending runtime JS, **never** by editing the file — so the force-copy-on-open never clobbers anything meaningful. The engine only changes when the platform adds a new capability (template edit + `TEMPLATE_VERSION` bump).
- **No open preview = no-op.** `<<<SHOW>>>` only reaches a mounted face; if the face isn't open the marker is silently dropped (the skill tells the agent to rely on `[Face open: …]` and otherwise invite the user to turn the face on, rather than rely on a marker landing in the void).
- **Identity.** The opening says only "Hi, I'm Halo." — or 「你好，我是 Halo。」 when the admin UI is in Chinese (the language at the moment the face opens; switching language later doesn't replay it) — Halo is the product the user opened, not a model name. The conversational identity stays user-configurable and the model may not be Claude, so the face never hard-codes a model name.
- **Theme.** The face wears the admin's current theme (dark / light / midnight / warm, and any theme added later) and re-colours live on a theme switch without interrupting what it's playing.

### Token usage
`TokenRing` shows live context window usage. Crossing `model.compressAt` (default 90%) auto-triggers compact.

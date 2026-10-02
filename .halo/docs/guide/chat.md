# Chat — User Guide

The Chat panel at the bottom is the main surface for talking to an agent.

## Picking an agent

The dropdown to the left of the input lists every agent (global + workspace).

- The agent with the highest `priority` is auto-selected for new sessions. The seed `Default` agent uses `priority: 99`, so it wins until you raise another agent above it.
- Once you manually pick an agent, that choice is remembered across `clear` / new sessions until you pick something else.
- **A conversation is locked to one agent**: once you start chatting, the dropdown locks. To change agent, start a new session (`/session new`).

## Access level

The leftmost button of the input toolbar sets what the agent is allowed to change:

- **Full** — no restrictions.
- **Workspace** — the agent can read anywhere but write only inside this workspace. Credential files such as `~/.gitconfig` and `~/.git-credentials` are hidden from it. `git commit` still works, using your git name and email.
- **Readonly** — the agent can't write anything.

A change applies from the next message you send, and the level is saved per session. If a command fails because of the level, the agent will ask you to switch to Full instead of retrying. The button is locked to Full when the host can't enforce the other levels (Windows, or Linux without bubblewrap). On macOS the built-in `sandbox-exec` is used.

## Sending messages

- Enter to send
- Shift+Enter for a newline
- The agent streams its reply; tool calls render inline as cards

## Context injection

Next to the chat is a `📎 Context` toggle (on by default). When on, Halo auto-injects:
- The currently open file path: `[Currently viewing: src/foo.ts]`
- The editor's current selection: `[Selected text in foo.ts:10-25]\n\`\`\`...\n\`\`\``

Turn it off if you don't want that context injected.

## `@` file mention

Typing `@` in the input opens a file search:
- Real-time fuzzy matching (150 ms debounce)
- Selecting inserts a path chip
- You can `@` multiple files back-to-back

The search scans the whole project on the server — independent of Explorer expansion state.

## Attachments

- **Drag**: drop files onto the input
- **Paste**: paste an image from the clipboard
- **Button**: click the 📎 on the left

Images are sent to the agent as base64, with multimodal support (Claude 4.6 can see images).

## Slash commands

Typing `/` opens autocomplete.

Most commands are noun-verb **object commands**: `/<obj> <verb> [args]`. Bare `/<obj>` (or `/<obj> help`) lists the verbs you're allowed to run.

| Command | Purpose |
|---|---|
| `/session <verb>` | Manage sessions — `new` / `list` / `switch <n>` / `stop` / `interrupt` / `compact` / `context`. All built-in, available to everyone. `new` starts a fresh conversation (old session stays in the sidebar; running sub-agents keep going); `compact` keeps the most recent N messages intact (N defaults to 5, `general.compact.keep_messages`); `context` shows token usage, agent info, and available tools |
| `/clear` | Admin-UI alias for `/session new` |
| `/agent <verb>` | Manage agents — `list` / `switch <name\|index>` / `desc` (built-in, open to all) · `delete` (built-in, full access) · `create` / `update` (handled by the `agent` skill, full access) |
| `/skill <verb>` | Manage skills — `list` / `desc` (built-in, open to all) · `disable` / `enable` (built-in, workspace access) · `delete` (built-in, full access) · `create` / `update` (handled by the `skill` skill, full access) |
| `/workspace <verb>` | Manage the workspace — `info` (built-in, open to all) · `switch <path>` (built-in, full access) · `setup` / `tidy` (workspace skill, workspace access; init / reorganize `.halo/` INDEX.md / INSTRUCTIONS.md / memory/) · `share` (workspace skill, full access; export a shareable bundle) |
| `/cron <verb>` | Scheduled agent runs — `create` / `list` / `update` / `enable` / `disable` / `delete` (cron skill, full access) |
| `/acp <verb>` | Talk to other agents over ACP — `kiro <q>` / `claude <q>` ask a local agent directly; `add` / `list` / `remove` manage generated `ask-<label>` bindings (acp skill, full access) |
| `/evo [hint]` | Queue a self-evolution run on this session (full access only) |
| `/help` | List every command — object commands only show the verbs you can run |

Skills can also register slash commands (put `command: /xxx` in the SKILL.md frontmatter).

### WeChat channel commands

If you're chatting from WeChat, the same shared commands are available (routed through the common command dispatcher), plus one WeChat-specific extra:

| Command | Purpose |
|---|---|
| `/session new` | Create a new session; old sessions stay accessible via `/session list` + `/session switch` (nothing is archived) |
| `/session list` | List recent sessions (newest first); the active one is marked `→` |
| `/session switch <index>` | Switch the active session to the indexed one (readonly bot 仅能切到自己的 [我] 会话) |
| `/workspace info` / `/workspace switch <path>` | Show or switch workspace (absolute path; 切换仅 full 权限 bot 可用) |
| `/qr [level]` | Generate an invite QR for a new bot account (full 权限 bot 专用) |
| `/help` | Show help |

If the session is currently compacting or busy when your message arrives, you'll see a hint — ("⏳ integrating context…" / "🔄 queued…") — and the message is queued either way, processed as soon as the compact / current turn finishes. This includes messages sent while an auto-compact is running mid-turn — they run right after it ends.

## Interrupt vs Stop

Three ways to cut in while the agent is running:

**Send another message (soft)**: the message is queued on the server; the agent finishes the tool it's on, wraps up the turn, then runs the queued message. Multiple messages can queue in order. A running command is not killed.

**Esc — interrupt** (with the input box empty): aborts the turn immediately, including a tool or command mid-run, then any messages queued while it ran fold into one follow-up turn — the agent keeps going with what you said. Same as `/session interrupt`.

**⏹ — stop**: aborts the turn immediately and nothing runs afterwards. Messages queued while it ran aren't lost — they're kept in the conversation history and the agent sees them the next time you send something. Same as `/session stop`.

**Exception — compaction.** During a manual `/session compact`, Esc and ⏹ both cancel it — history is rolled back and you'll see `Compact cancelled`. An auto-compact (triggered mid-turn when context reaches `compressAt`) can't be cancelled: Esc or ⏹ during it only takes effect once the compact finishes, and then works as above.

## Token ring

The ring in the bottom-right of the input shows context window usage:
- Green: < 50%
- Yellow: 50–70%
- Orange: 70–90%
- Red: > 90%

Reaching `compressAt` (default 90%, setting `general.compact.compress_at`) auto-triggers compact. If the LLM summary fails or times out, Halo falls back to a local compact (notice: `Auto-compacted N older messages (local fallback — LLM summary failed: <reason>)`) rather than retrying. An auto-compact has no overall time limit — it only times out after 10 minutes with no data from the model. While the agent is running you can't click the TokenRing (guarded by `isStreaming`).

## Session history

Your sessions are listed as vertical tabs on the right edge of the chat panel:
- Lists the workspace's main sessions, newest first; scroll down to load older ones
- Click a tab to show that session. The one you left keeps running and streaming in its own tab: a spinner shows while it works, and a dot means new output arrived
- **+** (or `/session new`) opens a fresh tab; the session is created when you send its first message
- Hover a tab to rename it (pencil); ✕ deletes it after a confirmation — deletion can't be undone
- Drag the list's left edge to make it wider or narrower, or collapse it to a thin strip of initials
- After a refresh, the session you were on reopens

For full inspection, use the Activity Bar's "Sessions" tab — Debug mode lets you inspect tool calls, system prompts, usage, etc.

Long messages you sent are collapsed to a one-line header: a chevron, the send time and the first few words. Click the header to expand or collapse it. A long expanded message scrolls inside its bubble. Sub-agent reports open and close from their title line the same way.

## Common situations

**"Queued" hint**: the previous turn hasn't finished; your message is queued and will run next turn.

**"Rate limited, retrying in Xs..."**: Bedrock throttled; automatic exponential backoff (up to 5 retries).

**A sudden `[Message from xxx]`**: a sub-agent finished and auto-reported back to the parent agent's conversation.

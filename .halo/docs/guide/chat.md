# Chat — User Guide

The Chat panel at the bottom is the main surface for talking to an agent.

## Picking an agent

The dropdown to the left of the input lists every agent (global + workspace).

- The agent with the highest `priority` is auto-selected for new sessions. The seed `Default` agent uses `priority: 99`, so it wins until you raise another agent above it.
- Once you manually pick an agent, that choice is remembered across `clear` / new sessions until you pick something else.
- **A conversation is locked to one agent**: once you start chatting, the dropdown locks. To change agent, start a new session (`/session new`).

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
| `/ws <verb>` | Manage the workspace — `info` (built-in, open to all) · `switch <path>` (built-in, full access) · `setup` / `tidy` (ws skill, workspace access; init / reorganize `.halo/` INDEX.md / INSTRUCTIONS.md / memory/) · `share` (ws skill, full access; export a shareable bundle) |
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
| `/ws info` / `/ws switch <path>` | Show or switch workspace (absolute path; 切换仅 full 权限 bot 可用) |
| `/qr [level]` | Generate an invite QR for a new bot account (full 权限 bot 专用) |
| `/help` | Show help |

If the session is currently compacting or busy when your message arrives, you'll see a hint — ("⏳ integrating context…" / "🔄 queued…") — and the message is queued (while compacting it's dropped; while busy it's kept).

## Interrupt vs Stop

Two ways to interrupt the agent:

**Graceful interrupt**: send another message during streaming. The message is queued on the server; at the next tool-call checkpoint, the agent wraps up the current turn and then runs the queued message. Multiple messages can queue in order.

**Hard stop**: click the red ⏹ button. Immediate abort, queue cleared, no checkpoint waiting.

## Token ring

The ring in the bottom-right of the input shows context window usage:
- Green: < 50%
- Yellow: 50–70%
- Orange: 70–90%
- Red: > 90%

Reaching `compressAt` (default 70%) auto-triggers compact. While the agent is running you can't click the TokenRing (guarded by `isStreaming`).

## Session history

Next to the header is the session-list dropdown:
- Lists every session in the current workspace
- Click to switch (the current one auto-saves + detaches)
- Sub-agent sessions show as indented entries

For full inspection, use the Activity Bar's "Sessions" tab — Debug mode lets you inspect tool calls, system prompts, usage, etc.

## Common situations

**"Queued" hint**: the previous turn hasn't finished; your message is queued and will run next turn.

**"Rate limited, retrying in Xs..."**: Bedrock throttled; automatic exponential backoff (up to 5 retries).

**A sudden `[Message from xxx]`**: a sub-agent finished and auto-reported back to the parent agent's conversation.

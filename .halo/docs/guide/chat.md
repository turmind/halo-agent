# Chat — User Guide

The Chat panel at the bottom is the main surface for talking to an agent.

## Picking an agent

The dropdown to the left of the input lists every agent (global + workspace).

- The agent with the highest `priority` is auto-selected for new sessions. The seed `Default` agent uses `priority: 99`, so it wins until you raise another agent above it.
- Once you manually pick an agent, that choice is remembered across `clear` / new sessions until you pick something else.
- **A conversation is locked to one agent**: once you start chatting, the dropdown locks. To change agent, start a new session (`/new`).

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

| Command | Purpose |
|---|---|
| `/new` | Start a new conversation (old session stays in the sidebar; any running sub-agents keep going in the background) |
| `/clear` | Alias for `/new` |
| `/compact` | LLM compresses the current conversation's context (keeps the most recent N messages intact, summarises the rest; N defaults to 5, configurable via `general.compact.keep_messages`) |
| `/context` | Show current token usage, agent info, and available tools |
| `/stop` | Stop the running agent task |
| `/list` | List recent sessions |
| `/switch <n>` | Switch active session by index |
| `/agents` | List available agents |
| `/agent <name|index>` | Start a session with a specific agent |
| `/ws [path]` | Show or switch workspace |
| `/note [hint]` | Queue a self-evolution run on this session (requires `general.evolution.level: L1`) |
| `/help` | List every command |
| `/organize-workspace` | Set up or reorganize `.halo/` (INDEX.md / INSTRUCTIONS.md / memory/). Init mode for new workspaces; organize mode reviews and prunes existing ones — backed by the `organize-workspace` skill |

Skills can also register slash commands (put `command: /xxx` in the SKILL.md frontmatter).

### WeChat channel commands

If you're chatting from WeChat, a different set of commands is available (handled by the WeChat channel, not the normal command registry):

| Command | Purpose |
|---|---|
| `/new` | Create a new session; old sessions stay accessible via `/list` + `/switch` (nothing is archived) |
| `/list` | List recent sessions (newest first); the active one is marked `→` |
| `/switch <index>` | Switch the active session to the indexed one (readonly bot 仅能切到自己的 [我] 会话) |
| `/ws` / `/ws <path>` | Show or switch workspace (absolute path; 切换仅 full 权限 bot 可用) |
| `/name` / `/name <new>` | Show or rename the bot |
| `/send <path>` | Send a workspace file as WeChat media |
| `/organize-workspace` | Set up or reorganize `.halo/` in this workspace |
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

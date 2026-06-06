# Command — Requirements

Unified command processing — all slash commands (built-in + skill) are dispatched through `dispatchCommand` (channels/shared/commands.ts) and discoverable via REST.

## Built-in commands

Source: [commands/index.ts](../../../packages/server/src/commands/index.ts) (descriptors) + [channels/shared/commands.ts](../../../packages/server/src/channels/shared/commands.ts) (execution)

| Name | Slash | Type | Purpose |
|---|---|---|---|
| `help` | `/help` | client | List commands |
| `new` | `/new` | server | Start a new session |
| `clear` | `/clear` | client | Alias for `/new` |
| `list` | `/list` | server | List recent sessions |
| `switch` | `/switch` | server | Switch active session by index |
| `stop` | `/stop` | server | Stop the running agent task (ends the turn, does not re-run) |
| `interrupt` | `/interrupt` | server | Interrupt the running turn immediately — aborts a command mid-execution, then folds any messages queued while busy into one follow-up turn. Esc in TUI / admin chat maps to this. |
| `compact` | `/compact` | server | LLM-summary compact of the conversation |
| `context` | `/context` | server | Show workspace, agent, model, tools, skills, and every loaded markdown / prompt file (each `prompts/<scope>/*.md` listed individually; built-in fallback shown as a single entry) |
| `agents` | `/agents` | server | List available agents |
| `agent` | `/agent` | server | Start a new session with a specific agent |
| `ws` | `/ws` | server | Show / switch workspace |
| `note` | `/note [text]` | server | Trigger self-evolution on the current root session: snapshot the conversation + queue an evo run. Optional text becomes a hint for what to focus on. Available only when `general.evolution.level=L1`. See [plans/self-evolution.md](../plans/self-evolution.md). |

Session lifecycle actions (`session:clear`, `session:delete`) are handled inline by the WS handler, not as slash commands.

## Cross-channel commands

All channels (WS, WeChat, Telegram, Web, CLI/TUI) share `dispatchCommand` for common commands. Channel-specific commands (e.g. WeChat `/name`, `/send`) are handled in the channel handler before reaching the shared dispatch.

## Skill-as-command

Skills whose SKILL.md frontmatter carries a `command` field auto-register as slash commands:

```yaml
---
name: Code Review
description: Review code changes
command: /review
---
```

When triggered, the skill body is read from disk and sent to the agent session as a message:

```
[Skill activated: /review]

{SKILL.md body}

{user args}
```

Every `GET /api/commands?projectId=xxx` rescans skill directories.

## Command discovery API

```
GET /api/commands?projectId=xxx
→ { commands: CommandDescriptor[] }
```

Returns every non-hidden command (built-in + skill). The frontend calls this on project switch to populate the command palette.

## Adding a new command

A server-handled command lives in **three** places that must stay in sync —
miss any one and the server either throws at startup or silently no-ops:

1. Add a `exec<Name>` function in `channels/shared/commands.ts`
2. Add a case to the `dispatchCommand` switch (same file)
3. Add the slash name to the `DISPATCH_COMMANDS` array (same file) — this is the
   list the startup sanity check in `index.ts` compares against the registered
   descriptors. It is **not** derived from the switch; forgetting it throws
   `Command descriptors without a dispatch case: /<name>` and the server exits.
4. Register a descriptor in `commands/index.ts` via `commandRegistry.registerDescriptor()`

The startup check is bidirectional: every `type:'server'` descriptor must appear
in `DISPATCH_COMMANDS`, and every entry in `DISPATCH_COMMANDS` must have a
descriptor (else `Dispatch cases without a descriptor: /<name>`). Client-only
commands (e.g. `/clear`) belong in neither — they're handled in the frontend.

Implementation details in [design/command.md](../design/command.md).

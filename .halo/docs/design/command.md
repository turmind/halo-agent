# Command — Design

Unified command processing layer — all channels (WS, WeChat, Telegram, Web, CLI/TUI) share a single dispatch path.

## Architecture

```
Channel handlers          Shared layer                  SessionManager
──────────────            ────────────                  ──────────────
WS handler ─────┐
WeChat handler ──┼──►  dispatchCommand()  ──────────►  SM methods
Telegram handler ┤     (channels/shared/commands.ts)   (compact, create, delete, …)
Web handler ─────┤
CLI/TUI ─────────┘        │
                           └── execSkillCommand()       (skill fallback)
                               (commands/skill-command.ts)
```

WS handler special-cases `compact` because it needs UI progress callbacks: `compact` → `sm.compactSession(sid, { onProgress })` directly. Every other command routes through `dispatchCommand`.

## Key modules

| Module | File | Purpose |
|---|---|---|
| `dispatchCommand` | `channels/shared/commands.ts` | Single switch routing all slash commands to exec functions |
| `CommandRegistry` | `commands/registry.ts` | Listing-only — stores `CommandDescriptor` for REST `/api/commands` discovery |
| `scanSkillDescriptors` | `commands/skill-command.ts` | Scan skill dirs → return `CommandDescriptor[]` for registry |
| `execSkillCommand` | `commands/skill-command.ts` | Execute a skill slash command (read SKILL.md, render, send to SM) |

## Command dispatch flow

1. Channel receives a slash command from user input (or WS `command:<name>` message)
2. Channel builds a `CommandContext` (shared interface: sm, userId, sessionPrefix, accessLevel, workspacePath, lang)
3. Channel calls `dispatchCommand(ctx, '/command', args)`
4. `dispatchCommand` switch matches built-in commands → calls `exec*` functions
5. Default case: tries `execSkillCommand` as fallback for skill-defined slash commands
6. Returns `CommandResult { text, switchTo?, workspace? }` — channel formats and sends to user

## File structure

```
packages/server/src/commands/
  types.ts           — CommandDescriptor interface
  registry.ts        — CommandRegistry (listing-only, for REST discovery)
  skill-command.ts   — scanSkillDescriptors() + execSkillCommand()
  index.ts           — Registry singleton + built-in descriptor registration

packages/server/src/channels/shared/
  commands.ts        — dispatchCommand(), all exec* functions, CommandContext, CommandResult
```

## Frontend integration

- `features/chat/slash-commands.ts` — `refreshCommands(projectId)` pulls from REST API and merges client-only fallbacks
- `features/chat/use-chat.ts` — handles client-only commands locally; server commands sent as `command:<name>` via WS
- `features/chat/chat-panel.tsx` — calls `refreshCommands()` on project switch

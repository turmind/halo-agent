# Command — Requirements

Unified command processing — all slash commands (built-in + skill) are dispatched through `dispatchCommand` (channels/shared/commands.ts) and discoverable via REST.

## Built-in commands

Source: [commands/index.ts](../../../packages/server/src/commands/index.ts) (descriptors) + [channels/shared/commands.ts](../../../packages/server/src/channels/shared/commands.ts) (execution)

Top-level slash commands: `/help` `/evo` `/session` `/agent` `/skill` `/ws` `/cron` `/acp`.

| Name | Slash | Type | Purpose |
|---|---|---|---|
| `help` | `/help` | client | List commands — object commands show only the verbs the user can run; a command is hidden entirely if no verb is runnable |
| `evo` | `/evo [text]` | server | Flat command (no verbs), **full-only**. Trigger self-evolution on the current root session: snapshot the conversation + queue an evo run. Optional text becomes a hint for what to focus on. Available only when `general.evolution.level=L1`. See [plans/self-evolution.md](../plans/self-evolution.md). |

The rest are noun-verb **object commands**: `/<obj> <verb> [args]`. Some verbs are built-in deterministic code (`SUBCOMMAND_ROUTES`); the others fall through to the same-name skill (LLM, dispatched via `$1`). Bare `/<obj>` or `/<obj> help` lists the verbs available to the user (filtered by access level).

| Command | Verbs (access) |
|---|---|
| `/session` | new / list / switch \<n\> / stop / interrupt / compact / context — all built-in, all users (readonly can only switch its own sessions) |
| `/agent` | list / switch / desc (built-in, no gate) · delete (built-in, full) · create / update (skill verb, full) |
| `/skill` | list / desc (built-in, no gate) · disable / enable (built-in, workspace) · delete (built-in, full) · create / update (skill verb, full) |
| `/ws` | info (built-in, no gate) · switch (built-in, full) · setup / tidy (skill verb, workspace) · share (skill verb, full) |
| `/cron` | create / list / update / enable / disable / delete — all skill verbs, full |
| `/acp` | kiro / claude (ask a local agent directly; question = rest of line) · add / list / remove (manage generated ask-* bindings) — all full |

Session lifecycle actions (`session:clear`, `session:delete`) are handled inline by the WS handler, not as slash commands.

## Cross-channel commands

All channels (WS, WeChat, Telegram, Web, CLI/TUI) share `dispatchCommand` for common commands. Channel-specific commands (e.g. WeChat `/name`) are handled in the channel handler before reaching the shared dispatch.

## Skill-as-command

Skills whose SKILL.md frontmatter carries a `command` field auto-register as slash commands:

```yaml
---
name: code-review
description: Review code changes
command: /review
---
```

Related frontmatter fields:

- `verbs` (Halo extension) — declares subcommands, each `{ name, builtin?, requiresAccess?, desc? }`; `builtin: true` means the verb is handled by platform code (declarative — actual routing is `SUBCOMMAND_ROUTES`); a skill verb's access gate is what's declared here.
- `user-invocable: false` (standard) — never becomes a slash command; the model can still activate the skill.
- `disable-model-invocation: true` (standard) — command exists but the skill is not injected for model auto-activation.

When triggered, the skill body is read from disk and sent to the agent session as a message:

```
[Skill activated: /review]

{SKILL.md body}
```

User args are filled via `$ARGUMENTS` / `$1`–`$9` placeholders (args are no longer appended verbatim to the body end); a verb reaches the body as `$1` for dispatch.

Every `GET /api/commands?projectId=xxx` rescans skill directories.

### Conflict detection

A skill's `command` must not collide with a built-in slash command or with another skill's. Collisions are resolved at scan time in `scanSkillDescriptors`, the single source feeding both dispatch and the discovery API:

- **Built-ins always win** — a skill command colliding with a built-in is not registered as a command. This is by design for object commands: their same-name skill (e.g. `agent`, `skill`, `ws`) is shadowed as a command, but its body still serves the skill verbs (create / update etc.) via the verb fallback.
- **Among skills, first-come wins** (workspace scope is merged over global before this check); the later one is dropped with a warning.
- Colliding entries are **dropped** from the command list and a warning is logged (`[CommandRegistry] skill "<id>" command "/x" shadowed by …`). Dropping at the shared source guarantees a command can never appear in the palette that dispatch is unable to route ("visible but unreachable").

Note: a skill's `command` collision only removes the *slash command*; the skill itself remains usable via the agent's normal skill activation.

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

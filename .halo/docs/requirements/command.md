# Command — Requirements

Unified command processing — all slash commands (built-in + skill) are dispatched through `dispatchCommand` (channels/shared/commands.ts) and discoverable via REST.

## Built-in commands

Source: [commands/index.ts](../../../packages/server/src/commands/index.ts) (descriptors) + [channels/shared/commands.ts](../../../packages/server/src/channels/shared/commands.ts) (execution)

Top-level built-in slash commands: `/help` `/evo` `/session` `/agent` `/skill` `/workspace` `/goal`. (`/cron` and `/acp` look like top-level commands too but are provided by same-name skills — see the verb table below; they aren't registered in `commands/index.ts` or `DISPATCH_COMMANDS`.)

| Name | Slash | Type | Purpose |
|---|---|---|---|
| `help` | `/help` | client | List commands — object commands show only the verbs the user can run; a command is hidden entirely if no verb is runnable |
| `evo` | `/evo [text]` | server | Flat command (no verbs), **full-only**. Trigger self-evolution on the current root session: snapshot the conversation + queue an evo run. Optional text becomes a hint for what to focus on. Available only when `general.evolution.level=L1`. See [plans/self-evolution.md](../plans/self-evolution.md). |

The rest are noun-verb **object commands**: `/<obj> <verb> [args]`. Some verbs are built-in deterministic code (`SUBCOMMAND_ROUTES`); the others fall through to the same-name skill (LLM, dispatched via `$1`). Bare `/<obj>` or `/<obj> help` lists the verbs available to the user (filtered by access level).

| Command | Verbs (access) |
|---|---|
| `/session` | new / list / info / switch \<n\> / stop / interrupt / compact / context — all built-in, all users (readonly can only switch / inspect its own sessions) |
| `/agent` | list / switch / desc (built-in, no gate) · delete (built-in, full) · create / update (skill verb, full) |
| `/skill` | list / desc (built-in, no gate) · disable / enable (built-in, workspace) · delete (built-in, full) · create / update (skill verb, full) |
| `/workspace` | info (built-in, no gate) · switch (built-in, full) · setup / tidy (skill verb, workspace) · share (skill verb, full) — `/w` is a built-in alias (see [Command aliases](#command-aliases)) |
| `/cron` | create / list / update / enable / disable / delete — all skill verbs, full |
| `/acp` | kiro / claude (ask a local agent directly; question = rest of line) · add / list / remove (manage generated ask-* bindings) — all full |
| `/goal` | create \[description\] / status / pause / resume / clear — all built-in, **all full** (no skill fall-through; the `goal` agent is internal, not a skill). See [design/goal-mode.md](../design/goal-mode.md) |

Session lifecycle actions (`session:clear`, `session:delete`) are handled inline by the WS handler, not as slash commands.

### `/goal` verbs

All five verbs are gated `requiresAccess: full` — **including `status`** (user ruling): goal mode drives an autonomous multi-round loop (the goal session dispatches work orders that write files, run shell checks, and burn rounds of model budget), so no verb is exposed to workspace-level callers.

- `create [description]` — start goal intake on the current session (which becomes the worker; must be a root session and not itself a goal session). Refuses while a goal is active — goals are serialized per workspace — printing the active goal's status instead. Returns `switchTo` to the new goal session so the surface lands in the intake conversation.
- `status` — print the latest goal (any state): status, round/cap, elapsed, no-progress counter, delegated decisions, both session ids, halt reason if any.
- `pause` — running → paused, then stop the worker (cascading to its subtree) **and** the goal session. Paused lifts the routing overlay: the user talks to the worker directly (manual takeover).
- `resume` — paused → running, nudges the goal session to re-read spec + transcript and re-dispatch; returns `switchTo` to the goal session.
- `clear` — tear down the binding from any active state; worker + goal session stopped, surface returns to the worker. The goal record stays on the goal session's row as history.

### `/session info`

Built-in verb (no access gate beyond ownership). Prints the **session tree** for the caller's current root session — the root plus every descendant sub-agent, so the user can see the whole delegation fan-out at a glance:

- One line per session, indented by depth (root is flush-left with a `→` bullet; each level of sub-agent adds two spaces and a `├` bullet).
- Each line carries the agent name, a **status glyph** — 🟢 running / ⏹ stopped / 📦 archived — and two timestamps: created (`建` / `new`) and last-active (`活` / `act`).
- A header line names the root id (last 12 chars) and its title.

Resolution starts from the caller's active session, walks up to its root (`id.split('>')[0]`), then lists descendants via `SessionManager.listDescendants`. **Access scoping**: non-`full` users only see a tree whose root id starts with their own `sessionPrefix` — otherwise the command refuses (a readonly/guest user can't inspect another user's tree). The same own-tree scoping applies to **agents**: the by-id session tools (`query_session` / `interrupt_session` / `stop_session` / `archive_session` / `get_session_output`) only act on sessions sharing the caller's root id — see [session.md → By-id tool scoping](../design/session.md#by-id-tool-scoping).

## Command aliases

`dispatchCommand` expands shorthand aliases before routing, so every channel (WS, WeChat, Telegram, Web, CLI/TUI) gets the same shortcuts uniformly. Aliases are read from a single seed file:

- **`~/.halo/global/aliases.yaml`** — seeded once on first run (`init.ts`, via `writeIfMissing`), **never overwritten**, so the user can freely edit it. Deleting the file disables all aliases. Changes take effect immediately: the loader caches the parsed YAML keyed by file **mtime**, re-reading only when the file changes (no restart, no per-command disk parse on the hot path).

Two expansion stages run in order (`expandAlias`):

1. **`top`** — whole-prefix replacement of the first slash token. The alias value can carry a verb, which is prepended to the args. E.g. `/ss <n>` → `/session switch <n>`; `/w` → `/workspace`.
2. **`verb`** — abbreviation of the first word of the args (the verb). E.g. `/session sw 2` → `/session switch 2`.

The seeded defaults:

| Stage | Alias → expansion |
|---|---|
| `top` | `/s`→`/session` · `/a`→`/agent` · `/h`→`/help` · `/w`→`/workspace` · `/ss`→`/session switch` · `/sl`→`/session list` · `/si`→`/session info` · `/sn`→`/session new` · `/ws`→`/workspace switch` · `/wi`→`/workspace info` · `/as`→`/agent switch` · `/al`→`/agent list` |
| `verb` | `sw`→`switch` · `ls`→`list` · `i`→`info` · `n`→`new` · `ctx`→`context` · `st`→`stop` · `int`→`interrupt` |

The canonical command is `/workspace`; `/w` is its bare alias. `/ws` and `/wi` are shortcuts for the two built-in verbs (`/workspace switch` / `/workspace info`), mirroring the `/ss` / `/si` session shortcuts.

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

- **Built-ins always win** — a skill command colliding with a built-in is not registered as a command. This is by design for object commands: their same-name skill (e.g. `agent`, `skill`, `workspace`) is shadowed as a command, but its body still serves the skill verbs (create / update etc.) via the verb fallback.
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

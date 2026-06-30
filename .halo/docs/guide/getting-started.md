# Getting Started

What to do the first time you open Halo.

## Log in

Open `http://localhost:9527` (or your deployment URL) in a browser and enter the password.

- Set the password during `halo setup` (interactive) — it's stored as a scrypt hash in `~/.halo/secrets/config.yaml`
- Or supply it via the `HALO_PASSWORD` env var (handy for CI / Docker), which takes precedence over the stored hash
- If neither is set, the server refuses to start (it prints `admin password not configured` and exits)

## Open a workspace

After login, you land in the workspace. A URL with `?folder=/abs/path` opens that directory directly; without `?folder`, Halo falls back to your home directory as the workspace — everything still works.

The Explorer top bar has two ways to switch workspace:
- **Type an absolute path** + Enter — invalid paths raise an error
- **Click the 📁🔍 button** — opens a VS Code-style directory picker: single click to select, double click to enter, ArrowUp to go up, 🏠 for home, paste paths into the top input

Halo auto-creates a `.halo/` subdirectory in the target folder (for sessions, agents, skills, memory). If `.halo/` already exists, opening the folder just works.

## First conversation (bootstrap)

The first time a new user chats with the Default agent, the agent asks a few questions:
- What should I call you?
- What would you like to call me?
- Preferred communication style (formal/casual, English/other language, etc.)

Your answers are written to `~/.halo/global/USER.md`; from then on every root agent reads that user profile.

> Don't want the bootstrap flow? Create `~/.halo/global/USER.md` manually (any content) and the agent will skip the guided flow.

### Workspace onboarding

The global `INSTRUCTIONS.md` template explains Halo's `.halo/` conventions (`INDEX.md`, `INSTRUCTIONS.md`, `memory/`). When the current workspace has no `INDEX.md`, the system prompt also nudges the agent to offer drafting one from the README / package.json. If you want a guided setup, type `/workspace setup`; to clean up an existing workspace later, type `/workspace tidy` — both backed by the `workspace` skill (setup: interview + draft; tidy: review + prune + reshape).

## Send a message

In the bottom Chat panel:
1. Type in the input
2. Enter to send (Shift+Enter for newline)
3. The agent streams its reply, showing text + tool call cards

You can keep typing while it replies — messages queue and run at the next safe checkpoint.

**Stop button** (red): interrupt immediately, no checkpoint waiting.

## Handy shortcuts

| Action | Shortcut / Method |
|---|---|
| File mention | Type `@` in the input, pick a file |
| Slash command | Type `/`, auto-complete pops up (`/session`, `/agent`, …) |
| Quick find file | `Cmd/Ctrl+P` |
| Save file | `Cmd/Ctrl+S` |
| New conversation | `/session new` |
| Compact context | `/session compact` |
| Set up / reorganize workspace | `/workspace setup` / `/workspace tidy` |

## What `~/.halo/` looks like

After `halo setup`:

```
~/.halo/
├── global/                   ← server-managed, see overwrite policy below
│   ├── INSTRUCTIONS.md       ← refreshed on upgrade
│   ├── prompts/{bootstrap,all,root}/   ← refreshed on upgrade
│   ├── models/<provider>.yaml          ← refreshed on upgrade
│   ├── docs/                 ← refreshed on upgrade (bundled platform docs)
│   ├── agents/               ← built-in ids refreshed; user-added ones untouched
│   └── skills/               ← built-in ids refreshed; user-added ones untouched
└── secrets/                  ← never overwritten after first creation
    ├── config.yaml           ← leaf-merged: new server knobs added, existing values kept
    ├── settings.yaml         ← created empty if missing; otherwise untouched
    └── channels/channels.db  ← per-channel account state
```

**When does "refreshed on upgrade" actually run?** `halo setup` always re-runs the seed; the server's startup check also re-runs it automatically when `~/.halo/global/.template-version` is behind the bundled `TEMPLATE_VERSION`. So the routine flow `halo upgrade && halo server restart` is enough — no need to remember `halo setup`.

**Server-refreshed**: `INSTRUCTIONS.md`, `prompts/`, `models/`, `docs/`, the built-in agent ids (`default`, `executor`, `deep-executor`, `__evo_agent__`, `__score__`, `__apply_agent__`), and the built-in skill ids (`agent`, `skill`, `workspace`, `cron`, `acp`, `send-file`, `self`, `aws-knowledge`, `nova-web-search`, `halo`). To customize one, copy it into the workspace scope (`<project>/.halo/...`) — workspace replaces global at runtime.

**Never overwritten**: anything else under `agents/` or `skills/` (your own creations), and everything under `secrets/`.

**`secrets/config.yaml`** is leaf-merged on each refresh — new keys introduced by a server upgrade are added, your existing `value`s (password, port, jwt_secret) are kept.

## Next

- [chat.md](chat.md) — everything the chat panel does
- [agents.md](agents.md) — managing agents
- [skills.md](skills.md) — what skills are and how to use them
- [sessions.md](sessions.md) — viewing session history, debugging
- [workspace.md](workspace.md) — the overall interface

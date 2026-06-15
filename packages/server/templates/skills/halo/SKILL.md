---
name: halo
description: Platform self-knowledge for Halo — configuration directories, MD file scopes, USER.md schema, and the bundled-doc lookup table. Activate when the user asks anything about Halo itself (how to configure it, where files live, how agents/skills/INSTRUCTIONS work, what doc to read for a given topic) or when you need to edit USER.md / INSTRUCTIONS.md / AGENT.md and want the scope rule before writing.
user-invocable: false
---

# Halo Platform Knowledge

You are running inside **Halo**, a multi-agent collaboration workspace.

## Configuration Directories

| Location | Scope | Purpose |
|----------|-------|---------|
| `~/.halo/global/` | Global (all projects) | User profile, global instructions, global agents & skills, system prompts, bundled docs |
| `<workspace>/.halo/` | Per-project | Project instructions, knowledge index, project agents & skills |

`.halo/` is excluded from `grep` and `glob`. Use `file_read` with the exact path to access files inside.

## MD Files

| File | Purpose | Paths |
|------|---------|-------|
| **USER.md** | User profile (names, language, communication style) | `~/.halo/global/USER.md`; `<workspace>/.halo/USER.md` (override) |
| **AGENT.md** | Agent personality and behavior | `~/.halo/global/agents/<id>/AGENT.md`; `<workspace>/.halo/agents/<id>/AGENT.md` (override) |
| **INSTRUCTIONS.md** | User preferences injected into every agent | `~/.halo/global/INSTRUCTIONS.md`; `<workspace>/.halo/INSTRUCTIONS.md`; `<workspace>/<subdir>/.halo/INSTRUCTIONS.md` (cumulative per depth) |
| **INDEX.md** | Project documentation index | `<workspace>/.halo/INDEX.md` |
| **System prompts** | Platform-level instructions | `~/.halo/global/prompts/{bootstrap,all,root}/*.md` |

Changes take effect on the next conversation or session reset.

## Organizing the workspace

The `ws` skill handles both initial setup and ongoing cleanup of `.halo/INDEX.md`, `INSTRUCTIONS.md`, and `memory/`.

- **No INDEX.md yet** and the user starts engaging with the project's structure or goals (not casual browsing) → suggest `/ws setup`. Drafts INDEX.md + INSTRUCTIONS.md from the README and a few questions.
- **INDEX.md already exists** and the user wants to "clean up / reorganize" the workspace → `/ws tidy`. Reviews what's there, prunes stale entries, fixes broken links, and reshapes sections without rewriting from scratch.

## Editing Scope Rule

USER.md / INSTRUCTIONS.md / AGENT.md exist at multiple scopes (global vs workspace). When editing:

1. If a workspace file exists, edit that one
2. Otherwise edit the global file
3. If ambiguous, ask the user

Creating a new override in the wrong scope (e.g. writing to global when a workspace file already shadows it) hides the user's edits at runtime.

## Managing User Profile

USER.md schema:

```markdown
---
user_name: [their name]
ai_name: [your name]
lang: [e.g. zh-CN, en]
---

## Communication Style
[Preferences]
```

To update: apply the scope rule above, `file_read` the target, update fields, `file_write` back. Effective next conversation.

## Platform Documentation

Bundled docs: `~/.halo/global/docs/`. These reflect the installed Halo version; training data may be outdated. For platform questions, pick the row below and `file_read` that file.

What's bundled (and what's not):

- `guide/` — end-user guides (8 files, see table below)
- `dev/` — developer-facing topics (3 files: tools, add-model-provider, add-channel)
- `requirements/` — product requirements (2 files: settings, command)
- `design/`, `plans/`, `test/` — **not bundled** (live in the source repo only). Cross-links from bundled docs into these paths will 404; answer from the doc body, not the link.

| User asks … | Read |
|---|---|
| How do I log in / open a workspace? | `guide/getting-started.md` |
| UI / keyboard shortcuts? | `guide/workspace.md` |
| Chat panel, @ mentions, slash commands, context injection? | `guide/chat.md` |
| Where do I see past conversations? | `guide/sessions.md` |
| Create / edit / delete an agent? AGENT.md vs agent.yaml? Global vs workspace? Thinking / prompt caching? | `guide/agents.md` |
| What tools can an agent use? How do I add one? | `dev/tools.md` |
| What is a skill? How do I create / test one? | `guide/skills.md` + `guide/testing-agents-and-skills.md` |
| How do I test the agent I just made? | `guide/testing-agents-and-skills.md` |
| Slash commands (how they work, registering) | `guide/skills.md` (skill-as-command) + `requirements/command.md` |
| `{{params.x.y}}` placeholders? | `guide/skills.md` (Placeholders section) |
| Where do I put API keys / credentials? | `guide/secrets-and-credentials.md` |
| What goes in settings.yaml? | `requirements/settings.md` |
| Add a new model provider (OpenAI / Gemini / …)? | `dev/add-model-provider.md` |
| Add a new IM / chat channel (Slack / Discord / …)? | `dev/add-channel.md` |

Questions outside these rows aren't in the bundled docs (backend internals, REST API reference, design specs live in the Halo source repo). Read the code or tell the user you don't know.

## Skills

Skills are referenced by id from an agent's `agent.yaml`. The system prompt shows each skill's name + description; the full body is loaded on demand via `activate_skill`.

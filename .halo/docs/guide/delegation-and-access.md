# Delegation and Access

How Halo decides, at runtime, **which agent / skill files are used**, **when a config edit takes effect**, **who an agent may delegate to**, and **what access level a session runs at**. Written for people (and agents such as a workspace builder) who configure agents and need the actual behavior without reading source.

Field-by-field `agent.yaml` reference: [agents.md](agents.md). Per-tool schemas and sandbox internals: [dev/tools.md](../dev/tools.md).

## 1. Which files are used — scope resolution

| Item | Workspace location | Global location | Rule |
|---|---|---|---|
| Agent | `<ws>/.halo/agents/<id>/` | `~/.halo/global/agents/<id>/` | **Whole-folder override.** If the workspace folder exists, `agent.yaml` and `AGENT.md` are read **only** from it — no per-file fallback to global. |
| Skill | `<ws>/.halo/skills/<id>/` | `~/.halo/global/skills/<id>/` | Whole-folder override, including resource files next to `SKILL.md`. |
| System prompts | `<ws>/.halo/prompts/<scope>/` | `~/.halo/global/prompts/<scope>/` | Per scope (`bootstrap` / `all` / `root`): a workspace scope dir replaces the global one. |
| INSTRUCTIONS.md | `<ws>/.halo/INSTRUCTIONS.md` | `~/.halo/global/INSTRUCTIONS.md` | Workspace file **replaces** global (not stacked). |
| USER.md | `<ws>/.halo/USER.md` | `~/.halo/global/USER.md` | Workspace file replaces global. |
| Disabled flag | `disabled_items` in the workspace `halo.db` | — | Checked against the scope that actually serves the id (workspace if its folder exists, else global). |

Gotchas:
- An empty or half-copied `<ws>/.halo/agents/<id>/` folder **shadows** the global agent completely. With no `agent.yaml` inside, the agent can't be used: `start_session` returns "not found" and opening a session fails with "agent.yaml missing or unreadable" — yet rosters and pickers may still show the global copy. When customizing, copy both files; an `agent.yaml` without `model.provider` / `model.id` / `model.endpoint` fails with "missing model config".
- Same id in both scopes: everything (roster, chat selector, delegation) sees only the workspace version.
- Built-in agents (`default`, `executor`, `deep-executor`, `goal`, and the internal `__evo_agent__` / `__score__` / `__apply_agent__`) and built-in skills are platform-owned: a template reseed after an upgrade overwrites them (an agent's `model:` / `context:` blocks are kept). Customize through a workspace copy, not by editing the global files.

## 2. When a config edit takes effect

No restart is needed for agent / skill / prompt edits. An agent instance (model runtime, tool set, system prompt) is built from disk when a session is loaded into memory, and a session is **released from memory at the end of every run**. The next message rebuilds it from the current files.

| You edit | Takes effect |
|---|---|
| `agent.yaml` (model, tools, skills, team, context, thinking), `AGENT.md` | Next turn of any existing session; immediately for new sessions (including sub-agents started after the edit) |
| `INSTRUCTIONS.md`, `USER.md`, `INDEX.md`, `prompts/` | Same — next turn / new sessions |
| Skill frontmatter (`name`, `description`, `requiresAccess`), adding/removing a skill id in `skills:` | Next turn / new sessions |
| `SKILL.md` **body** | Immediately — `activate_skill` reads the file at call time |
| `team` list — the `start_session` / `query_agent` check | Immediately (the caller's `agent.yaml` is re-read on every call) |
| `team` list — the roster in the prompt, and gaining/losing the session tools (empty ↔ non-empty) | Next turn |
| Disable / enable an agent | `start_session` / `query_agent` reject a disabled agent immediately; rosters update next turn |
| `general.sandbox.hidden_dirs` / `hidden_files` / `writable_dirs` | Immediately when saved from the admin Settings page; a hand edit of `settings.yaml` applies after a restart (or the next Settings save) |
| `general.session.max_nesting_depth` | **Server restart only** — read once at startup |

What "next turn" means precisely:
- The turn that is running now finishes on the old config. Messages queued behind it and drained in the same run also use the old config.
- A session that was only loaded for viewing (context panel, `/context`, compact) runs its next turn on the config it was loaded with, then picks up the new config after that.
- An access-level change on a session rebuilds it immediately, with messages kept (see §5).

## 3. Delegation — team, roster, start_session

**`team` is the on/off switch.** An agent gets the 8 session tools (`start_session`, `session_list`, `query_session`, `interrupt_session`, `stop_session`, `archive_session`, `get_session_output`, `query_agent`) only when its `agent.yaml` has a **non-empty `team`**. Absent or empty `team` means no session tools and no roster; the agent still has `continue_task`. Listing session tools under `tools:` does nothing. Internal agents never delegate, whatever their `team` says.

**Roster** (`## Your Team` block, placed right after AGENT.md in the system prompt):
- Candidates: every agent in both scopes, collapsed to the effective record per id (workspace shadows global).
- Removed: disabled agents, `internal: true` agents, and anything not in `team`.
- The agent itself is listed first, tagged `(you)`, only if its own id is in `team` (that is what allows parallel self-spawn). The rest are sorted by `priority`, highest first, as `` `id` — name: description ``.
- A workspace agent may list global agents in its `team` and vice versa — ids are resolved to whatever scope serves them.

**`start_session` checks, in order** (the first failure is returned as `{"code": 1, "error": …}`):

| # | Check | Error |
|---|---|---|
| 1 | `agent_id` and `message` present | `agent_id and message are required` |
| 2 | Target exists, is not `internal`, is not disabled | `agent "<id>" not found. The agents you can delegate to are listed in your system prompt.` |
| 3 | Target is in the caller's `team` | `agent "<id>" is not in your team. …` |
| 4 | Caller's depth < `max_nesting_depth` | `Maximum nesting depth (16) reached. Complete this task directly instead of delegating to a sub-agent.` |
| 5 | `working_dir` (optional) is inside the workspace and is an existing directory | `working_dir "<x>" is outside the workspace` / `is not a directory` / `does not exist` |

On success the child is created at the **parent's access level** (§5) and runs asynchronously. When it goes idle its wrap-up is reported back to the parent automatically.

**Nesting depth.** Session ids are `root>child>grandchild…`; depth is the number of segments (a root session is depth 1). A caller at depth ≥ `max_nesting_depth` cannot spawn. With the default 16, a tree has at most 16 levels. Set it in `~/.halo/secrets/settings.yaml` under `general.session.max_nesting_depth` (global only, a workspace `settings.yaml` can't override it) and restart the server.

**The other session tools:**
- `query_agent <id>`: same checks as rows 2–3 above, but every failure reads `agent "<id>" not found.`. Returns name, description, model, `tools`, and skills — **not** AGENT.md. When the caller is readonly, `file_write` / `file_edit` / `shell_exec` / `web_fetch` are dropped from the listed tools, and skills whose `requiresAccess` is above the caller's level are hidden.
- `query_session` / `interrupt_session` / `stop_session` / `archive_session` / `get_session_output`: only work on sessions in the caller's own tree (same root id). Anything else returns `session <id> not found`.
- `session_list`: direct children of the calling session only (up to 500).

**Delegating further.** A sub-agent delegates only if its own `agent.yaml` has a non-empty `team`. It gets its own roster. Depth is the only other limit.

## 4. What a sub-agent's system prompt contains

| Layer | Root session | Sub-agent | Internal agent |
|---|---|---|---|
| USER.md | ✓ | — | — |
| AGENT.md (+ roster if `team`) | ✓ | ✓ | AGENT.md only |
| INSTRUCTIONS.md (workspace, else global) | ✓ | ✓ | — |
| INSTRUCTIONS.md along the `working_dir` path (stacked, general → specific) | if `working_dir` set | if `working_dir` set | if `working_dir` set |
| INDEX.md | ✓ | ✓ | — |
| `prompts/root` | ✓ | — | — |
| `prompts/all` | ✓ | ✓ | — |
| Skill metadata (`skills:` minus disabled minus `requiresAccess` above the session level) | ✓ | ✓ | ✓ |
| Trailing "Your available tools: …" line | ✓ | ✓ | ✓ |

So a sub-agent knows nothing about the user except what the parent puts in the `start_session` message / `system_prompt_context`.

## 5. Access levels

Three session levels, stored per session (`agent_sessions.access_level`; `full` is stored as null):

| Level | Tools the agent can get (from its `tools:` list) | Sandbox |
|---|---|---|
| `full` | all 9 workspace tools | none (the `rm` guard still applies) |
| `workspace` | all 9 | writes only inside the workspace; credentials and workspace runtime state are hidden |
| `readonly` | all 9 with an OS sandbox (writes fail); only `file_read`, `view_image`, `file_list`, `grep`, `glob` without one | nothing writable |

Extra rules:
- Without an OS sandbox (Linux without working bubblewrap, and Windows), `shell_exec` fails for every non-full session. Windows has no path boundary at all — see [dev/tools.md](../dev/tools.md#access-level-per-session-dynamic).
- A readonly `shell_exec` gets no secret substitution — `{{…params…}}` / `<<ENV>>` placeholders stay literal.
- `view_image` also needs a vision-capable model.
- A skill with `requiresAccess` above the session level is hidden (no metadata, no `activate_skill`).
- Relay tools are only built for `full` sessions.
- Hidden from `workspace` / `readonly` sessions: the `general.sandbox.hidden_dirs` / `hidden_files` lists (default: `~/.halo/secrets`, `~/.aws`, `~/.ssh`, `~/.gnupg`, `~/.docker`, `~/.config/gh`, `~/.gitconfig`, `~/.git-credentials`, `~/.npmrc`, `~/.netrc`, the global evo/cron/runs databases, internal-session transcripts, logs, …) plus the workspace's own `.halo/sessions`, `.halo/logs`, `.halo/evo`, `.halo/halo.db*` (fixed in code). The rest of `.halo/` stays readable.

### Where a session's level comes from

| Entry point | Level of a new session | Existing session |
|---|---|---|
| Admin chat | Chat-input selector (defaults to Full; locked to Full on a host without an OS sandbox) | Re-applied on each message sent while the session is idle. A message queued behind a running turn keeps the running turn's level. |
| Channel account (Web / Telegram / Slack / Feishu / WeCom / WeChat, and the ACP adapter via its Web token) | The account's `accessLevel`: `full` → full, `workspace` → workspace, `readonly` and `observer` → readonly. New accounts default to **readonly**. | Re-applied on every inbound message. Changing an account's level takes effect on the next message. |
| Channel `/session new` | The account's level | — |
| `start_session` (sub-agent) | **Parent's level at creation time** | Kept. A later change on the parent doesn't reach existing children; start a new child to get the new level. |
| Cron job | Full (the `halo cli` default) | Keeps its stored level (passed through as `--access`) |
| `halo cli` / TUI | `--access`, default `full` | `--access` value (a different level is persisted) |
| `relay_send` into another workspace | Full | Keeps its stored level |
| `/goal create` | The goal session is full (`/goal` verbs need full access) | — |
| AgentCore runtime | Full | — |

Consequences:
- A sub-agent can never have more access than its parent had when it was spawned. A readonly channel user can't escalate by delegating.
- To give a sub-agent more access, raise the root session's level first (admin selector / channel account), then spawn a **new** child.

## 6. Relay (cross-workspace)

Relay is separate from `team` delegation:
- Enabled by listing `relay_send` in `tools:` (that one name brings `relay_send` / `relay_interrupt` / `relay_stop` / `relay_read` / `relay_list`), and **only in full sessions** — a workspace/readonly session with `relay_send` listed gets nothing.
- **Not team-checked.** Any agent in the target workspace can be named with `agent_id`. Without it, the target workspace's default entry agent is used: highest `priority`, not disabled, not internal, workspace scope wins ties.
- The target session is created at full if missing, otherwise keeps its level. Its wrap-up comes back as a `[Relay report …]` message, once per dispatch.
- Server only (not in `halo cli` / TUI). Details: [dev/tools.md → Relay tools](../dev/tools.md#relay-tools).

## 7. Quick answers

| Question | Answer |
|---|---|
| I edited `agent.yaml` / AGENT.md — restart? | No. Next turn of existing sessions, immediately for new ones (§2). |
| The agent has no `start_session` | `team` is empty or missing — add at least one id. It shows up from the next turn. |
| `start_session` says "not found" but the agent exists | It's disabled, `internal`, or shadowed by a workspace folder with no `agent.yaml` (§1). |
| "is not in your team" | Add the id to the **caller's** `team`. Takes effect on the next call. |
| Sub-agent has fewer tools than its `tools:` list | It inherited a restricted level from its parent (§5), or the model has no vision (`view_image`). |
| Sub-agent can't see the user's preferences | Sub-agents don't get USER.md (§4). Put what they need in the brief. |
| Delegation stops at some depth | `max_nesting_depth` (default 16, global setting, restart to change). |
| Make an agent the default for new channel sessions | Give it the highest `priority` in that workspace. |
| Hand work to another workspace | Relay: `relay_send` in `tools:`, full session (§6). |

## Where this lives in code

For maintainers keeping this page in sync — paths under `packages/server/src/`:

| Topic | File |
|---|---|
| Scope resolution, `canDelegate`, `isTeamMember`, `isAgentDisabled` | `agents/agent-loader.ts` |
| Tool set, roster, prompt composition | `agents/session-agent-builder.ts`, `prompts/md-loader.ts`, `prompts/system-prompts.ts` |
| Session tool checks | `agents/session-tools.ts` |
| Release after each run, access-level rebuild | `agents/session-manager.ts` (`runSession` finally → `releaseSession`; `sendUserMessage`) |
| Channel level mapping | `channels/shared/inbound.ts` (`sessionAccess`), `channels/web/handler.ts` |
| Tool filtering and sandbox | `tools/workspace-tools.ts`, `tools/sandbox.ts` |
| Relay | `agents/relay.ts` |

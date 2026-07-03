# Prompt System — MD loading flow

On agent startup, Halo assembles the system prompt by concatenating various MD files in a fixed order.

Entry point: `session-manager.ts` `buildAgentInstance(agentId, sessionId, parentId?, workingDir?, accessLevel?)`

**Root agent rule**: `!parentId` (parentId null/undefined = root). Does not depend on any `is_default` field.

## Final directory layout

### Global (machine-wide)

```
~/.halo/global/
├── USER.md                 ← user profile (generated on bootstrap)
├── INSTRUCTIONS.md         ← global user preferences
├── prompts/                ← user-editable system prompts (externalised)
│   ├── bootstrap/BOOTSTRAP.md             ← first-run guidance
│   ├── all/                               ← every-agent rules (TOOL_GUIDELINES.md, TOOL_SHELL[.windows].md, WORKSPACE_CONVENTIONS.md)
│   └── root/                              ← root-agent-only (empty by default; user-set)
├── agents/<id>/{agent.yaml, AGENT.md}
└── skills/<id>/SKILL.md       ← built-in `halo` skill carries platform self-knowledge (loaded on demand via activate_skill)
```

### Workspace

```
<workspaceRoot>/.halo/
├── USER.md                         ← optional, overrides global USER.md
├── INSTRUCTIONS.md                 ← project-level (overrides global INSTRUCTIONS.md)
├── INDEX.md                        ← project overview + doc index
├── <subdir>/.halo/INSTRUCTIONS.md   ← directory-scoped: baked into the system prompt when a sub-agent's working_dir points here; injected per-turn via user @scope otherwise
├── prompts/                        ← optional, directory-level override of global prompts/
│   ├── bootstrap/                  ← overrides global prompts/bootstrap/ if dir exists
│   ├── all/                        ← overrides global prompts/all/ if dir exists
│   └── root/                       ← overrides global prompts/root/ if dir exists
├── agents/<id>/{agent.yaml, AGENT.md}
└── skills/<id>/SKILL.md
```

`.halo/` is listed in grep/glob `SKIP_DIRS`, so agents read via `file_read`.

## Step 1 — Load agent YAML

[agent-loader.ts](../../../packages/server/src/agents/agent-loader.ts) `loadAgentYaml(agentId, workspaceRoot)`

Resolution is by the agent's **folder** (`agentSourceDir`), not per file:
1. if `<workspaceRoot>/.halo/agents/<id>/` exists → read `agent.yaml` from there
2. otherwise → read from `~/.halo/global/agents/<id>/`

**Whole-folder override**: when the workspace folder exists it serves the
agent entirely (both `agent.yaml` and `AGENT.md`), with no per-file fallback
to global — a missing file inside it is just absent. YAML fields: `name` /
`description` / `model` / `tools` / `skills` / `system_prompt` / `context` /
`priority`.

## Step 2 — Resolve MD file paths

[md-loader.ts](../../../packages/server/src/prompts/md-loader.ts) `resolveMdPaths(agentId, workspaceRoot?)`

### USER.md (workspace > global)
- `<ws>/.halo/USER.md`
- `~/.halo/global/USER.md`

### AGENT.md (whole-folder override, follows the agent folder)
Read from the same folder Step 1 resolved (`agentSourceDir`):
- if `<ws>/.halo/agents/<id>/` exists → `<ws>/.halo/agents/<id>/AGENT.md`
- otherwise → `~/.halo/global/agents/<id>/AGENT.md`

No independent per-file fallback: when the workspace agent folder exists but
has no `AGENT.md`, AGENT.md is empty (it does **not** fall back to the global
agent's AGENT.md), because the workspace folder replaces the global one whole.

### INSTRUCTIONS.md — system prompt holds global + workspace-root only
- `~/.halo/global/INSTRUCTIONS.md` — global (suppressed when the workspace-root INSTRUCTIONS.md exists)
- `<ws>/.halo/INSTRUCTIONS.md` — project root

**Override rule.** The workspace-root INSTRUCTIONS.md suppresses the global one (same override as USER.md / AGENT.md), so a cloned workspace is self-contained — its conventions travel with the repo and don't depend on the machine's global file. When the workspace root has no INSTRUCTIONS.md, the global one is used.

**Sub-directory INSTRUCTIONS.md — two paths, by who supplies the directory** (see [Directory-scoped instructions](#directory-scoped-instructions-scope) below):
- **A sub-agent's `working_dir`** is persistent session identity (stored in the DB, restored on resume), so its directory-chain INSTRUCTIONS.md are baked into the **system prompt every turn** — the agent never forgets the rules of the directory it lives in.
- **A user's `@scope <dir>`** is ad-hoc, so it's injected **per-turn** into that one message only (loop-scoped — relevant to the turn that asked for it, not a permanent part of identity).

### INDEX.md (**project root only**)
- `<ws>/.halo/INDEX.md`

Subdirectory `.halo/INDEX.md` files are **not auto-loaded** — use `file_read` on demand.

## Step 3 — Concurrent disk reads

`loadAllMdContents()` concurrently reads every candidate. Returns:

```ts
interface MdContents {
  userMd: string
  agentMd: string
  globalInstructions: string
  workspaceInstructions: string      // <ws>/.halo/INSTRUCTIONS.md (root only)
  projectIndex: string
  needsBootstrap: boolean            // no USER.md anywhere
}
```

## Step 4 — Load system prompts

[system-prompts.ts](../../../packages/server/src/prompts/system-prompts.ts) keeps the hard-coded defaults for seeding and fallback.

### Seed (init.ts startup hook)
Startup seeds `templates/prompts/{bootstrap,all,root}/` into `~/.halo/global/prompts/` (currently `BOOTSTRAP.md`; `TOOL_GUIDELINES.md`, `TOOL_SHELL[.windows].md`, `WORKSPACE_CONVENTIONS.md`; `WORKSPACE_MEMORY.md`). These are **platform-owned, force-overwritten** on template refresh (`TEMPLATE_VERSION` gate) — user customization belongs in the workspace `prompts/` override, not in the global copies.

### Live load (every `buildAgentInstance`)
`loadSystemPrompts(workspaceRoot?)` resolves each scope directory with workspace > global precedence:
- For each user-editable scope (`bootstrap`, `all`, `root`): if `<ws>/.halo/prompts/<scope>/` **directory exists**, use it; otherwise fall back to `~/.halo/global/prompts/<scope>/`.
- Override is at the **directory level** — the workspace directory entirely replaces the global one (no per-file merge).
- Within the resolved directory, the `.md` files are filtered by `selectForPlatform` (see below), then concatenated by filename ascending.

> Historical: a `builtin/` scope used to be force-prepended to `root`, carrying `PLATFORM_KNOWLEDGE.md`. That content has moved to the built-in `halo` skill (see `templates/skills/halo/SKILL.md`), loaded on demand via `activate_skill('halo')`. Root agents no longer pay context for platform self-knowledge they don't need this turn.

#### Platform variant files (`*.windows.md`)

`selectForPlatform` lets a scope ship a Windows-specific version of any prompt file without duplicating the platform-neutral parts:

- `<stem>.windows.md` is the Windows variant of `<stem>.md`.
- **On Windows**: the variant is loaded and its same-stem base (`<stem>.md`) is suppressed — the variant *replaces* the base.
- **On mac / linux**: every `*.windows.md` is ignored; only the plain `.md` files load.
- Files with no `*.windows.md` sibling load on every platform.

Replacement is **whole-file**, not per-section — so split the platform-divergent content into its own file and keep the common content in an un-suffixed file. Example in `prompts/all/`: `TOOL_GUIDELINES.md` (common) + `TOOL_SHELL.md` (unix Shell section) / `TOOL_SHELL.windows.md` (cmd.exe, `dir`/`findstr`, `%USERPROFILE%`, `python` vs `python3`, `.py` skill caveats). To add a new platform difference anywhere, extract that block to `FOO.md` and add `FOO.windows.md`.

Result:
- `prompts/bootstrap/*.md` → `bootstrapPrompt`
- `prompts/all/*.md` → `allPrompt`
- `prompts/root/*.md` → `rootPrompt`

Missing directory or read failure: warn + use built-in fallback.

`loadSystemPrompts` also returns `files: { bootstrap: string[]; all: string[]; root: string[] }` — the absolute paths of the `.md` files actually read for each scope (empty when the built-in fallback was used). `session-manager.ts` forwards this list into `AgentMeta.mdFiles`, which `/session context` renders one line per file (label `prompt/<scope>/<basename>`). When a scope falls back to the built-in constants, a single line `prompt/<scope> (built-in fallback): <dir>` is shown instead.

## Step 5 — Compose the MD prompt

`composeMdPrompt(contents, roster = '', scopeBody = '')` joins non-empty sections with `\n\n---\n\n`:

1. `## User Profile` (USER.md) — root agent only
2. AGENT.md body
3. The live agent roster (`## Know Your Team Before You Act` for root, `## Your Team` for sub-agents), slotted directly behind AGENT.md (see [Agent roster](#agent-roster) below). Empty string for non-delegating agents (no `team` / empty `team`) / internal agents, so the section is dropped.
4. `## User Instructions` — `~/.halo/global/INSTRUCTIONS.md` (suppressed when the workspace root has its own — see Step 2)
5. `## User Instructions` — `<ws>/.halo/INSTRUCTIONS.md` (workspace root).
6. `## User Instructions` — a sub-agent's `working_dir` directory-chain INSTRUCTIONS.md (`loadScopeBody`, plain markdown, headed `### <dir>`), folded into the same region right after #4/#5 so the order reads general → specific. Empty for a root agent / a working_dir with no sub-dir file. (User `@scope` does NOT come through here — it injects per-turn into the message, wrapped in `<workspace-instructions>`.)
7. `## Project Knowledge` — `<ws>/.halo/INDEX.md` (skipped entirely when no INDEX.md exists)

Global and workspace-root INSTRUCTIONS share the same `## User Instructions` heading: they're mutually exclusive (workspace overrides global, see Step 2), so only one ever lands in a prompt and there's no sibling to disambiguate from. A sub-agent's `working_dir` directory-chain (#6) reuses the same heading and is a third, *additive* layer in that region — sub-dir rules add to, never replace, the global/ws-root base, so the order reads general → specific. The roster rides as section 3 — passing it through `composeMdPrompt` rather than concatenating it afterward gives it the same `---` separators as every other section (no glue-to-next-block).

## Step 6 — Layer in the system prompts

### Root agent (`!parentId`)

```
mdPrompt                                         ← incl. roster + working_dir scope (both inside composeMdPrompt)
+ "\n\nThe project workspace is at: {workspaceRoot}\n"
+ [optional] "Working directory: {workingDir}\n"
+ allPrompt
+ rootPrompt
```

(The `working_dir` directory-chain INSTRUCTIONS.md live *inside* `mdPrompt` — folded into the `## User Instructions` region by `composeMdPrompt` — not after the `Working directory:` tagline. That tagline is just a one-line focus marker.)

The roster is computed once (`canDelegate(yaml)` → `buildAgentRoster(agentId, team)`, else `''`, where `canDelegate` is "not internal AND a non-empty `team`") and handed to `composeMdPrompt`, so it lands inside `mdPrompt` behind AGENT.md. Only when there's no AGENT.md at all (the fallback branch) is a non-empty roster appended at the tail instead — there's no MD layer to slot it behind.

When `needsBootstrap`, the whole block is prefixed with `bootstrapPrompt + "\n\n---\n\n"`.

### Sub-agent (has parentId)

`userMd` is cleared and the prompt recomposed:

```
mdPrompt                                         ← incl. working_dir scope (inside composeMdPrompt, see Root)
+ "\n\nThe workspace root is: {workspaceRoot}\n"
+ "Working directory: {workingDir}\n"
+ allPrompt
```

Not injected: USER.md / `prompts/root/` / `prompts/bootstrap/`.

### Internal agents (`internal: true`)

The self-evolution agents (`__evo_agent__`, `__score__`, `__apply_agent__`) are platform tooling, not workspace-resident assistants. They get **none** of the workspace context: USER.md, INSTRUCTIONS.md (global + workspace-root), INDEX.md, and all three prompt scopes (`prompts/all` / `root` / `bootstrap`) are cleared in `composeSystemPrompt`. Only their own AGENT.md (which carries the full procedure) plus the tool list remains — this keeps their token budget clean.

> Caveat: `prompts/all` is where `TOOL_SHELL.md` (platform shell guidance) lives, so a `shell_exec`-capable internal agent (`__apply_agent__`) doesn't inherit it. `__apply_agent__`'s AGENT.md carries its own "Shell usage & platform" section to cover this — keep that in mind if adding shell to another internal agent.

### Fallback

If `mdPrompt` is empty:
- Use `yamlConfig.system_prompt` if present
- Otherwise use the hard-coded default string

## Agent roster

`buildAgentRoster(selfAgentId, team, isRoot)` ([session-agent-builder.ts](../../../packages/server/src/agents/session-agent-builder.ts)) builds a live team block listing the agents this session can delegate to — one `- \`<id>\` — <name>: <description>` line per teammate. The framing depends on `isRoot` (see "Root vs. sub-agent framing" below): a root gets the full `## Know Your Team Before You Act` orchestrator block, a sub-agent a lean `## Your Team` block.

**Who's on the list.** `scanAvailableAgents` minus `disabled` (workspace `disabled_items` table) minus `internal: true`, collapsed to the effective record per id (workspace shadows global — so a stale global shadow whose workspace record is disabled never gets listed-but-uncallable), then narrowed to the agent's `team` whitelist via `isTeamMember(team, id)` — the same filter `start_session` / `query_agent` enforce server-side, so the roster never lists someone the agent can't actually reach. Self is treated like any other agent: it appears only when the agent's own id is in `team`. When listed it's pinned to the top and tagged `(you)` — purely a reading order ("who am I" before "who else") — and the root framing adds a **cost warning**: spawn parallel instances of yourself only for sub-tasks that need delegation or your full generality (each instance runs your own expensive model; prefer the cheaper executor for well-scoped work), and do serial work directly rather than self-delegate. The remaining teammates are sorted by `priority` **descending** — the preferred workhorse leads and ordering is deterministic (scan order is readdir order, which isn't guaranteed). (Add the agent's own id to its `team` to enable parallel self-spawn — the seed `default` agent does exactly this.)

**Gated on a non-empty team.** A roster is computed only when `canDelegate(yaml)` ([agent-loader.ts](../../../packages/server/src/agents/agent-loader.ts)) holds: `!internal` (evo / score / apply are platform tooling, not orchestrators) **and** a non-empty `team`. The very same predicate gates the session-tool bundle in `resolveBaseToolSet` — so the roster and the tools that act on it are granted together or not at all, never half. No team, no delegation: no session tools, no roster.

**Root and sub-agents both get a roster** — there's no `isRoot` gate on *whether* a roster appears (any agent with a non-empty `team` gets one). Runaway re-subcontracting used to be stopped by a blanket "root only" ban; it's now bounded by the per-agent `team` whitelist (which is also the delegation switch) plus `maxNestingDepth` (default 16). This lets a sub-agent legitimately delegate further (grandchild sessions) when its `agent.yaml` declares a team, while the depth cap and whitelist keep cascades finite.

**Root vs. sub-agent framing.** `isRoot` controls the *framing* around the roster, not its membership:
- **Root** gets `## Know Your Team Before You Act` — the roster plus the full orchestrator pep-talk (prefer delegation, fan out in parallel, don't poll, "I'll just do it myself" is rarely right). A root's job is to orchestrate, so the steering is on-message.
- **Sub-agent** gets `## Your Team` — the same roster plus a single line on when to hand off. A sub-agent's job is to *finish what it was handed*, not to keep re-subcontracting, so the orchestrator pep-talk would be noise (or actively push it to over-delegate). Self's line is also trimmed to just `(you)` (no "spawn parallel instances of yourself" nudge).

**Team whitelist = the delegation switch.** `agent.yaml` carries an optional `team: [id, …]`. A **non-empty** list is what *enables* delegation — it grants the whole session-tool bundle plus the roster (see `canDelegate`) AND restricts reach to exactly those ids. **Unset or empty `[]` means the agent cannot delegate at all** (no session tools, no roster) — this is a breaking change from the earlier "unset = every agent reachable" default; agents authored before this change that relied on the implicit-all behavior must now list their team explicitly. The `isTeamMember(team, targetId)` predicate still gates the three reach surfaces consistently — the roster (what the agent sees), `start_session`, and `query_agent` (server-side enforcement, so a hand-crafted call to a non-team agent is rejected). Self gets no special-casing: include the agent's own id to allow parallel self-spawn (the seed `default` agent lists `default`), omit it to block self-spawn — exactly like any other agent.

> Note: `isTeamMember(undefined, id)` still returns `true` in isolation (its job is "is this id reachable *given* a list"). The "unset = no delegation" rule lives one level up in `canDelegate`, which never calls `isTeamMember` when `team` is empty/unset — the roster is `''` and no session tools are built, so reachability is moot.

**Placement.** The roster is passed into `composeMdPrompt` as section 3, landing directly behind AGENT.md so the "who's on my team" read happens while model attention is still high (delegation is an orchestrator's first decision). Routing it through `composeMdPrompt` — rather than string-concatenating it after `mdPrompt` — is what gives it proper `\n\n---\n\n` separators on both sides; an earlier version appended it with a single `\n` and it glued onto the following `allPrompt` heading.

**Static, the single team source.** The roster is a *static* teammate list baked into the system prompt at session creation — it's the only place an orchestrator learns who its team is. (There used to be a `list_agents` tool that returned the same set at runtime; it was removed once the roster covered the discovery need — the static block is always present for a delegating agent, so a per-turn tool call was redundant.) For *detail* on a specific teammate (full tools / skills / model), the agent calls `query_agent <id>` — itself team-gated, so it can only inspect agents already on its roster.

## Step 7 — Append skills and tool list

[session-manager.ts:682-697](../../../packages/server/src/agents/session-manager.ts#L682)

### Skills (progressive disclosure)

When the YAML lists `skills`:
1. `loadSkillMetadata()` — parses only each SKILL.md's frontmatter; skills disabled in the workspace DB (`disabled_items` table) are filtered out
2. `buildSkillPrompt()` generates an `<available_skills>` XML block appended to the prompt
3. Inject the `activate_skill` tool — the agent loads the full SKILL.md on demand

**Placeholder injection**: `{{var}}` inside SKILL.md and AGENT.md bodies is replaced by `renderMdBody` in [md-vars.ts](../../../packages/server/src/prompts/md-vars.ts). See [Placeholder rendering pipeline](#placeholder-rendering-pipeline) below.

### Tool list

Tail-append:
```
Your available tools: <tool1>, <tool2>, .... Only use tools in this list.
```

### Self-review (`draft`)

When the YAML `tools:` lists `draft`, `resolveBaseToolSet` ([session-manager.ts](../../../packages/server/src/agents/session-manager.ts)) builds the self-review tool via `createDraftTool()` and stashes its per-turn `reset` on the session (`session.draftReset`). It carries no prompt text of its own beyond the tool description — the reflection contract lives in the tool's `tool_result` (an adversarial review checklist), not in the system prompt.

It exists because a plain-text answer is single-pass: the agent loop only re-calls the model on a `tool_use` block, and `thinking` runs before the answer in the same call. `draft` lets the model materialise its answer as a tool call, get back a hostile-reviewer checklist, and critique the now-concrete draft on the next call. Opt-in per agent (no global switch); bounded to 3 rounds/turn by a closure counter reset at each turn-attempt. Full mechanics in [dev/tools.md](../dev/tools.md#self-review-tool).

## Final injection order

### Root agent

```
[bootstrapPrompt]                                ← prefixed when needsBootstrap (ws > global)
USER.md                                          ← workspace > global
AGENT.md                                         ← workspace > global
## Know Your Team Before You Act                 ← root's roster framing (dropped when team is empty/unset)
## User Instructions                             ← ~/.halo/global/INSTRUCTIONS.md (suppressed when ws has its own)
## User Instructions                             ← <ws>/.halo/INSTRUCTIONS.md (workspace root)
## Project Knowledge                             ← <ws>/.halo/INDEX.md (or nudge)
"The project workspace is at: ..."
"Working directory: ..."                         ← if workingDir is set
rootPrompt                                       ← prompts/root/*.md (ws > global)
allPrompt                                        ← prompts/all/*.md (ws > global)
<available_skills>                               ← if yaml.skills non-empty
Your available tools: ...
```

root-scope leads all-scope: root-only orchestrator guidance lands while attention is high, the generic tool layer trails (same rationale as the roster riding behind AGENT.md).

(A sub-agent's `working_dir` directory-chain INSTRUCTIONS.md sit in the `## User Instructions` region — plain markdown, right after the global/ws-root layer — see Sub-agent below. A user's `@scope` injects per-turn into the message, not here — below.)

### Sub-agent

```
AGENT.md
## Your Team                                    ← lean roster (only when the agent has a non-empty team)
## User Instructions                            ← ~/.halo/global/INSTRUCTIONS.md (suppressed when ws has its own)
## User Instructions                            ← <ws>/.halo/INSTRUCTIONS.md (workspace root)
## User Instructions                            ← working_dir's directory-chain INSTRUCTIONS.md, headed ### <dir> (when working_dir set)
## Project Knowledge
"The workspace root is: ..."
"Working directory: ..."                        ← one-line focus marker (the rules above are the actual content)
allPrompt                                        ← prompts/all/*.md (ws > global)
<available_skills>
Your available tools: ...
```

(Sub-agents get the lean `## Your Team` roster — not the root's `## Know Your Team Before You Act` block — and only when the agent has a non-empty team; no USER.md, no root-scope prompts.)

## Directory-scoped instructions

Sub-directory `.halo/INSTRUCTIONS.md` files reach the model two ways, split by **who supplies the directory and how long it lives**:

Shared core: [`loadScopeBody(workspaceRoot, relDir)`](../../../packages/server/src/prompts/md-loader.ts) reads `.halo/INSTRUCTIONS.md` at every level along `workspaceRoot → relDir` **excluding the root** (the root's file is already in the system prompt) and returns a bare markdown body, each present level headed `### <dir>` (levels with no file are skipped; outer levels first). So a directory `a/b/c` pulls `a`, `a/b`, `a/b/c` — and if only an ancestor like `a/b` has a file, you still get it. The two consumers wrap that body differently:

| Trigger | Who | Lifetime | How it reaches the model |
|---|---|---|---|
| `working_dir` on `start_session` | parent agent | **persistent** — every turn, for the session's life | `composeMdPrompt` folds the **bare `loadScopeBody` markdown** into the `## User Instructions` region, right after the global/ws-root layer ([`session-agent-builder.composeSystemPrompt`](../../../packages/server/src/agents/session-agent-builder.ts)). No `<workspace-instructions>` wrapper — the section heading already frames it. `working_dir` is stored on `agent_sessions.working_dir` and restored on resume, so the rules are rebuilt into the system prompt on every `buildAgentInstance`. |
| `@scope <dir>` in a message | user (TUI / admin / channels) | **one-shot** — only the turn it rides on | `loadScopeInstructions` wraps the body in a self-describing `<workspace-instructions dir=... note=...>` block (it lands in the message stream, so it needs the tag + note to read as turn context); `SessionManager.expandScopeMarkers` strips the marker from the visible text and prepends the block to that message. Not re-injected on later turns. |

Why the split: `working_dir` is the sub-agent's persistent identity (it lives in that directory for its whole life), so its rules belong in the system prompt where they're present every turn — a first-turn-only injection would let the agent forget them after a few turns. `@scope` is ad-hoc context a user attaches to one message, so it stays loop-scoped. (The earlier `scope` args on `query_session` / `interrupt_session` were removed — they let a parent temporarily swap a child's directory rules, which contradicts working_dir being persistent identity.)

Invalid `@scope` dirs (outside workspace / missing / no INSTRUCTIONS.md along the path) are dropped with a `system` warning event; the turn still runs. The block does **not** change where tools execute — it is purely guidance.

Input completion: both the TUI (`@scope ` → directory-only path-suggest) and the admin composer (`@scope ` → `/files/search?dirsOnly=1` picker) complete directories as you type. `@scope` stays as literal text (unlike admin's `@file` mention, which is lifted into a separate reference list) so the server sees and expands it.

## Placeholder rendering pipeline

Implementation: [md-vars.ts](../../../packages/server/src/prompts/md-vars.ts)

### Two entry points, one renderer

1. **AGENT.md**: in Step 3 (after MD reads), `buildAgentInstance` calls `renderMdBody(agentMd, ctx)` and then composes the prompt (Step 5). Renders on every session spawn (env/settings changes take effect next spawn).
2. **SKILL.md**: on activation (skill-as-command or the `activate_skill` tool), the body is rendered before being returned to the agent.

Both entries build context via `buildRenderContext({args, workspaceRoot, workingDir, agentName})` and then call `renderMdBody(body, ctx)`.

### RenderContext shape

```ts
interface RenderContext {
  builtin: {                           // built-ins
    args?: string
    workspace_root?: string
    working_dir?: string
    now?: string
    user_name?: string                 // from USER.md frontmatter
    ai_name?: string
    agent_name?: string
    // Channel origin (skill invocations only — undefined for AGENT.md
    // render and admin/WS skill invocations). Filled by channel handlers
    // when they call execSkillCommand. Skills like cron use
    // these to default targets to the originating chat.
    'channel.type'?: string            // 'telegram' | 'wechat' | 'web'
    'channel.account_id'?: string
    'channel.chat_id'?: string         // telegram chat id / wechat openId
  }
  settings: Record<string, unknown>    // merged settings.yaml (env not yet substituted)
}
```

`settings` comes from `loadMergedSettings(workspaceRoot)`:
- `~/.halo/secrets/settings.yaml` is the base
- `<workspaceRoot>/.halo/settings.yaml` deep-merges on top (field-level, not block-level)

### Substitution rules

Two regexes:
- `{{\s*([\w-][\w.-]*)\s*}}` — placeholders
- `<<([A-Z_][A-Z0-9_]*)>>` — env vars

Resolving `{{xxx}}`:

1. No dot → look up `builtin[xxx]`; hit returns the value
2. **Channel built-ins**: dotted names starting with `channel.` (e.g. `channel.type`, `channel.chat_id`) are looked up directly in `builtin` by full key. Empty string when the field is unset (e.g. ws-origin skill invocations have no `chat_id`) — keeps skill bodies clean rather than leaving literal `{{channel.chat_id}}` in the rendered output.
3. **Whitelist check**: any other dotted name must match `^[\w-]+\.params\.[\w-][\w.-]*$` (e.g. `tavily-web-search.params.api_key`); anything else (including `<id>.secrets.*`, `general.*`, `logging.*`) keeps the literal `{{xxx}}` and logs a warning
4. `resolvePath(settings, xxx)` walks the settings tree
5. Stringify the leaf, then replace `<<ENV_NAME>>` → `process.env.ENV_NAME` (**missing env → keep the literal `<<ENV_NAME>>`** so users see the typo and the API call fails loudly)
6. No match or value is null → keep `{{xxx}}` literal + warn

### Scope convention

settings.yaml has three top-level scopes with strict roles:

| Path shape | Purpose | Replaced in MD? | Replaced in `shell_exec`? |
|---|---|---|---|
| `general.<key>` | System config (session limits, sandbox, compact, logging) — read by `config.ts` | No (renderer rejects) | No |
| `<id>.secrets.<key>` | Server-side credentials (model providers, OAuth apps, signing keys) — read by `config.ts getServerSecret()` | **No (renderer hard-rejects)** | **No** |
| `<id>.params.<key>` | Parameters referenced by agents / skills | Yes | Yes |

`<id>` is a provider id (declared in `models/<id>.yaml`) or a skill id (declared in `skills/<id>/config.yaml`). Each declarer ships its own schema; values land in `~/.halo/secrets/settings.yaml` at the same path.

The two-renderer enforcement (MD render + shell substitute) is the **single security boundary** preventing a skill or agent from exfiltrating server-side `<id>.secrets.<key>` keys via shell. See [requirements/settings.md](../requirements/settings.md) for details.

### Skill short-form rewrite

Inside a SKILL.md, authors can write `{{params.<key>}}` (no namespace) for ergonomics. At `activate_skill` time the loader rewrites every short form into `{{<this-skill-id>.params.<key>}}` before handing the body to the agent. AGENT.md does **not** get this rewrite — it must use the fully-qualified form, since there's no single "owning" skill id.

### Environment-variable semantics

- **Trust boundary**: `<<ENV_NAME>>` is *only* expanded inside values that came from settings.yaml — i.e. inside MD content rendered by `renderMdBody` resolving a `{{<id>.params.<key>}}` lookup, or inside cmd text after a `{{<id>.params.<key>}}` substitution in `shell_exec`. **Cmd or MD text the agent itself writes is never scanned** — `shell_exec "echo <<HOME>>"` keeps the literal `<<HOME>>`. This prevents an agent from naming an env var (whose value it learned by reading settings.yaml or guessing) and forcing the server to dump it.
- `/api/settings/schema` returning values to the frontend **does not** substitute — the user editing settings sees the literal `<<NANO_BANANA_KEY>>`, not the real key. Secrets are masked further (e.g. `AK****ST`) before transport.
- If the env var is unset, the agent receives the literal `<<NANO_BANANA_KEY>>`; API calls will fail and the error message tells the user what to fix.

### Why this layout

Schema declared by each package + values stored centrally is the same model VSCode uses for `contributes.configuration` + `settings.json`:
- Removing a package only removes its schema; values stay in `settings.yaml` (orphans), surfacing in the Settings UI's "Unclaimed values" tab for the user to prune.
- Reinstalling the package re-attaches its values automatically.
- A skill ships `config.yaml` next to `SKILL.md`, so the schema travels with the code — no central registry to maintain.

## working_dir behaviour

- `start_session` accepts a `working_dir` argument (absolute or workspace-relative)
- Default: `workspaceRoot`
- Enforced inside workspace (path traversal is rejected)
- Non-existent directory → spawn refused
- Persisted as a workspace-relative path on the `agent_sessions.working_dir` column (null = project root)
- On resume, the relative path is resolved against `workspaceRoot` and passed to `buildAgentInstance`
- The directory-chain `.halo/INSTRUCTIONS.md` along root→working_dir is baked into the system prompt every turn (see [Directory-scoped instructions](#directory-scoped-instructions)) — because working_dir is persistent identity, the rules are present on every turn, not just the first

## Key invariants

- **Override precedence**: workspace > global (USER.md, AGENT.md, INSTRUCTIONS.md, prompts/)
- **agents/ & skills/ override**: whole-folder. `<ws>/.halo/agents/<id>/` (or `skills/<id>/`) exists → serves that agent/skill entirely (agent.yaml + AGENT.md, or SKILL.md + resources), global folder ignored, no per-file fallback
- **INSTRUCTIONS.md**: workspace root INSTRUCTIONS.md suppresses global; subdirectory chain stacks on top — in the system prompt every turn when it's a sub-agent's `working_dir` (persistent), or per-turn in the message via user `@scope` (one-shot)
- **prompts/ override**: `<ws>/.halo/prompts/<scope>/` directory exists → entirely replaces global's same scope (directory-level, no per-file merge)
- **INDEX.md is project-root only**: subdirectory INDEX files are not auto-loaded
- **Root vs sub-agent**: determined by `!parentId`
- **Sub-agent does not inject**: USER.md / `prompts/root/` / `prompts/bootstrap/`
- **Internal agents (`internal: true`)**: get no workspace context at all — USER.md / INSTRUCTIONS.md / INDEX.md / `prompts/{all,root,bootstrap}` all cleared; only their own AGENT.md + tool list remain
- **Bootstrap trigger**: `!parentId && !userMd`
- **System prompts are external**: resolved from workspace then global `prompts/{bootstrap,all,root}/*.md`, read live, sorted by filename.
- **System prompt missing**: warn + use built-in fallback; `system-prompts.ts` is the seed source and fallback
- **`.halo/` is not grep/globbed**: use `file_read` + INDEX.md navigation

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
│   ├── all/                               ← every-agent rules (TOOL_GUIDELINES.md, TOOL_SHELL[.windows].md)
│   └── root/                              ← root-agent-only (empty by default; user-set)
├── builtin/                ← server-owned, version-tied, NOT user-editable
│   └── PLATFORM_KNOWLEDGE.md              ← platform self-knowledge, prepended to root scope
├── agents/<id>/{agent.yaml, AGENT.md}
└── skills/<id>/SKILL.md
```

### Workspace

```
<workspaceRoot>/.halo/
├── USER.md                         ← optional, overrides global USER.md
├── INSTRUCTIONS.md                 ← project-level (overrides global INSTRUCTIONS.md)
├── INDEX.md                        ← project overview + doc index
├── <subdir>/.halo/INSTRUCTIONS.md   ← directory-scoped, injected per-turn via @scope (NOT in the system prompt)
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

**Sub-directory INSTRUCTIONS.md are NOT in the system prompt.** They are injected per-turn on demand via the `@scope` mechanism (see [Directory-scoped instructions](#directory-scoped-instructions-scope) below) — keeping them loop-scoped (relevant to the turn that asked for them) rather than a permanent part of the agent's identity. This also keeps the system prompt stable, so prompt-cache hits aren't lost when an agent works across different sub-directories.

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
First startup writes the four default MDs to `~/.halo/global/prompts/{bootstrap,all,root}/`. Existing files are not overwritten.

### Live load (every `buildAgentInstance`)
`loadSystemPrompts(workspaceRoot?)` resolves each scope directory with workspace > global precedence:
- For each user-editable scope (`bootstrap`, `all`, `root`): if `<ws>/.halo/prompts/<scope>/` **directory exists**, use it; otherwise fall back to `~/.halo/global/prompts/<scope>/`.
- Override is at the **directory level** — the workspace directory entirely replaces the global one (no per-file merge).
- Within the resolved directory, the `.md` files are filtered by `selectForPlatform` (see below), then concatenated by filename ascending.
- The `builtin/` scope (`~/.halo/global/builtin/*.md`) is loaded separately. It is **global-only** — there is no workspace override — and is force-copied from `templates/builtin/` on every startup (so platform self-knowledge stays version-tied to the server). Its content is prepended to the resolved `root` scope: root agents see `builtin + root`, sub-agents see neither.

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
- `builtin/*.md` (global-only) + `prompts/root/*.md` → `rootPrompt` (concatenated, builtin first)

Missing directory or read failure: warn + use built-in fallback.

`loadSystemPrompts` also returns `files: { bootstrap: string[]; all: string[]; root: string[] }` — the absolute paths of the `.md` files actually read for each scope (empty when the built-in fallback was used). `session-manager.ts` forwards this list into `AgentMeta.mdFiles`, which `/session context` renders one line per file (label `prompt/<scope>/<basename>`). When a scope falls back to the built-in constants, a single line `prompt/<scope> (built-in fallback): <dir>` is shown instead.

## Step 5 — Compose the MD prompt

`composeMdPrompt(contents, roster = '')` joins non-empty sections with `\n\n---\n\n`:

1. `## User Profile` (USER.md) — root agent only
2. AGENT.md body
3. `## Know Your Team Before You Act` — the live agent roster, slotted directly behind AGENT.md (see [Agent roster](#agent-roster) below). Empty string for sub-agents / internal agents / single-agent workspaces, so the section is dropped.
4. `## User Instructions` — `~/.halo/global/INSTRUCTIONS.md` (suppressed when the workspace root has its own — see Step 2)
5. `## User Instructions` — `<ws>/.halo/INSTRUCTIONS.md` (workspace root). Sub-dir INSTRUCTIONS.md are not here; they inject per-turn via `@scope`.
6. `## Project Knowledge` — `<ws>/.halo/INDEX.md` (skipped entirely when no INDEX.md exists)

Global and workspace-root INSTRUCTIONS share the same `## User Instructions` heading: they're mutually exclusive (workspace overrides global, see Step 2), so only one ever lands in a prompt and there's no sibling to disambiguate from. The roster rides as section 3 — passing it through `composeMdPrompt` rather than concatenating it afterward gives it the same `---` separators as every other section (no glue-to-next-block).

## Step 6 — Layer in the system prompts

### Root agent (`!parentId`)

```
mdPrompt                                         ← incl. roster, slotted behind AGENT.md
+ "\n\nThe project workspace is at: {workspaceRoot}\n"
+ [optional] "Working directory: {workingDir}\n"
+ allPrompt
+ rootPrompt
```

The roster is computed once (`isRoot && !internal && canDelegate` → `buildAgentRoster`, else `''`, where `canDelegate` is "the session holds both `start_session` and `list_agents`") and handed to `composeMdPrompt`, so it lands inside `mdPrompt` behind AGENT.md. Only when there's no AGENT.md at all (the fallback branch) is a non-empty roster appended at the tail instead — there's no MD layer to slot it behind.

When `needsBootstrap`, the whole block is prefixed with `bootstrapPrompt + "\n\n---\n\n"`.

### Sub-agent (has parentId)

`userMd` is cleared and the prompt recomposed:

```
mdPrompt
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

`buildAgentRoster(selfAgentId)` ([session-agent-builder.ts](../../../packages/server/src/agents/session-agent-builder.ts)) builds a live `## Know Your Team Before You Act` block listing the agents this session can delegate to — one `- \`<id>\` — <name>: <description>` line per teammate, followed by static delegation guidance.

**Who's on the list.** Same filter as the `list_agents` tool: `scanAvailableAgents` minus `disabled` (workspace `disabled_items` table) minus `internal: true`. The agent itself **is** listed, pinned to the top and tagged `(you)`, with guidance to spawn parallel instances of itself for independent sub-tasks (a valid fan-out the roster text actively encourages) and to just do serial work directly rather than self-delegate. Hiding self used to contradict that fan-out advice. The remaining teammates follow in scan order. It returns `''` only if there's literally no agent to list (self not found in the scan — shouldn't happen for a real session); a solo workspace still gets a one-line `(you)` roster, since parallel self-spawn is the whole point.

**Gated three ways.** A roster is computed only when all three hold: `isRoot` (root session — sub-agents and internal agents always get `''`, and that's the mechanism that stops delegation cascading into endless re-subcontracting; the chain can only start at the root, where a human is watching), `!internal` (evo / score / apply are platform tooling, not orchestrators), and `canDelegate` — the session actually holds both `start_session` and `list_agents`. Without `start_session` the agent can't spawn anything; without `list_agents` it can't see who's on the team. The roster text *teaches* delegation (parallel fan-out, "ask X to do Y", inspect the team), so handing it to an agent that can't act on it is misleading noise. No delegation capability, no roster.

**Placement.** The roster is passed into `composeMdPrompt` as section 3, landing directly behind AGENT.md so the "who's on my team" read happens while model attention is still high (delegation is an orchestrator's first decision). Routing it through `composeMdPrompt` — rather than string-concatenating it after `mdPrompt` — is what gives it proper `\n\n---\n\n` separators on both sides; an earlier version appended it with a single `\n` and it glued onto the following `allPrompt` heading.

**Static vs. runtime.** The roster is a *static* teammate list baked into the system prompt at session creation. It is **not** the output of the `list_agents` tool — that tool returns the same set with full detail (tools, skills, model) at runtime, as a `tool_result` in the message stream, and never appears in the system prompt. The roster exists precisely so an orchestrator knows its team *without* having to call `list_agents` every turn.

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
## Know Your Team Before You Act                 ← agent roster (root only; dropped when team empty)
## User Instructions                             ← ~/.halo/global/INSTRUCTIONS.md (suppressed when ws has its own)
## User Instructions                             ← <ws>/.halo/INSTRUCTIONS.md (workspace root)
## Project Knowledge                             ← <ws>/.halo/INDEX.md (or nudge)
"The project workspace is at: ..."
"Working directory: ..."                         ← if workingDir is set
allPrompt                                        ← prompts/all/*.md (ws > global)
rootPrompt                                       ← prompts/root/*.md (ws > global)
<available_skills>                               ← if yaml.skills non-empty
Your available tools: ...
```

(Sub-dir INSTRUCTIONS.md are not in this prompt — they inject per-turn via `@scope`, below.)

### Sub-agent

```
AGENT.md                                        ← no roster: sub-agents can't delegate further
## User Instructions                            ← ~/.halo/global/INSTRUCTIONS.md (suppressed when ws has its own)
## User Instructions                            ← <ws>/.halo/INSTRUCTIONS.md (workspace root)
## Project Knowledge
"The workspace root is: ..."
"Working directory: ..."
allPrompt                                        ← prompts/all/*.md (ws > global)
<available_skills>
Your available tools: ...
```

## Directory-scoped instructions (`@scope`)

Sub-directory `.halo/INSTRUCTIONS.md` files are injected **per turn**, into the user/initial message — never into the system prompt. This keeps them loop-scoped and leaves the system prompt (hence the prompt cache) stable as an agent moves between directories.

Implementation: [`loadScopeInstructions(workspaceRoot, relDir)`](../../../packages/server/src/prompts/md-loader.ts) reads `.halo/INSTRUCTIONS.md` at every level along `workspaceRoot → relDir` **excluding the root** (the root's file is already in the system prompt), and renders one self-describing `<workspace-instructions dir=... note=...>` block (levels with no file are skipped; outer levels first). So `@scope a/b/c` pulls `a`, `a/b`, `a/b/c` — and if only an ancestor like `a/b` has a file, you still get it.

Four entry points, all one-shot (they affect only the turn they ride on; the block lands in that turn's message and is not re-injected later):

| Trigger | Who | Where injected |
|---|---|---|
| `@scope <dir>` in a message | user (TUI / admin / channels) | `SessionManager.expandScopeMarkers` strips the marker from the visible text and prepends the block; the busy-queue path (`enqueueUserMessage`) does the same |
| `working_dir` on `start_session` | parent agent | injected into the sub-agent's **first-turn** message only |
| `scope` arg on `query_session` | agent | prepended to that one message to the target |
| `scope` arg on `interrupt_session` | agent | prepended to the re-run message |

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

## Key invariants

- **Override precedence**: workspace > global (USER.md, AGENT.md, INSTRUCTIONS.md, prompts/)
- **agents/ & skills/ override**: whole-folder. `<ws>/.halo/agents/<id>/` (or `skills/<id>/`) exists → serves that agent/skill entirely (agent.yaml + AGENT.md, or SKILL.md + resources), global folder ignored, no per-file fallback
- **INSTRUCTIONS.md**: workspace root INSTRUCTIONS.md suppresses global; subdirectory chain still stacks on top
- **prompts/ override**: `<ws>/.halo/prompts/<scope>/` directory exists → entirely replaces global's same scope (directory-level, no per-file merge)
- **INDEX.md is project-root only**: subdirectory INDEX files are not auto-loaded
- **Root vs sub-agent**: determined by `!parentId`
- **Sub-agent does not inject**: USER.md / `prompts/root/` / `prompts/bootstrap/`
- **Internal agents (`internal: true`)**: get no workspace context at all — USER.md / INSTRUCTIONS.md / INDEX.md / `prompts/{all,root,bootstrap}` all cleared; only their own AGENT.md + tool list remain
- **Bootstrap trigger**: `!parentId && !userMd`
- **System prompts are external**: resolved from workspace then global `prompts/{bootstrap,all,root}/*.md`, read live, sorted by filename. The `builtin/` scope is global-only (server-owned, no workspace override) and gets prepended to the resolved root scope for root agents.
- **System prompt missing**: warn + use built-in fallback; `system-prompts.ts` is the seed source and fallback
- **`.halo/` is not grep/globbed**: use `file_read` + INDEX.md navigation

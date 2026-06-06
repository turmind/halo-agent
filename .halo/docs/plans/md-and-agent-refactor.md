# Refactor plan: drop is_default + working_dir + MD-load simplification + externalise system prompts

**Status**: shipped (2026-04 / 2026-05). All phases A–F landed: `priority` field replaced `is_default`, `agent_sessions.working_dir` column added, MD-loader simplified (INDEX.md root-only, INSTRUCTIONS.md stacks per directory level), system prompts externalised under `prompts/{bootstrap,all,root}/`. This doc is kept as a design log — see the reference state in [design/prompt-system.md](../design/prompt-system.md).
**Filed**: 2026-04-27

This doc preserves every design decision, rationale, and trade-off so we can rapidly recover context if it's lost.

---

## Background

Halo uses `is_default` as a synonym for "root agent", which has bad knock-on effects:
- Prompt injection logic, tool behaviour, and UI default selection all bind to this field
- User-defined "direct-chat agents" can't receive USER.md, PLATFORM_KNOWLEDGE, or other root-only prompts
- Hard-coded system prompts (BOOTSTRAP / TOOL_GUIDELINES / PLATFORM_KNOWLEDGE / ORCHESTRATOR_GUIDELINES) live in source — users wanting to customise must edit source
- INDEX.md reserves a subdirectory-loading interface but never calls it (dead code)
- INSTRUCTIONS.md only supports two layers (global + project); no subdirectory granularity

---

## Core decisions

### 1. Drop `is_default`

- The `is_default` field is deprecated. YAML uses `priority: number` instead — default 0, higher first.
- The `default` agent seed stays, `priority: 99` (remains the initial default selection).
- All `isDefault`-semantic branches become `!parentId` ("root agent") checks.
- `list_agents` no longer filters `default`; agents can spawn themselves (same agent_id, independent session instances).
- Delete protection: at least 1 agent in the global scope; workspace scope can be emptied.
- UI default selection: sort by `priority desc, name asc`, pick the first.
- Remove the "default" badge.

### 2. Add `working_dir`

- New `working_dir` argument on `start_session`
- Accepts absolute or workspace-relative paths
- Default: `workspaceRoot` (project root)
- Enforce resolved path within workspace (reject traversal)
- Non-existent directory → reject spawn
- `agent_sessions` gets a `workingDir TEXT` column (null = project root)
- On resume, DB → `buildAgentInstance`

### 3. INDEX.md — project-root-only

- `<ws>/.halo/INDEX.md` is the sole source, injected for every agent
- Sub-directory `INDEX.md` files are **not auto-loaded**; user / agent uses `file_read` on demand
- Drop `subDirIndex` logic in `resolveMdPaths` (dead code)
- Rationale: multi-level INDEX is an untested requirement; users reference sub-INDEX from the root INDEX and the agent reads on demand (progressive disclosure)

### 4. INSTRUCTIONS.md — stacked by level

- From global → workspaceRoot → every level of the workingDir path, load `.halo/INSTRUCTIONS.md`
- Injection order: outer → inner (global first, workingDir last)
- Each block labelled with its path relative to workspaceRoot (root itself uses `.`)
- Rationale: INSTRUCTIONS encode "how to work here"; directory depth is a natural scope, more specific wins

### 5. Externalise system prompts

The four hard-coded constants (BOOTSTRAP / TOOL_GUIDELINES / PLATFORM_KNOWLEDGE / ORCHESTRATOR_GUIDELINES) move to:

```
~/.halo/global/prompts/
├── bootstrap/   ← only injected for root agent + needsBootstrap
├── all/         ← injected for every agent
└── root/        ← only injected for root agent
```

- Subdirectory categorisation decides injection scope
- Inside each subdirectory, every `.md` is concatenated by filename ascending
- User extends by dropping MDs in the relevant directory (e.g. `prompts/all/my-style-guide.md`)
- Startup seed: first run writes four defaults; existing files preserved
- Live-read (every `buildAgentInstance`)
- Missing: warn + skip (don't break the server)
- `tool-guidelines.ts` remains the seed source + hard-coded fallback
- **Global only**; workspace doesn't override
- **Language**: seed content stays English (already is); UI copy stays English; section headers stay English; Chinese only in developer docs

---

## Target directory layout

### Global

```
~/.halo/global/
├── USER.md                    ← bootstrap-generated
├── INSTRUCTIONS.md            ← user-global preferences
├── prompts/
│   ├── bootstrap/BOOTSTRAP.md
│   ├── all/TOOL_GUIDELINES.md
│   └── root/PLATFORM_KNOWLEDGE.md, ORCHESTRATOR_GUIDELINES.md
├── agents/<id>/{agent.yaml, AGENT.md}
└── skills/<id>/SKILL.md
```

### Workspace

```
<ws>/.halo/
├── USER.md                       ← optional, overrides global
├── INSTRUCTIONS.md               ← project-root preferences
├── INDEX.md                      ← sole project index
├── <subdir>/.halo/INSTRUCTIONS.md  ← per-subdir preferences, stacked
├── agents/<id>/{agent.yaml, AGENT.md}
└── skills/<id>/SKILL.md
```

---

## Root vs sub-agent behaviour matrix

| Injected content | Root (`!parentId`) | Sub-agent |
|---|---|---|
| USER.md | ✓ | ✗ |
| AGENT.md | ✓ | ✓ |
| INSTRUCTIONS.md (global + stacked) | ✓ | ✓ |
| INDEX.md (project root) | ✓ | ✓ |
| `prompts/all/` | ✓ | ✓ |
| `prompts/root/` | ✓ | ✗ |
| `prompts/bootstrap/` | ✓ (only when no USER.md) | ✗ |
| `"workspace at..."` | ✓ | ✓ |
| `"Working directory: ..."` | only when workingDir != root | always |

---

## Execution phases

Grouped into 6 todo buckets:

### A. is_default → priority (backend + frontend)
- session-manager.ts: drop isDefault; replace prompt branches with `!parentId`; merge tool order; drop `list_agents` filter
- agent-loader.ts: YAML gains priority; `scanAvailableAgents` returns priority
- agent-configs.ts: `parseAgentYaml` reads priority; sort by priority desc + name asc; seed template gains `priority: 99`; DELETE adds last-global guard
- frontend types.ts + api-client.ts: rename fields
- chat-panel.tsx: default-selection logic; remove "default" badge
- agent-management-main.tsx + agent-form.tsx: delete isDefault UI

### B. working_dir feature
- `start_session` schema adds `working_dir`
- `createSession` / `buildAgentInstance` pass it through
- DB migration: `agent_sessions` adds `workingDir` column
- Resume restores from DB

### C. md-loader simplification
- INDEX.md reads only `<ws>/.halo/INDEX.md`; drop `subDirIndex`
- INSTRUCTIONS.md becomes `workspaceInstructionsChain: Array<{rel, content}>`
- `composeMdPrompt` expands the chain as multiple sections, each header labelled with relative path (root = `.`)
- Implement `collectInstructionsChain(workspaceRoot, workingDir)`

### D. Externalise system prompts
- Create `~/.halo/global/prompts/{bootstrap,all,root}/`
- `init.ts` startup seeds four MD files (content from `tool-guidelines.ts`)
- New `loadSystemPrompts()` reads live per subdir, filename-ascending concat
- Replace `import { ... } from './tool-guidelines'` with `loadSystemPrompts()` calls
- Missing: warn + fall back to the hard-coded value (keep `tool-guidelines.ts`)

### E. Doc sync
- CLAUDE.md: describe the MD load flow, agent model
- `.halo/docs/backend/md-loading-flow.md` (already in target state)
- `.halo/docs/knowledge-system.md`: directory layout, injection rules
- `.halo/docs/data-storage-protocol.md`: agent YAML fields + new agent_sessions column
- `.halo/docs/session-tools-reference.md`: `start_session` schema
- `.halo/docs/test-case.md`: updated test cases

### F. Deployment smoke test
- `pnpm --filter core/server/web build`
- Kill 9527, restart with Node 22 (PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH)
- Smoke: /api/health, WS connect, send one message end-to-end
- Verify: root agent receives prompts/root, sub-agent doesn't; INSTRUCTIONS stacking works; working_dir wires through; deletion guard fires

---

## Key constraints and risks

- **Node version**: must be v22+ (better-sqlite3 native binding bound to v22). Scripts must load nvm.
- **Compatibility**: legacy YAML's `is_default: true` stays readable but ignored; DB's `is_default` column stays untouched, just unread.
- **Backwards-compat seed**: `default` agent still auto-seeds with id `default`, but YAML uses `priority: 99`.
- **Path safety**: `working_dir` must be verified inside workspace (block `../` escapes).
- **Cache key**: with merged tool list, `cache_control` still goes on the last tool — stability unaffected.
- **Bootstrap idempotence**: once USER.md exists, `needsBootstrap` is false forever, `prompts/bootstrap/` no longer injects.
- **Self-spawn allowed**: `session_id` depth limit (`maxNestingDepth`) already guards against infinite recursion.

---

## Rollback plan

If something breaks in production:
- Git revert to pre-refactor commit
- `~/.halo/global/prompts/` directory is harmless to older versions (they don't read it)
- `agent_sessions.workingDir` column harmless (old code reads null → falls back to workspaceRoot)
- YAML `priority` harmless to older code (unknown field = default 0); `is_default: true` can be seeded back into the default agent's YAML

---

## Todo index

See the todo list. All 12 pending items run A → F; the last one is the smoke test.

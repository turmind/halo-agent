# Project Preferences & Rules

## Coding Standards

- Full TypeScript strict, ESM only
- camelCase for variables/functions, PascalCase for types, kebab-case for file names
- React functional components, styling with Tailwind only, prefer shadcn/ui
- Log format: `[ModuleName] message`

## Coding Principles

### Minimal Implementation

- Only do what's requested — don't add unmentioned features, config options, or flexibility
- Don't abstract single-use logic — three lines of duplicated code beats a premature abstraction
- Don't handle hypothetical error scenarios — only validate at system boundaries (user input, external APIs)
- If 200 lines can be done in 50, rewrite

### Precise Changes

- Only modify code directly related to the requirement — don't "improve" surrounding comments, formatting, or naming
- Match existing code style, even if you think it could be better
- Clean up orphans (unused imports/variables/functions) caused by your changes; leave pre-existing dead code alone
- Every line of diff should trace back to the user's requirement

### Read Before Write

- Read related code before making changes — understand upstream/downstream dependencies and data flow
- When multiple interpretations exist, pick the simplest approach — don't guess
- When unsure about impact scope, grep all call sites before changing

## Important Notes

- **Requirement consistency check**: Before adding features or fixing bugs, read the corresponding module docs under `.halo/docs/` to confirm the description matches the current implementation / proposed change. If inconsistent, clarify which is the source of truth before writing code
- **Remind to sync docs after code changes**: After landing changes, identify affected docs and **remind the user** (don't edit directly) — let the user decide whether to update now, after acceptance, or not at all. Typical mappings:
  - API / tool / command schema or behavior changes → `.halo/docs/dev/api.md` · `tools.md` · `requirements/command.md`
  - Architecture / data flow / WS protocol / storage format → `.halo/docs/design/`
  - User-visible features (UI behavior, interactions) → `.halo/docs/requirements/`
  - Agent-facing tool descriptions / skills / system prompts → `.halo/docs/dev/tools.md` + `design/prompt-system.md`
  - New capabilities, subsystems, channels → update `.halo/INDEX.md` index
  - Architectural decisions or gotchas → write to `.halo/memory/YYYY-MM-DD-topic.md`

  Reminder format example: "This change affects the `get_session_output` section in `dev/tools.md` and session output semantics in `design/session.md` — want to update them now?"
- **Persistent operations must not depend on in-memory state**: Delete/cleanup operations involving disk/database must query DB/filesystem directly to determine what to clean — never rely on in-memory cache objects (e.g., orchestrator Map). In-memory state can be lost at any time due to refresh, reconnection, or process restart
- **Code changes must not introduce new bugs**: Consider upstream/downstream impact holistically before changing. Check all consumers when changing data flow, check all call sites when changing interface signatures, check all read/write points when changing state lifecycle

## Working Style

- When unsure about requirement meaning, state your understanding and assumptions first — if multiple interpretations exist, list them for the user to choose
- Proactively suggest simpler approaches when available — push back when appropriate
- Choose the simplest workable solution for technical decisions, debug issues yourself, look up docs for dependency problems
- Assume AWS credentials are already configured
- When detailed information is needed, first read `.halo/INDEX.md` to find the relevant doc path, then `file_read` to load it

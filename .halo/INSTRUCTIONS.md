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

### Engineering Judgment

Counterweight to Minimal Implementation: minimal doesn't mean lazy. Before writing, ask:

- **How often does this code run?** Per inbound message? Per render? Per request? On a hot path, any synchronous DB write, repeated select, or O(n) full-table scan needs a process-local cache / hash to skip. Don't write to disk on every event when nothing changed
- **Is this write idempotent?** Before any update, ask "is the current value already the target?". If yes, skip. Don't churn `updated_at`, don't trigger downstream notification storms with no-op writes
- **Push or poll?** When the client wants to know server state changed, default to push. Catch yourself writing `setInterval(fetch, ...)` and stop — there's almost certainly a server-side state-change point that can broadcast over the existing WS channel. Polling is the lazy answer that wastes traffic and CPU 24/7
- **Repetition is a smell, not a virtue.** "Three lines beats a premature abstraction" applies to genuinely single-use logic. The same `magic_number * 60 * 1000`, the same path join, the same split-trim-filter showing up in 3 places already lost — extract immediately. Don't wait for the 4th occurrence
- **Interface consistency over local cleverness.** REST error shape, naming style (`do/handle/process`), path construction, log format — look at adjacent code's choices and match. A reviewer's first impression is "do these files feel like they were written by the same person?"

### Stop signals

When you catch yourself doing any of these, stop and reconsider:

- **Adding a filter / fallback / retry to make the bug go away** — symptom-treatment. Ask the root question: why did this data reach the wrong place? Why does this need a fallback?
- **"It only works because we also do X over there"** — the code is reaching across a boundary that should be sealed. The right fix is at the boundary, not at the symptom site
- **"This block looks duplicated but slightly different"** — usually means you're seeing surface variation, not real divergence. Sit with the common invariant; an extracted helper falls out
- **Three temporary hacks accumulating** — when you've left 3+ "this is temporary, root cause is elsewhere" comments without fixing any, stop adding new code and pay one down

### Technical-debt hygiene

- Every workaround / filter / hack gets a 1-2 line comment naming the root cause and where the real fix belongs
- Performance defaults: any `setInterval` deserves a "why not event-driven?" review; any hot-path I/O deserves a "why not cached?" review; any full-list response deserves a "what at N=10k?" review

## Important Notes

- **Requirement consistency check**: Before adding features or fixing bugs, read the corresponding module docs under `.halo/docs/` to confirm the description matches the current implementation / proposed change. If inconsistent, clarify which is the source of truth before writing code
- **Packaging / release: read the deploy docs FIRST**: Before any build, bundle, or publish (npm / desktop dmg / Windows exe / dev-server deploy), read `.halo/docs/dev/desktop-packaging.md` (Gotchas section) + `deploy.md` — do NOT package from memory. Non-negotiable checklist, each learned from a shipped regression:
  - **Build admin with `pnpm --filter @turmind/halo-admin build`, never a bare `next build`** — the latter skips `copy-monaco.mjs`, ships a monaco-less editor that 404s on `loader.js` ("Unexpected token '<'"). Verify `admin/out/monaco/vs/loader.js` exists before bundling.
  - **Touched anything under `templates/`? Bump `TEMPLATE_VERSION` (`packages/server/src/init.ts`) in the same commit** — otherwise startup's reseed gate (`on-disk < compiled`) never fires and the change never reaches existing installs.
  - When delegating packaging to a sub-agent, paste this checklist into the brief — the regressions above both happened because a packaging step was skipped silently.
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

## Delegating to sub-agents

The user finds it painful to watch a sub-agent spend its first ten minutes grepping the repo and reading design docs before touching anything. That exploration is almost always the orchestrator's fault: a brief that says *what* to fix but not *where* or *how* forces the worker to rediscover what the orchestrator already knows.

- **Locate before you delegate.** For a bug fix or a contained change, do the diagnosis yourself first — root cause, the exact files and line ranges, the existing helper / pattern the change should mirror, any reference implementation. Then hand over a brief the worker can execute without opening anything else. If you can't name the files yet, you're not ready to delegate a fix; you're ready to delegate an *investigation* (say so explicitly, and keep it separate from the fix).
- **The brief carries the findings, not the pointers.** Paste the relevant snippets, line numbers, helper names and the pattern to copy. "See `accounts.ts`" makes the worker read the whole file; "copy the `rememberLastActiveChat` pattern at `accounts.ts:185` — in-process Map dedupe, then `patchConfig`" lets it start writing.
- **Say what NOT to read.** Open the brief with an explicit scope fence: no exploratory grep, no design-doc reading, open only the listed files; if the brief turns out to be wrong about a line number or a name, follow its intent and flag the discrepancy in the report instead of stopping to map the whole area.
- **Fence the edit surface too.** List the files/dirs not to touch, whether commit / build / deploy is allowed, and exactly which verification commands to run (`tsc` scope, which test files). A worker without these defaults to "run everything", which is the other way they burn time.
- **Open-ended tasks are the exception.** Design / planning / "figure out why" work legitimately needs exploration — brief those as investigations with a clear question, and accept the reading. Just don't mix them into a fix brief.

## Git Commits

- When **you (halo) make a commit on the user's behalf**, append a co-author trailer as the last line: `Co-Authored-By: halo <halo@turmind.com>`. This only applies to agent-authored commits — commits the user writes by hand are not subject to this rule
- Match the repo's existing commit style: a `type(scope): summary` subject line (e.g. `fix(web-demo):`, `docs(cli):`) plus a body explaining the why, mirroring recent history

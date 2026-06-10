---
name: Organize Workspace
description: Set up or reorganize a workspace's `.halo/` knowledge files. First run — interview the user, draft INDEX.md / INSTRUCTIONS.md / memory entries from scratch. Subsequent runs — review what's already there, prune stale entries, reshape sections, surface gaps. Activate when the user asks to "set up / init / organize / reorganize / clean up" the workspace.
requiresAccess: workspace
---

# Organize Workspace

Invoked via `/ws setup` (first-time setup) or `/ws tidy` (review & prune an
existing knowledge base) — the mode arrives as **`$1`** (`setup` or `tidy`).
With no `$1` (natural-language activation), infer the mode: no `.halo/INDEX.md`
yet → setup; otherwise tidy.


Use this when the user wants to **set up** or **reorganize** a workspace's `.halo/` knowledge files (INDEX.md, INSTRUCTIONS.md, memory/). Two modes, picked by what's already on disk:

- **Init mode** — no `.halo/INDEX.md` yet. Draft from the README and a few clarifying questions.
- **Organize mode** — `.halo/INDEX.md` already exists. Review, prune stale entries, reshape sections, fill gaps.

## Step 0 — Detect mode

`file_read .halo/INDEX.md`. If it exists and has substantive content, you're in **organize mode** — jump to that section. If missing or trivially empty, you're in **init mode**.

You can also be in init mode while INSTRUCTIONS.md exists alone (without INDEX.md). Treat that as "init the index, leave instructions as is unless the user asks otherwise".

---

## Init mode

### 1. Look before you ask

A barrage of questions up front duplicates what the README and code already
state. Reading the project for 1–2 minutes first lets the questions you do
ask focus on what's genuinely missing:

- `file_read README.md` (try variants — README, Readme, readme)
- `file_read package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod` (identify language and stack)
- `file_list .` (see top-level layout)
- If there's a `docs/` or `.halo/docs/`, glance through it

Then tell the user what you saw: a one-sentence project summary + the stack you identified.

### 2. Ask a few targeted questions

Based on what you saw, fill in the blanks — do not ask for things the README already states. Only ask what will actually shape INSTRUCTIONS.md / INDEX.md:

- **One-line description**: if the README doesn't spell it out, ask "what is this project trying to do?"
- **Preferences and conventions**: any required coding style, naming conventions, test requirements, review focus?
- **Gotchas**: anywhere that's easy to mess up (an API that only works in a specific environment, a migration with ordering dependencies, etc.)
- **Docs organization**: how is `docs/` structured (see default layout below)?

2–4 questions total. A checklist of every possible field reads as homework
and slows the conversation; the targeted few catch what matters.

### 3. Draft INDEX.md

Skeleton:

```markdown
# <Project Name>

## Overview

<1–3 sentences: what this does + who it's for. Match the README's tone.>

## Tech Stack

- <main language + primary framework>
- <other key dependencies: DB, queue, cloud services>
- <build / package manager>
- <deployment shape: Docker / Serverless / bare metal / etc.>

## Docs Layout

<If the user doesn't have a docs/ structure yet, recommend the default below. If the project has its own structure, reflect that instead.>

- [guide/](docs/guide/) — user manual (end-user perspective)
- [requirements/](docs/requirements/) — product requirements (by module)
- [design/](docs/design/) — architecture / protocols / data flow
- [dev/](docs/dev/) — APIs, tools, deployment, environment
- [test/](docs/test/) — test cases
- [plans/](docs/plans/) — WIP proposals and open issues

## Memory

Important items (architecture decisions, pitfalls, non-obvious trade-offs) are logged in [memory/](memory/) by date, filename `YYYY-MM-DD-topic.md`. Not auto-injected — `file_read` on demand. Threshold for writing: things that will affect future decisions; skip trivial bug fixes.
```

**About the docs/ layout**: imposing the template structure on a project that
has its own creates friction without adding clarity. Reflecting the actual
structure keeps the index useful. The `memory/` section earns its spot in
every layout.

### 4. Draft INSTRUCTIONS.md

Skeleton:

```markdown
# <Project Name>

<One-line project summary. OK to duplicate INDEX.md.>

## Coding Conventions

<Distilled from the user's answers, or inferred from existing code. Generic conventions duplicate what every agent already knows; project-specific notes are the only leverage point — only write what's specific to this project>
- <e.g. TS strict, camelCase, log format [Module] msg>
- <e.g. React function components + Tailwind + shadcn/ui>

## Coding Principles

<If the user mentioned any. Skip this section if not.>

## Important Notes

<Distilled from the user's answers. Things like "persistence operations can't rely on in-memory state", "changing API signatures requires checking all callers". The pitfalls they've hit are the most valuable content here>

## Collaboration Style

<How the agent should work with them: when to push back, when to ask proactively, when to just do it>
```

Generic advice ("write elegant code", "add tests") duplicates what's already
in the agent's base instructions. INSTRUCTIONS.md earns attention with
constraints **specific to this project only**.

### 5. Show drafts, then decide whether to write

Showing both drafts **in the message** before any `file_write` lets the user
revise without disk churn. Typical feedback:

- "this section is wrong, change it to X" → revise
- "good enough, write it" → `file_write` to `.halo/INDEX.md` and `.halo/INSTRUCTIONS.md`
- "I'll edit it myself" → keep iterating on the draft in chat; the user wants the file under their own hand at write time

### 6. Seed memory/ (optional)

If the interview surfaced any "legacy gotchas" or "key decisions", offer to store them as individual memory entries:

```markdown
# <topic>

## Background
<the situation at the time>

## Decision
<what approach was chosen>

## Why Not the Alternatives
<other options and why they were dropped>

## Pitfalls
<conditions under which this decision bites back>
```

Filename `YYYY-MM-DD-<topic-slug>.md` (e.g. `2026-04-28-session-id-format.md`). One to three entries is plenty — no need for a full audit on day one.

### 7. Wrap up

Tell the user:

- These files auto-inject into new sessions (INSTRUCTIONS.md and INDEX.md), effective on the next conversation
- memory/ is read on demand — you (the agent) will `file_read` relevant entries when needed
- Future requests like "record this decision" / "update the INDEX" / "tidy this up" just need a plain-language ask

---

## Organize mode

The workspace already has an INDEX.md. Restarting from scratch would
discard the user's prior organization decisions; review mode preserves
that intent — surface what's drifted, let the user steer the cleanup.

### 1. Take stock

Read in this order:

- `file_read .halo/INDEX.md`
- `file_read .halo/INSTRUCTIONS.md` (if it exists)
- `file_list .halo/memory` (if it exists; just file names + size, not contents)
- `file_list .halo/docs` (if it exists; one level deep)

Skim the INDEX. For every `[text](docs/...)` link that points into the workspace, sanity-check it's still there (`file_read` of the target — or `file_list` of the parent dir if the link is to a directory). Note the broken or empty ones.

### 2. Spot the drift

Common things to surface:

- **Broken links**: INDEX entries pointing to docs that no longer exist or are now empty.
- **Stale memory/**: entries older than ~3 months whose topic is no longer relevant (a decision that's been superseded, a pitfall that was fixed). Auto-detecting staleness over-reaches — the dates and titles are evidence, but the call belongs to the user.
- **Missing index entries**: docs that exist on disk but aren't linked from INDEX.md. List them and ask whether they belong.
- **Section bloat**: an INSTRUCTIONS.md section that's grown into a wall of mixed-priority bullets. Suggest splitting or distilling.
- **Conflicting rules**: two bullets in INSTRUCTIONS.md that pull in opposite directions (e.g. "always run tests" + a later "skip tests for one-line fixes").
- **Generic fluff** in INSTRUCTIONS.md ("write elegant code", "follow best practices") — gently flag, ask if the user wants it gone.

### 3. Report a punch list, then ask what to tackle

A full-rewrite proposal feels like more work to the user than they
signed up for. A structured punch list lets them pick what's worth
tackling:

```
INDEX.md:
  • 2 broken links (docs/old-protocol.md, docs/dev/foo.md → both deleted)
  • 4 docs on disk not in the index (docs/dev/api.md, docs/design/auth.md, …)
  • Section "Memory" still references the format from a year ago

INSTRUCTIONS.md:
  • "Coding Principles" section grown to 18 bullets — candidate for distillation
  • Conflicting rules: "always run tests" (line 23) vs "skip tests for trivial edits" (line 41)

memory/:
  • 7 entries older than 3 months — anything obsolete?
  • 2025-12-01-bedrock-streaming.md and 2026-04-28-session-id-format.md cover overlapping ground
```

Then ask: *"What do you want to tackle? (any subset, or all of it)"*. Wait for the user to pick. They might say "fix the broken links and ignore the rest" — that's fine, do exactly that.

### 4. Apply the changes the user picked

For each chosen item:

- **Broken / missing INDEX entries** — `file_edit` INDEX.md, removing dead links and adding the missing ones (after asking which section they belong in).
- **Distill an INSTRUCTIONS section** — propose the rewrite in the chat first; auto-writing locks in misalignment before the user can catch it. Apply on confirmation.
- **Stale memory/** — for each candidate, show date + title + first paragraph; let the user say keep / archive / delete. Archive = move into `.halo/memory/archive/` (create the dir if needed). Delete = `shell_exec rm`.
- **Merge overlapping memory entries** — read both, propose a merged version with the older filename retired into archive.

### 5. Stay in review mode

When the user's ask is "tidy this up", rewriting INDEX.md from the README
or restaging the docs/ structure is init-mode work — it overwrites their
existing organization. The review-and-prune lane respects what they
already built. A full rewrite happens only when they explicitly ask for
one.

### 6. Wrap up

Summarize what changed (files edited, memory archived/deleted) and remind them:

- INDEX.md / INSTRUCTIONS.md changes are effective on the next conversation
- Archived memory/ entries are still searchable via `file_read`, just not surfaced by default

---

## Patterns that go sideways (both modes)

- Asking the user about facts already in the README — duplicates content
  they expect you to read.
- Generic template fluff ("write good comments", "use TDD") — every agent
  already knows it; project-specific notes are the only leverage point.
- `file_write` on INDEX.md / INSTRUCTIONS.md while drafts are still in flux
  — locks in misalignment that's cheap to fix in chat but expensive to fix
  on disk.
- Triggering this flow during casual browsing (user poking around /tmp or
  someone else's repo) — they're not in setup mode, so the skill drives
  past their actual ask.
- Auto-deletion of memory/ entries — erases context the user may need
  later; confirming preserves the recovery option.
- Organize mode rewriting things outside the user's ask — turns a
  pruning task into a review of unrelated changes.

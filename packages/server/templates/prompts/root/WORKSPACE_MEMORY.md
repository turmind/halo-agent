## Workspace Long-Term Memory

Each workspace has a `.halo/` directory whose persistent files outlive any single session — this is how the workspace remembers across conversations:

| File | Purpose | When to write |
|------|---------|---------------|
| `.halo/INSTRUCTIONS.md` | Project conventions | When writing normative rules |
| `.halo/INDEX.md` | Project documentation index | After project changes — remind the user to sync |
| `.halo/memory/YYYY-MM-DD.md` | Past work worth keeping | When something should outlive this session |

Creating `.halo/INSTRUCTIONS.md` **replaces** the global INSTRUCTIONS.md in prompts (override, not additive) — when first creating it, carry over any global rules that should keep applying.

**New workspace has no INDEX.md**: If the user starts discussing this project's goals/structure and it looks like real work, proactively offer to draft one. Don't ask for casual browsing.

- Name memory files `YYYY-MM-DD-<topic>.md`; write only what will change a future decision (architecture choices, gotchas, trade-offs) — routine fixes don't belong.
- After changing behavior, name the `.halo/docs/` files it affects and ask the user whether to update them now — don't edit docs unasked.

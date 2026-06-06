# Global Instructions

These instructions apply to all agents across all projects.

## Communication

- Reply in the same language the user uses
- Be concise, direct, and honest — don't restate the question, don't over-hedge, don't make up what you don't know

## Tools

- Don't guess at file contents — `file_read` first, then modify
- Before changing code, check upstream/downstream dependencies; grep for callers if unsure
- Runtime intermediates (temp files, logs, downloaded media, generated artifacts) go in `<workspace>/.halo/tmp/` by default

## Workspace Long-Term Memory

Each workspace has a `.halo/` directory. These files shape how agents remember and collaborate:

| File | Purpose | When to write |
|------|---------|---------------|
| `.halo/INSTRUCTIONS.md` | Project conventions | When writing normative rules |
| `.halo/INDEX.md` | Project documentation index | After project changes — remind the user to sync |
| `.halo/memory/YYYY-MM-DD.md` | Past work worth keeping | When something should outlive this session |

**INSTRUCTIONS.md override / layering**:

- **Workspace replaces global**: if `<workspaceRoot>/.halo/INSTRUCTIONS.md` exists, the global file (this one) is **fully suppressed** at runtime — not merged. Anything from global you still want must be copied into the workspace file.
- **Subdirectory layering** (inside the workspace): from `<workspaceRoot>` down to the agent's `workingDir`, each `<dir>/.halo/INSTRUCTIONS.md` along the path is **stacked on top** of the workspace-root file. Innermost wins on conflict. This chain is independent of global; even with no workspace-root file, a subdir file is still loaded.

**New workspace has no INDEX.md**: If the user starts discussing this project's goals/structure and it looks like real work, proactively offer to draft one. Don't ask for casual browsing.

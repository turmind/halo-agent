## Tool Usage Guidelines

### Tool Choice

Default priority:
- **Search content** → `grep` over shelling out (`grep` / `rg` / `find` in `shell_exec`)
- **Find files by name/pattern** → `glob` over `file_list` walking
- **Edit a file** → `file_edit` (targeted) over `file_write` (only for new files or full rewrites)
- **Read a large file** → `grep` first to locate the section, then `file_read` with `offset`/`limit`

Worked examples (query → tool):
- "Rename function `foo` everywhere" → `grep` for callers across the repo, then `file_edit` each hit.
- "Where does config X get loaded?" → `grep` the symbol, not a directory walk.
- "List all yaml under `.halo/agents`" → `glob({ pattern: "**/*.yaml", path: ".halo/agents" })`.
- "Find TODOs in the API layer" → `grep({ pattern: "TODO", path: "src/api", include: "*.ts" })`.

### glob / grep — narrow the scope first
Both walk every file under their `path`. Pick the narrowest `path` that contains what you want, and use `include` (grep) or a specific pattern (glob) to filter further. Unsure where a file is? `file_list` a likely parent first to figure out the right subdirectory, then `glob` inside it.

### Output
- Don't dump whole files — grep or summarize
- For >100 lines, focus on errors, stack traces, status codes

### When a Tool Fails
- Read the error, don't blind-retry
- After 2 same-approach failures, change approach
- Common causes: wrong path (use `glob` to verify), stale content (re-read), `file_edit` mismatch (re-read first to copy `old_string` exactly)

### file_edit staleness — re-read between edits to the same file
After any successful `file_edit`, your earlier `file_read` of that file is **stale**. Don't reach for `old_string` from memory or from an old read; the bytes have shifted. Re-read the relevant range, then build the next `old_string` from that fresh read. The same applies after any external change to a file (another agent, a build step, a shell command).

### Execution
- If asked to do something, do it — don't just describe
- Text-only reply when tools fit the task = incomplete
- Report concrete results (files changed, commands run, output seen), not "done"

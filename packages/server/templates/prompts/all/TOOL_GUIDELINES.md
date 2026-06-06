## Tool Usage Guidelines

### Tool Choice
- `grep` for content search, `glob` for file patterns — don't shell out to `grep` / `find`
- `file_read` before editing; `file_edit` for targeted changes, `file_write` only for new files or full rewrites
- `file_list` to explore structure; for large files, `grep` first to locate the section

### glob / grep — narrow the scope first
Both walk every file under their `path`. Pick the narrowest `path` that contains what you want, and use `include` (grep) or a specific pattern (glob) to filter further.
- `glob({ pattern: "**/*.yaml", path: ".halo/agents" })` — looks where agent configs live
- `grep({ pattern: "TODO", path: "src/api", include: "*.ts" })` — content + filter
- Unsure where a file is? `file_list` a likely parent first to figure out the right subdirectory, then `glob` inside it.

### Output
- Don't dump whole files — grep or summarize
- For >100 lines, focus on errors, stack traces, status codes

### When a Tool Fails
- Read the error, don't blind-retry
- After 2 same-approach failures, change approach
- Common causes: wrong path (use `glob` to verify), stale content (re-read), `file_edit` mismatch (re-read first to copy `old_string` exactly)

### Execution
- If asked to do something, do it — don't just describe
- Text-only reply when tools fit the task = incomplete
- Report concrete results (files changed, commands run, output seen), not "done"

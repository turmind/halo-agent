# Platform Docs Seeding Test Cases

Test URL: local server (default `http://localhost:9527/?folder=<absolute-workspace-path>`).
Password: whatever `HALO_PASSWORD` is set to, or the random password printed by the server on first startup.

Prerequisite: `~/.halo/global/` already exists from a prior run. Pick any workspace that is **not** the halo source repo (e.g. `/path/to/test-workspace`).

---

## Test matrix

### A. First-time seed

| # | Scenario | Method | Expected |
|---|---|---|---|
| A1 | Fresh install simulation | `rm -rf ~/.halo/global/docs && restart server` | Startup log: `[Init] Seeding platform docs from ...`; `~/.halo/global/docs/` has 13 files |
| A2 | Source detection in monorepo | Start server from `/path/to/halo`, delete docs first | Log: `Seeding platform docs from /path/to/halo/.halo/docs` |
| A3 | Source detection for packaged install | Create `packages/server/bundled-docs/guide/skills.md` with "FAKE"; delete `~/.halo/global/docs/`; restart | Log says `Seeding platform docs from .../bundled-docs`; `~/.halo/global/docs/guide/skills.md` contains "FAKE" |
| A4 | No source at all | Move init.js somewhere isolated (no repo parent, no bundled-docs), run | Log: `[Init] No docs source found — skipping platform docs seed`; no crash; `~/.halo/global/docs/` not created |
| A5 | Allowlist boundary | After A1, check what's in `~/.halo/global/docs/` | Only 13 files: `guide/` (8), `dev/` (3), `requirements/` (2). **No** `INDEX.md`, `design/`, `test/`, `plans/`, or other `dev/`/`requirements/` files (the doc lookup table now lives inline in the `halo` skill) |

### B. User edits and upgrades

| # | Scenario | Method | Expected |
|---|---|---|---|
| B1 | User edit preserved | Edit `~/.halo/global/docs/guide/skills.md` → restart server | Edit intact; no `[Init] Created` log for that file |
| B2 | Deleted file restored | `rm ~/.halo/global/docs/guide/agents.md` → restart | Log: `[Init] Created .../agents.md`; file restored from source |
| B3 | Version bump hint | Set `.template-version` to a value below the current `TEMPLATE_VERSION` (see `packages/server/src/init.ts`), restart | Log: `[Init] Seed templates updated: v<old> → v<current>. To refresh a specific file, delete it from ... and restart.` Plus `[Server] Templates outdated (v<old> → v<current>), refreshing ~/.halo/global/` from the startup version-check |
| B4 | Idempotent second run | Restart the server twice in a row | Second run has **no** `[Init] Created` logs; `.template-version` stays at the current `TEMPLATE_VERSION` |

### C. Agent-facing integration

| # | Scenario | Input | Expected |
|---|---|---|---|
| C1 | `halo` skill carries the doc table | Open any chat with the default agent, Debug mode → first message → Prompt button | System prompt lists the `halo` skill in the available-skills block. Activate it (`activate_skill halo`) and the loaded body contains `### Platform Documentation` with the "User asks … / Read …" lookup table |
| C2 | Agent knows about bundled docs | Open chat in a non-halo workspace, ask: "what platform docs ship with halo?" | Agent activates the `halo` skill and answers from its lookup table (no `file_read` needed for the overview) |
| C3 | Answer to "how do I test my skill?" | New chat, ask: "I just made a skill. How do I test it?" | Agent reads `~/.halo/global/docs/guide/testing-agents-and-skills.md` directly (path from system prompt table), answers with the attach-to-agent → Test → trigger flow |
| C4 | Answer to "where do API keys go?" | New chat, ask: "I want my skill to use an API key. Where do I put it?" | Agent reads `guide/secrets-and-credentials.md`, explains schema in `config.yaml` + value in `settings.yaml` + `<<ENV>>` + skill body using `{{params.<key>}}` short form |
| C5 | Answer for a question NOT in bundled docs | New chat, ask: "how does the file watcher debounce work?" | Agent looks for it in the docs, doesn't find (bundled docs don't have `design/`), falls back to reading code or admits it doesn't know — **does not hallucinate** |
| C6 | Works in any workspace | Repeat C3 in a workspace that has **no** `.halo/docs/` of its own (e.g. `/path/to/test-workspace`) | Same answer — proves docs come from `~/.halo/global/`, not the workspace |

### D. Negative / edge cases

| # | Scenario | Method | Expected |
|---|---|---|---|
| D1 | Permissions issue | `chmod -w ~/.halo/global/docs/` → delete one file → restart | `[Init] Failed to read template` or similar error logged; server still starts (seed is best-effort) |
| D2 | Concurrent starts | Start two server processes at the same time against the same home dir | Only one wins the pid lock; losers exit cleanly (not a seed-specific test, but confirms seed doesn't race) |
| D3 | Partially-populated docs | Remove half the files in `~/.halo/global/docs/guide/`; restart | Exactly the removed files get `[Init] Created` logs; others untouched |
| D4 | Garbage `.template-version` | Write `abc` to `~/.halo/global/.template-version`; restart | Treated as 0; seed runs; version is reset to the current `TEMPLATE_VERSION` at the end |

---

## Verification helpers

### Check seeded file count

```bash
find ~/.halo/global/docs -type f | wc -l
# Expected: 13
```

### Check allowlist boundary (A5)

```bash
# These should all NOT exist
ls ~/.halo/global/docs/design/ 2>&1  # No such file
ls ~/.halo/global/docs/test/ 2>&1    # No such file
ls ~/.halo/global/docs/plans/ 2>&1   # No such file
ls ~/.halo/global/docs/requirements/terminal.md 2>&1  # No such file
ls ~/.halo/global/docs/dev/api.md 2>&1                # No such file
```

### Check `halo` skill carries the doc table (C1)

```bash
grep -A 3 "Platform Documentation" ~/.halo/global/skills/halo/SKILL.md
# Expected: "### Platform Documentation" section with the inline "User asks … / Read …" lookup table
```

### Check source that was used

```bash
grep "Seeding platform docs\|No docs source" /tmp/halo.log 2>/dev/null | tail -1
# Or check server's stdout — the log line is emitted once per startup
```

### Force a fresh seed

```bash
rm -rf ~/.halo/global/docs ~/.halo/global/.template-version
# Restart server
# Expected: 13 [Init] Created log lines for docs/*
```

---

## Known limitations

- **Cross-links to non-bundled docs** (e.g. `guide/skills.md` → `design/prompt-system.md`) will 404 if an agent tries to follow them. Agents should answer from the doc body rather than chase links. Noted in the `halo` skill body.
- **Version downgrade** not detected: if you set `.template-version` higher than the current `TEMPLATE_VERSION`, nothing happens — no warning, no overwrite. Not a concern in practice.
- **Seed does not overwrite**. If a user edits a file and a newer Halo version ships a fix to the same doc, the user's edit wins. Workaround: `rm` the file and restart.

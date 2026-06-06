---
name: Share Workspace
description: Package the current workspace's prompt environment (.halo/ config) into a shareable zip — receiver gets the same agents/skills/prompts setup. Activate when the user asks to "share / package / bundle / export" the workspace.
command: /share-workspace
requiresAccess: full
---

# Share Workspace

Stage the current workspace's `.halo/` into a self-contained bundle, let the user review what
made the cut, then zip it up. The bundle is designed to drop into any other project and yield
the same Halo behavior — agents, skills, prompts, instructions — minus anything personal.

What's included: **all** workspace-scope agents/skills, plus any **global**-scope ones an
included agent references that the workspace doesn't already have (workspace wins on id clash).
Platform built-ins (default / executor / send-file / create-skill / …) are **not** bundled —
the receiver's own server seeds those on startup, so shipping them would be redundant and could
leak local edits. So the receiver gets: your customizations + needed global extensions + their
own fresh built-ins = a workspace that runs as-is.

A Python helper (`stage.py`, sibling of this file) does the heavy lifting:
file selection, secret redaction, manifest. You orchestrate it and confirm with the user.

## Steps

### 1. Locate the helper

The script lives at one of these paths (workspace wins if both exist):
- \`<workspace-root>/.halo/skills/share-workspace/stage.py\`
- \`~/.halo/global/skills/share-workspace/stage.py\`

The two paths above are deterministic, so \`glob\` / \`find\` searches add latency
without finding anything new. \`file_list\` the workspace skill dir first; if
no \`stage.py\` there, fall back to the global path.

### 2. Run the staging script

The argument is the **workspace root** (the directory containing \`.halo/\`). This is the
project the user is currently in — same path you'd see in \`/ws\`. Passing \`/home/<user>\`
or any parent traverses far more than the workspace and pulls in noise.

```bash
shell_exec: python3 <stage.py-path> <workspace-root>
```

Output is a JSON object on stdout summarizing what was staged. The full file contents go to
`<workspace>/.halo/tmp/share/staged/`.

### 3. Read the manifest and summarize for the user

The script writes `<staged>/share-manifest.json`. Read it and present a digest. Keep the
output focused on what's *in* the bundle — agents, skills, redactions, suspicious flags.
You don't need to echo the staged path or generation timestamp back to the user.

```
Agents (2):
  - code-reviewer (workspace)
  - researcher (global)

Skills (3):
  - repo-conventions (workspace)
  - aws-knowledge (global)
  - nova-web-search (global)

Instructions: .halo/INSTRUCTIONS.md (global fallback)
INDEX.md → 2 docs followed: docs/architecture/auth.md, docs/dev/api.md

Prompts: all=global-fallback, root=global-fallback

Redactions:
  • 1 secret field auto-replaced with {{...params.api_key}} placeholder
  • 0 unambiguous leaks redacted in markdown
  • 2 suspicious strings flagged for review (see below)

Excluded:
  • USER.md (3 files — personal profile)
  • memory/ (12 files)
  • assets/ (84 files)
  • sessions/, logs/, tmp/, *.db, settings.yaml — always
```

Lead with the most important callouts: anything in the **redactions** section, anything in
**missing_skills**, and anything that looks wrong (unexpected agent included, expected one
missing).

### 4. Walk through suspicious markdown findings

For each entry in `redactions.markdown_suspicious`, read the actual line from the staged file
and show the user. Use the **full word** ("keep" / "redact" / "edit") in the prompt — single
letters confuse the model when the user replies with just "k". Stay in the share-workspace
flow until all suspicious entries are resolved:

```
⚠️  Suspicious match — needs your call:

  File:    .halo/agents/default/AGENT.md, line 42
  Pattern: email
  Line:    "contact alice@example.com for the staging creds"

This looks like {your interpretation: e.g. "a real email" or "a doc placeholder"}.

How should I handle it?
  - Reply **keep** — leave it as-is (it's a doc example / not sensitive)
  - Reply **redact** — replace with [REDACTED:email]
  - Reply **edit X** — change the snippet to X
```

When the user replies with "keep" / "k" → record decision and move to the next finding.
When they reply with "redact" / "r" → `file_edit` the *staged* file (not the workspace
file), substituting the snippet with `[REDACTED:<pattern>]`.
When they reply with "edit ..." → apply their replacement via `file_edit`.

After every suspicious entry is resolved, summarize the decisions and move to step 5. **Do not
treat short responses (`k`, `r`, `keep`, etc.) as off-topic chat** — you are still inside the
share-workspace flow until the user explicitly cancels or you finish step 7.

### 5. Hand control to the user

> "Bundle staged at `.halo/tmp/share/staged/`. Have a look — open files directly, edit anything
> sensitive, remove anything you don't want shared. When you're happy, tell me to zip it."

Wait for explicit confirmation before zipping. Auto-zipping at this step
skips the user's last review window for sensitive content.

### 6. Zip on confirmation

```bash
cd <workspace>/.halo/tmp/share/staged
zip -r ../workspace-$(date +%Y-%m-%d).zip .halo README.md
```

Notes:
- `share-manifest.json` is intentionally **not** zipped — it's a review aid, not part of the bundle.
- `README.md` goes in the zip so the receiver knows what to do.

### 7. Report

```
Bundle ready: .halo/tmp/share/workspace-2026-05-16.zip (147 KB)

To share: send the zip. Receiver unzips into their project root, then fills in any
{{...params.<key>}} placeholders (grep the unzipped tree to find them).
```

## What gets included / excluded (rules the helper enforces)

**Included:**
- `<ws>/.halo/INSTRUCTIONS.md` chain (root + any sub-dir `.halo/INSTRUCTIONS.md`).
  If the workspace has no root `INSTRUCTIONS.md`, falls back to `~/.halo/global/INSTRUCTIONS.md`.
- `<ws>/.halo/INDEX.md` plus only the `docs/...` paths it links to (other paths ignored).
- All workspace agents (`<ws>/.halo/agents/<id>/`), minus `USER.md`.
- Global agents that **are not in the workspace's `disabled_items`** AND **not overridden by a
  workspace agent of the same id**. Those get copied into the bundle's `agents/` so the receiver
  doesn't depend on having identical globals.
- Skills that are **referenced by an included agent's `skills:` list**. Workspace skill wins;
  otherwise global skill (if not disabled).
- `prompts/{bootstrap,all,root}/` — workspace dir if it exists, else global fallback.

**Excluded (always):**
- Every `USER.md` (workspace, agent dirs, anywhere) — personal profile, never share.
- `memory/`, `assets/` — workspace-specific knowledge / data.
- `sessions/`, `logs/`, `tmp/`, `*.db`, `*.db-shm`, `*.db-wal` — runtime state.
- `~/.halo/secrets/settings.yaml` — secrets are redacted into agent.yaml/SKILL.md as
  `{{<id>.params.<key>}}` placeholders; the receiver fills them in their own `settings.yaml`.
- Agents with `internal: true` in their `agent.yaml` (`__evo_agent__`, `__score__`,
  `__apply_agent__`, etc.) — these are platform-internal, force-overwritten by the
  receiver's own server on startup, so bundling them is redundant and can leak
  experimental local edits.

## Sanitization

- **YAML field redaction (auto):** Inside `agent.yaml` and SKILL.md frontmatter, fields named
  `api_key`, `secret`, `token`, `password`, `access_key`, `aws_secret_access_key`, `bot_token`,
  `client_secret` (case-insensitive) get their values replaced with `{{<id>.params.<field>}}`
  if the value is a literal (not already a `{{...}}` or `<<ENV>>` placeholder).
- **Markdown auto-redact:** AWS access key formats (`AKIA…`, `ASIA…`) are replaced with
  `[REDACTED:<type>]`.
- **Markdown flag-only:** Emails, bearer-style headers, and long base64-ish tokens are
  flagged in the manifest but **not auto-replaced** — too many false positives. You walk
  the user through these in step 4.

## Patterns that go sideways

- Zipping before user confirmation — they lose the chance to catch
  sensitive data the auto-redactions missed; explicit confirmation keeps
  the call with them.
- Including `share-manifest.json` in the zip — clutters the receiver's
  unpacked tree with a review aid that's only useful during staging.
- Including business data (anything outside `.halo/`) in the zip —
  violates the sharing intent and raises security risk; the user expects
  configuration only.
- Modifying the user's actual workspace files instead of the staged copy
  — the original changes are irreversible, the staged copy is where
  sanitization belongs.

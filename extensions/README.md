# Extensions

Archive of extra agents / skills kept alongside the code. **Not auto-loaded by Halo** — copy into `~/.halo/global/` or `<workspace>/.halo/` by hand to activate.

Intended to evolve into an extension market (install / versioning / dependency resolution). For now it's just a git-tracked stash.

## Layout

```
extensions/
├── agents/
│   ├── <agent-id>/
│   │   ├── agent.yaml
│   │   └── AGENT.md
│   └── ...
└── skills/
    └── <skill-id>/
        └── SKILL.md
```

## Install to global

```bash
# Agent
cp -r extensions/agents/<agent-id> ~/.halo/global/agents/

# Skill
cp -r extensions/skills/nova-web-search ~/.halo/global/skills/
```

Takes effect on the next agent spawn (running sessions are unaffected — `/new` to pick up the new prompt).

## Install to a workspace

```bash
cp -r extensions/skills/nova-web-search /path/to/workspace/.halo/skills/
```

Workspace versions **override** global entries with the same id.

## Uninstall

Delete the corresponding directory. Keep at least one global agent (the server refuses to delete the last one).

## Current inventory

### Agents

_None currently._

### Skills

| ID | Purpose |
|----|---------|
| [canvas-pptx](skills/canvas-pptx/) | Create, edit, and inspect PowerPoint (.pptx) files — Halo-adapted port of Anthropic's canvas_pptx |
| [nova-web-search](skills/nova-web-search/) | Real-time web search via Amazon Nova 2 Lite's `nova_grounding` — replacement for `web_search` |
| [send-file](skills/send-file/) | Send images, videos, or files as attachments to the current user across all channels |

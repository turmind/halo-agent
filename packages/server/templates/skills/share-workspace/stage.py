#!/usr/bin/env python3
"""
Stage a Halo workspace's .halo/ contents into a shareable bundle.

Run from the share-workspace skill via shell_exec:
    python3 stage.py <workspace>

Output:
    <workspace>/.halo/tmp/share/staged/
        ├── .halo/                ← mirrors target workspace's .halo/ (zip this)
        ├── share-manifest.json     ← review aid (NOT part of the final zip)
        ├── REQUIRED_PARAMS.md      ← receiver fills these in (in zip)
        └── README.md               ← receiver instructions (in zip)

The agent runs this, reads the manifest, summarizes for the user, awaits
confirmation, then zips `<staged>/.halo/`, REQUIRED_PARAMS.md, and README.md.
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("Error: PyYAML required. Install with `pip install pyyaml` (or `pip3 install pyyaml`).")

# --- patterns --------------------------------------------------------------

SECRET_FIELD = re.compile(
    r"^(api[-_]?key|secret|secret[-_]?key|token|password|access[-_]?key|"
    r"aws[-_]?secret[-_]?access[-_]?key|bot[-_]?token|client[-_]?secret)$",
    re.IGNORECASE,
)

PLACEHOLDER = re.compile(r"^\s*(\{\{[^}]+\}\}|<<[^>]+>>)\s*$")

# (label, pattern, action) — action is "redact" | "flag"
LEAK_PATTERNS = [
    ("aws-access-key",  re.compile(r"AKIA[0-9A-Z]{16}"),                                 "redact"),
    ("aws-session-key", re.compile(r"ASIA[0-9A-Z]{16}"),                                 "redact"),
    ("bearer-header",   re.compile(r"(?i)\b(bearer|authorization)\s*[:\s]\s*[^\s]{8,}"), "flag"),
    ("email",           re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),                     "flag"),
    # Long base64-ish token. Constrained:
    #   - 40+ chars from the strict base64 alphabet (no `_` or `-`, those are URL-safe variant
    #     and produce too many path-like false positives)
    #   - Contains at least one digit AND at least one upper- and one lower-case letter
    #     (filters out repeated-character padding in markdown rules / dividers)
    #   - Optional `=` padding
    # This still flags real tokens (JWTs, AWS session tokens, OAuth) without snagging
    # filesystem paths (which contain `/` segments and word-shaped chunks).
    ("long-base64", re.compile(
        r"(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)"
        r"\b[A-Za-z0-9+/]{40,}={0,2}\b"
    ), "flag"),
]

ALWAYS_EXCLUDED = ["sessions/", "logs/", "tmp/", "*.db", "*.db-shm", "*.db-wal", "settings.yaml", "USER.md"]

# Platform built-ins. The receiver's own server force-seeds these on every
# startup (see packages/server/src/init.ts BUILTIN_AGENT_IDS / BUILTIN_SKILL_IDS),
# so a *global*-scope copy never needs to ride along in the bundle — it'd be
# redundant and would leak any local edits the sharer made to them. Keep this
# in sync with init.ts (small, rarely changes). Workspace-scope overrides of
# these ids ARE still shared — those are real per-workspace customizations.
BUILTIN_AGENT_IDS = {
    "__apply_agent__", "__evo_agent__", "__score__",
    "default", "executor", "deep-executor",
}
BUILTIN_SKILL_IDS = {
    "create-agent", "create-skill", "organize-workspace",
    "share-workspace", "manage-cron-jobs", "send-file", "create-halo-acp",
}

# --- helpers ---------------------------------------------------------------

def load_disabled(db_path: Path):
    """Return (disabled_global_agents, disabled_global_skills) from workspace DB."""
    if not db_path.exists():
        return set(), set()
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.execute("SELECT item_type, item_id FROM disabled_items WHERE scope='global'")
        agents, skills = set(), set()
        for item_type, item_id in cur:
            (agents if item_type == "agent" else skills).add(item_id)
        conn.close()
        return agents, skills
    except sqlite3.DatabaseError:
        return set(), set()


def load_yaml(path: Path):
    try:
        with path.open("r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return None


def sanitize_yaml(data, namespace: str, file_label: str, findings: list) -> bool:
    """Replace leaf string values under SECRET_FIELD keys with `{{ns.params.key}}`."""
    modified = [False]

    def walk(node, key_chain):
        if isinstance(node, dict):
            for k, v in list(node.items()):
                key_str = str(k)
                if isinstance(v, (dict, list)):
                    walk(v, key_chain + [key_str])
                elif isinstance(v, str) and SECRET_FIELD.match(key_str) and v.strip() and not PLACEHOLDER.match(v):
                    placeholder = f"{{{{{namespace}.params.{key_str}}}}}"
                    node[k] = placeholder
                    modified[0] = True
                    findings.append({
                        "file": file_label,
                        "field": ".".join(key_chain + [key_str]),
                        "placeholder": placeholder,
                    })
        elif isinstance(node, list):
            for item in node:
                walk(item, key_chain)

    walk(data, [])
    return modified[0]


def sanitize_markdown(text: str, file_label: str):
    """Auto-redact high-confidence leaks; collect lower-confidence ones for review."""
    auto, suspicious = [], []
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines, 1):
        new_line = line
        for label, pattern, action in LEAK_PATTERNS:
            for m in pattern.finditer(new_line):
                excerpt = m.group(0)
                if action == "redact":
                    new_line = new_line.replace(excerpt, f"[REDACTED:{label}]")
                    auto.append({"file": file_label, "line": i, "pattern": label, "before": excerpt[:60]})
                else:
                    suspicious.append({"file": file_label, "line": i, "pattern": label, "snippet": excerpt[:80]})
        lines[i - 1] = new_line
    return "".join(lines), auto, suspicious


def sanitize_md_file(src: Path, dst: Path, label: str, manifest: dict):
    """Read src, sanitize, write to dst, accumulate redactions into manifest."""
    text = src.read_text(encoding="utf-8")
    text, auto, sus = sanitize_markdown(text, label)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(text, encoding="utf-8")
    manifest["redactions"]["markdown_auto"].extend(auto)
    manifest["redactions"]["markdown_suspicious"].extend(sus)


def index_doc_links(index_path: Path) -> list:
    """[text](docs/...) markdown links from INDEX.md. Only follow docs/-prefixed paths."""
    if not index_path.exists():
        return []
    text = index_path.read_text(encoding="utf-8")
    return [m.group(1).strip() for m in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", text)
            if m.group(1).strip().startswith("docs/")]


# --- main ------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", help="Workspace root (containing .halo/)")
    args = ap.parse_args()

    ws = Path(args.workspace).resolve()
    ws_halo = ws / ".halo"
    if not ws_halo.is_dir():
        sys.exit(f"Error: {ws_halo} not found. Is this a Halo workspace?")

    home_global = Path.home() / ".halo" / "global"

    stage_root = ws_halo / "tmp" / "share" / "staged"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True)
    stage_halo = stage_root / ".halo"
    stage_halo.mkdir()

    # All paths in the manifest/stdout are relative to the workspace root,
    # so the bundle and review aid never leak the host's absolute layout.
    manifest = {
        "staged_at": str(stage_root.relative_to(ws)),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "included": {
            "instructions": [],
            "index": None,
            "docs": [],
            "agents": [],
            "skills": [],
            "prompts": {"all": None, "root": None},
        },
        "excluded": {
            "user_md": [],
            "memory_count": 0,
            "assets_count": 0,
            "missing_skills": [],
            "always_excluded": ALWAYS_EXCLUDED,
        },
        "redactions": {"yaml_params": [], "markdown_auto": [], "markdown_suspicious": []},
    }

    disabled_agents, disabled_skills = load_disabled(ws_halo / "halo.db")

    # --- INSTRUCTIONS.md (root + sub-dir chain), with global fallback if no root ws version
    ws_root_instr = ws_halo / "INSTRUCTIONS.md"
    if ws_root_instr.exists():
        sanitize_md_file(ws_root_instr, stage_halo / "INSTRUCTIONS.md", ".halo/INSTRUCTIONS.md", manifest)
        manifest["included"]["instructions"].append(".halo/INSTRUCTIONS.md")
    else:
        global_instr = home_global / "INSTRUCTIONS.md"
        if global_instr.exists():
            sanitize_md_file(global_instr, stage_halo / "INSTRUCTIONS.md", ".halo/INSTRUCTIONS.md (from global)", manifest)
            manifest["included"]["instructions"].append(".halo/INSTRUCTIONS.md (global fallback)")

    for sub_instr in ws.rglob(".halo/INSTRUCTIONS.md"):
        if sub_instr == ws_root_instr:
            continue
        if "/.halo/tmp/" in str(sub_instr):
            continue
        rel = sub_instr.relative_to(ws)
        sanitize_md_file(sub_instr, stage_root / rel, str(rel), manifest)
        manifest["included"]["instructions"].append(str(rel))

    # --- INDEX.md + docs/* it explicitly links to
    ws_index = ws_halo / "INDEX.md"
    if ws_index.exists():
        sanitize_md_file(ws_index, stage_halo / "INDEX.md", ".halo/INDEX.md", manifest)
        manifest["included"]["index"] = ".halo/INDEX.md"
        for link in index_doc_links(ws_index):
            src = ws_halo / link
            if src.is_file():
                sanitize_md_file(src, stage_halo / link, f".halo/{link}", manifest)
                manifest["included"]["docs"].append(link)
            elif src.is_dir():
                for f in src.rglob("*.md"):
                    rel = f.relative_to(ws_halo)
                    sanitize_md_file(f, stage_halo / rel, f".halo/{rel}", manifest)
                    manifest["included"]["docs"].append(str(rel))

    # --- agents (workspace + un-disabled-and-not-overridden global)
    ws_agents_dir = ws_halo / "agents"
    global_agents_dir = home_global / "agents"
    ws_agent_ids = {d.name for d in ws_agents_dir.iterdir()
                    if ws_agents_dir.is_dir() and d.is_dir() and (d / "agent.yaml").exists()} \
        if ws_agents_dir.is_dir() else set()

    referenced_skills = set()

    def stage_agent(agent_dir: Path, scope: str):
        agent_yaml_src = agent_dir / "agent.yaml"
        config = load_yaml(agent_yaml_src)
        if config is None:
            return
        # Skip platform-internal agents (evolution, score, apply, etc.).
        # They're shipped force-overwritten by the receiver's own server on
        # startup, so bundling them is redundant — and shipping the workspace
        # copy can leak experimental edits the user made locally.
        if config.get("internal") is True:
            manifest["excluded"].setdefault("internal_agents", []).append(agent_dir.name)
            return
        target_dir = stage_halo / "agents" / agent_dir.name
        target_dir.mkdir(parents=True, exist_ok=True)
        # agent.yaml — sanitize and write
        yaml_findings = []
        modified = sanitize_yaml(config, agent_dir.name, f".halo/agents/{agent_dir.name}/agent.yaml", yaml_findings)
        if modified:
            (target_dir / "agent.yaml").write_text(
                yaml.safe_dump(config, sort_keys=False, allow_unicode=True),
                encoding="utf-8",
            )
            manifest["redactions"]["yaml_params"].extend(yaml_findings)
        else:
            shutil.copy2(agent_yaml_src, target_dir / "agent.yaml")
        # siblings (AGENT.md, etc.); skip USER.md
        for f in agent_dir.iterdir():
            if f.name in {"agent.yaml", "USER.md"}:
                if f.name == "USER.md" and f.exists():
                    manifest["excluded"]["user_md"].append(f".halo/agents/{agent_dir.name}/USER.md")
                continue
            if f.is_file():
                if f.suffix == ".md":
                    sanitize_md_file(f, target_dir / f.name, f".halo/agents/{agent_dir.name}/{f.name}", manifest)
                else:
                    shutil.copy2(f, target_dir / f.name)
            elif f.is_dir():
                shutil.copytree(f, target_dir / f.name, dirs_exist_ok=True)
        # collect skill refs
        for s in (config.get("skills") or []):
            if isinstance(s, str):
                referenced_skills.add(s)
        manifest["included"]["agents"].append({"id": agent_dir.name, "scope": scope})

    for aid in sorted(ws_agent_ids):
        stage_agent(ws_agents_dir / aid, "workspace")

    if global_agents_dir.is_dir():
        for d in sorted(global_agents_dir.iterdir()):
            if not d.is_dir() or not (d / "agent.yaml").exists():
                continue
            if d.name in ws_agent_ids:
                continue            # workspace overrides
            if d.name in disabled_agents:
                continue            # explicitly disabled in this workspace
            if d.name in BUILTIN_AGENT_IDS:
                continue            # receiver's server seeds these itself
            stage_agent(d, "global")

    # --- skills
    # Ship every workspace-scope skill (it's a per-workspace customization, so
    # it belongs in a self-contained share — even if no agent.yaml lists it,
    # e.g. slash-command-only skills). For skills an included agent references
    # but the workspace doesn't have, pull the global copy — except platform
    # built-ins, which the receiver's server seeds itself.
    ws_skills_dir = ws_halo / "skills"
    global_skills_dir = home_global / "skills"
    ws_skill_ids = {d.name for d in ws_skills_dir.iterdir()
                    if ws_skills_dir.is_dir() and d.is_dir() and (d / "SKILL.md").exists()} \
        if ws_skills_dir.is_dir() else set()

    def stage_skill(skill_dir: Path, scope: str):
        target_dir = stage_halo / "skills" / skill_dir.name
        target_dir.mkdir(parents=True, exist_ok=True)
        for f in skill_dir.iterdir():
            if f.is_file():
                if f.name == "SKILL.md":
                    text = f.read_text(encoding="utf-8")
                    fm_match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
                    if fm_match:
                        fm = yaml.safe_load(fm_match.group(1)) or {}
                        body = text[fm_match.end():]
                        yaml_findings = []
                        modified = sanitize_yaml(fm, skill_dir.name,
                                                 f".halo/skills/{skill_dir.name}/SKILL.md (frontmatter)",
                                                 yaml_findings)
                        body, auto, sus = sanitize_markdown(body, f".halo/skills/{skill_dir.name}/SKILL.md")
                        if modified:
                            new_fm = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True).rstrip()
                            text = f"---\n{new_fm}\n---\n{body}"
                            manifest["redactions"]["yaml_params"].extend(yaml_findings)
                        else:
                            text = f"{fm_match.group(0)}{body}"
                        manifest["redactions"]["markdown_auto"].extend(auto)
                        manifest["redactions"]["markdown_suspicious"].extend(sus)
                    else:
                        text, auto, sus = sanitize_markdown(text, f".halo/skills/{skill_dir.name}/SKILL.md")
                        manifest["redactions"]["markdown_auto"].extend(auto)
                        manifest["redactions"]["markdown_suspicious"].extend(sus)
                    (target_dir / "SKILL.md").write_text(text, encoding="utf-8")
                elif f.suffix == ".md":
                    sanitize_md_file(f, target_dir / f.name, f".halo/skills/{skill_dir.name}/{f.name}", manifest)
                else:
                    shutil.copy2(f, target_dir / f.name)
            elif f.is_dir():
                shutil.copytree(f, target_dir / f.name, dirs_exist_ok=True)
        manifest["included"]["skills"].append({"id": skill_dir.name, "scope": scope})

    # 1. all workspace-scope skills
    for sid in sorted(ws_skill_ids):
        stage_skill(ws_skills_dir / sid, "workspace")

    # 2. agent-referenced skills missing from the workspace → global fallback
    for sid in sorted(referenced_skills - ws_skill_ids):
        if sid in BUILTIN_SKILL_IDS:
            continue            # receiver's server seeds these itself
        if (global_skills_dir / sid / "SKILL.md").exists() and sid not in disabled_skills:
            stage_skill(global_skills_dir / sid, "global")
        else:
            manifest["excluded"]["missing_skills"].append(sid)

    # --- prompts (workspace per-scope, else global fallback for missing scopes)
    ws_prompts = ws_halo / "prompts"
    global_prompts = home_global / "prompts"
    # `bootstrap` is intentionally excluded — it only fires for first-run
    # users who don't have a USER.md yet, which a shared bundle never targets.
    # `builtin/` (PLATFORM_KNOWLEDGE.md, etc.) is server-owned and version-tied;
    # it lives outside `prompts/` and is never shared — receiver's own server
    # seeds it on startup.
    for scope in ["all", "root"]:
        ws_scope = ws_prompts / scope
        global_scope = global_prompts / scope
        if ws_scope.is_dir():
            shutil.copytree(ws_scope, stage_halo / "prompts" / scope, dirs_exist_ok=True)
            manifest["included"]["prompts"][scope] = "workspace"
        elif global_scope.is_dir():
            shutil.copytree(global_scope, stage_halo / "prompts" / scope, dirs_exist_ok=True)
            manifest["included"]["prompts"][scope] = "global-fallback"

    # --- excluded counts
    if (ws_halo / "memory").is_dir():
        manifest["excluded"]["memory_count"] = sum(1 for _ in (ws_halo / "memory").rglob("*") if _.is_file())
    if (ws / "assets").is_dir():
        manifest["excluded"]["assets_count"] = sum(1 for _ in (ws / "assets").rglob("*") if _.is_file())
    if (ws_halo / "USER.md").exists():
        manifest["excluded"]["user_md"].append(".halo/USER.md")

    # --- write manifest
    (stage_root / "share-manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8",
    )

    # --- README.md
    # Secret-redacted fields appear inline in agent.yaml / SKILL.md as
    # `{{<id>.params.<key>}}`. The receiver greps for those after unpacking;
    # no separate declaration file needed.
    readme = (
        "# Shared Halo Workspace\n\n"
        "This bundle contains a Halo workspace's `.halo/` configuration: agents, skills,\n"
        "prompts, and instructions. Drop it into any project to replicate the setup.\n\n"
        "## To use\n\n"
        "1. Unzip into your project root. This places `.halo/` at the project root.\n"
        "2. If any agent.yaml or SKILL.md contains `{{<id>.params.<key>}}` placeholders,\n"
        "   add the matching values to `~/.halo/secrets/settings.yaml`. Search the bundle\n"
        "   with `grep -rn '{{' .halo/` to find every placeholder.\n"
        "3. Open the workspace in Halo — agents and skills will be ready.\n\n"
        "## Inside\n\n"
        f"- {len(manifest['included']['agents'])} agent(s)\n"
        f"- {len(manifest['included']['skills'])} skill(s)\n"
        f"- Prompts: {', '.join(f'{k}={v}' for k, v in manifest['included']['prompts'].items() if v) or '(none)'}\n"
        f"- {len(manifest['included']['docs'])} doc(s) referenced from INDEX.md\n\n"
        "## Excluded (privacy / portability)\n\n"
        "- `USER.md` (personal profile, all scopes)\n"
        "- `memory/`, `assets/` (workspace-specific)\n"
        "- `sessions/`, `logs/`, `tmp/`, `*.db*`, `settings.yaml`\n\n"
        "## Auto-redactions\n\n"
        f"Markdown files were scanned. {len(manifest['redactions']['markdown_auto'])} unambiguous "
        f"leak(s) were auto-redacted to `[REDACTED:<type>]`. "
        f"{len(manifest['redactions']['markdown_suspicious'])} suspicious string(s) were flagged "
        "for the maintainer to review before sharing.\n"
    )
    (stage_root / "README.md").write_text(readme, encoding="utf-8")

    # --- summary to stdout (for the agent). Paths are relative to the
    # workspace so the agent's reply doesn't leak the host's absolute layout.
    print(json.dumps({
        "ok": True,
        "staged_at": str(stage_root.relative_to(ws)),
        "manifest": str((stage_root / "share-manifest.json").relative_to(ws)),
        "summary": {
            "agents": [a["id"] + f" ({a['scope']})" for a in manifest["included"]["agents"]],
            "skills": [s["id"] + f" ({s['scope']})" for s in manifest["included"]["skills"]],
            "instructions": manifest["included"]["instructions"],
            "docs_count": len(manifest["included"]["docs"]),
            "prompts": manifest["included"]["prompts"],
            "yaml_redactions": len(manifest["redactions"]["yaml_params"]),
            "markdown_auto_redactions": len(manifest["redactions"]["markdown_auto"]),
            "markdown_suspicious": len(manifest["redactions"]["markdown_suspicious"]),
            "excluded_user_md": len(manifest["excluded"]["user_md"]),
            "excluded_memory_files": manifest["excluded"]["memory_count"],
            "excluded_asset_files": manifest["excluded"]["assets_count"],
            "missing_skills": manifest["excluded"]["missing_skills"],
        },
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

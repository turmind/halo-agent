---
name: extension
description: Install / list / remove admin preview extensions (`~/.halo/global/extensions/<id>/`) — static viewers the admin editor loads for file types it has no built-in preview for (e.g. `.glb`). `/extension install <id|zip|url>` pulls the latest `<id>-v*` release from the configured hub (default turmind/halo-hub). Activate when the user wants to preview a file type the editor can't open, or asks to install / update / remove an extension.
command: /extension
requiresAccess: full
verbs:
  - { name: install, desc: "Install or upgrade an extension from the hub (by id), a local zip path, or a zip URL" }
  - { name: list,    desc: List installed extensions with version and status }
  - { name: remove,  desc: Remove an installed extension by id }
---

# extension

The requested action is **`$1`**; everything after it is the payload
(`$ARGUMENTS` minus the first token). With natural language ("install the glb
viewer"), infer both.

Preview extensions are static bundles the admin editor loads in a sandboxed
iframe to preview file types it has no built-in viewer for (e.g. `.glb`).
Installing = putting a validated directory under `~/.halo/global/extensions/<id>/`;
the server watches that directory and pushes the change to every open admin —
**no restart, no page reload**.

The helper is `templates/ext.sh` in this skill's directory — the workspace copy
wins if it exists, else the global one:

- `<workspace>/.halo/skills/extension/templates/ext.sh`
- `~/.halo/global/skills/extension/templates/ext.sh`

Pick EXT = the first that exists, then:

## install

When the payload names a source, run the install right away — no confirmation,
no explanation first. Ask only when no source was given.

`HALO_HUB_REPO='{{params.hub_repo}}' bash EXT install <source>` — keep
`{{params.hub_repo}}` exactly as-is (the system substitutes it at runtime), where
`<source>` is one of:
- an extension id (e.g. `glb`) → the newest `glb-v*` release zip from the hub
  (a GitHub / Gitea / Forgejo / GitLab repo), or the newest `glb-v<x.y.z>` tag
  when the hub is any other git URL / local repo;
- a local `.zip` path;
- an `https://…zip` URL.

The hub is set in Settings → Skills → extension → `hub_repo`; empty means
https://github.com/turmind/halo-hub.

The script unpacks to a temp dir, pre-checks `halo-extension.json` (id matches,
entry exists), then atomically replaces `~/.halo/global/extensions/<id>/`.
Reinstalling the same id upgrades (or downgrades) it. Relay the script's last
line to the user (`installed glb 1.0.0` / the error). Never edit files inside an
installed extension — reinstall instead.

On failure relay the script's hint. "release API failed" → rate-limited
(GitHub: 60 anonymous requests/hour), private, or a wrong `hub_repo`; setting
`GITHUB_TOKEN` / `GITLAB_TOKEN` / `GITEA_TOKEN` in the server environment helps.
"no release for <id>" → the id isn't on that hub. "needs a build step" → that
extension can't be installed from git tags; get its release zip. Either way the
user can download the zip by hand and run `install <path>`.

## list

`bash EXT list` → one line per extension: `<id>\t<version>\t<name>` or
`<id>\tERROR\t<reason>` for directories the server would reject. Relay as a
short `-` list; `(none)` when empty.

## remove

`bash EXT remove <id>` → deletes `~/.halo/global/extensions/<id>/`. Confirm with
the user first if they didn't name the id explicitly.

## Notes

- Extensions are global (all workspaces on this server). Say so if the user
  asks "install it for this project".
- Mention the configured hub (its `extensions/` directory) only when the user
  asks what extensions exist or an install fails; do not scrape it.
- The script only pre-checks the required fields; the server's scanner is the
  authority. A package it rejects shows up in `list` (and the admin) as
  `ERROR` with the reason.

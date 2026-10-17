---
name: extension
description: Install / list / remove admin preview extensions (`~/.halo/global/extensions/<id>/`) — static viewers the admin editor loads for file types it has no built-in preview for (e.g. `.glb`) — and update the model provider list (new models, changed provider endpoints) from the hub. `/extension install <id|zip|url>` installs the version the configured hub's `<id>/update.json` names (default hub turmind/halo-hub); `/extension models` pulls the latest `models-v*` provider configs. Activate when the user wants to preview a file type the editor can't open, asks to install / update / remove an extension, or asks to update the model list / get a newly released model ("更新模型列表").
command: /extension
requiresAccess: full
verbs:
  - { name: install, desc: "Install or upgrade an extension from the hub (by id), a local zip path, or a zip URL" }
  - { name: list,    desc: List installed extensions with version and status }
  - { name: remove,  desc: Remove an installed extension by id }
  - { name: models,  desc: "Update the model provider list from the hub (newest models-v* release)" }
---

# extension

The requested action is **`$1`**; everything after it is the payload
(`$ARGUMENTS` minus the first token). With natural language ("install the glb
viewer", "更新模型列表"), infer both.

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

`HALO_HUB_BASE='{{params.hub_base}}' HALO_HUB_REPO='{{params.hub_repo}}' bash EXT install <source>`
— keep `{{params.hub_base}}` and `{{params.hub_repo}}` exactly as-is (the system
substitutes them at runtime), where `<source>` is one of:
- an extension id (e.g. `glb`) → reads `<hub_base>/glb/update.json` and installs
  the zip it names (https only, checked against its sha256, id and version);
- a local `.zip` path;
- an `https://…zip` URL.

The hub is set in Settings → Skills → extension: `hub_base` (where the
`<id>/update.json` files live — a mirror goes here); empty means the GitHub raw
`extensions/` directory of `hub_repo`, and empty `hub_repo` means
https://github.com/turmind/halo-hub.

The script unpacks to a temp dir, pre-checks `halo-extension.json` (id matches,
entry exists), then atomically replaces `~/.halo/global/extensions/<id>/`.
Reinstalling the same id upgrades (or downgrades) it. Relay the script's last
line to the user (`installed glb 1.0.0` / the error). Never edit files inside an
installed extension — reinstall instead.

On failure relay the script's hint. "no update.json for <id>" → the id isn't on
that hub, or `hub_base` is wrong. "no hub_base set" → `hub_repo` isn't on GitHub,
so `hub_base` must be set. "sha256 mismatch" / "does not match update.json" →
the hub's package doesn't match its update.json; tell the user, don't retry.
Either way the user can download the zip by hand and run `install <path>`.

## list

`bash EXT list` → one line per extension: `<id>\t<version>\t<name>` or
`<id>\tERROR\t<reason>` for directories the server would reject. Relay as a
short `-` list; `(none)` when empty.

## remove

`bash EXT remove <id>` → deletes `~/.halo/global/extensions/<id>/`. Confirm with
the user first if they didn't name the id explicitly.

## models

Updates the model provider list (the providers / models / endpoints the agent
editor offers) from the hub's newest `models-v*` release. Also run it for
natural language like "更新模型列表" / "update the model list" / "is there a
newer model". Run it right away:

`HALO_HUB_REPO='{{params.hub_repo}}' bash EXT models update`

The script prints one line per provider (`install` / `up-to-date` / `skip` /
`refuse` + reason), then a summary as its last line. By exit code:
- `0` — done. Relay the summary line; name any `refuse`d provider and its reason
  (e.g. "needs a newer halo" → run `halo upgrade`). Takes effect immediately
  — no restart, no page reload. Existing agents keep their own model / endpoint
  (they live in each agent.yaml); only the choices offered change.
- `3` — nothing was written: a provider is new or its endpoints change. Show
  the user the indented endpoint lines verbatim and ask whether to apply them.
  Only after they agree, run the same command with `--yes` appended. Never add
  `--yes` on your own.
- anything else — relay the error. Model configs come only from an https
  GitHub / Gitea / Forgejo / GitLab hub with releases; a local / plain-git /
  http hub is refused. "release API failed" → rate-limited (GitHub: 60
  anonymous requests/hour), private, or a wrong `hub_repo`; setting
  `GITHUB_TOKEN` / `GITLAB_TOKEN` / `GITEA_TOKEN` in the server environment
  helps. "no release for models" → that hub publishes no model configs.

`bash EXT models list` shows each provider, which copy is in effect (`bundled`
= shipped with halo, `hub` = installed by this command) and its revision.

## Notes

- Extensions are global (all workspaces on this server). Say so if the user
  asks "install it for this project".
- Mention the configured hub (its `extensions/` directory) only when the user
  asks what extensions exist or an install fails; do not scrape it.
- The admin's Settings → Extensions checks for updates itself (same
  update.json files) and offers a one-click update; point the user there for
  "is there a newer version".
- The script only pre-checks the required fields; the server's scanner is the
  authority. A package it rejects shows up in `list` (and the admin) as
  `ERROR` with the reason.

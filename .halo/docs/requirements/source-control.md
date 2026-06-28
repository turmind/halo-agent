# Source Control — Requirements

A focused Git panel for **viewing changes, committing, pushing, and managing credentials** — not a full VSCode SCM clone. The guiding principle: this is *your workstation's* git view (what did I change, commit it, push it), not the *project's* full topology sandbox (that lives on GitHub/GitLab). Scope is deliberately trimmed to the "view + commit + credentials" core; branch operations, AI commit messages, clone, conflict resolution, stash and the DAG graph are explicitly out of this round.

Backed by `GET/POST/DELETE /api/git/*` (see [dev/api.md](../dev/api.md#source-control-git)). Core lives in `packages/core/src/workspace/git-manager.ts` (simple-git wrapper); routes in `packages/server/src/routes/git.ts`; panel UI in `packages/admin/src/features/source-control/`.

## Entry visibility (git-gated)

The Source Control **activity-bar entry itself is hidden in non-git workspaces** — a non-developer's notes folder shouldn't carry a panel that doesn't apply to it. Visibility is a three-state signal (`useIsRepo`) derived from the *same* `GET /api/git/status` call that already drives the Explorer decorations (no extra fetch):

- **`'unknown'`** (status not yet resolved) → **show**. Defaulting to visible means no first-paint flicker, and a clean repo (no changes) is never momentarily mis-hidden while its status is in flight.
- **`true`** (confirmed repo, including a clean one) → **show**.
- **`false`** (confirmed non-repo) → **hide**. If `localStorage` had restored the active tab to Source Control, the layout falls back to Explorer — guarded on the confirmed-`false` state so an in-flight check can't kick the user off the tab.

**Auto-surface on `git init`**: creating a repo (panel **Initialize** *or* a terminal `git init` / `git clone`) makes the entry appear on its own, no page refresh. The backend's `GitDirWatcher` runs in a degraded "watch the workspace root for `.git` appearing" mode while the folder is a non-repo; the moment `.git` shows up it fires a `file:changed`, the frontend re-queries status, the repo signal flips `true`, and the entry surfaces. See [Auto-refresh](#auto-refresh-no-polling) for the two-phase watcher.

## Panel states (three-gate onboarding)

Once the entry is shown, the panel resolves to one of these on open, driven by `GET /api/git/status`:

1. **Not a repo** (`{isRepo: false}`) — the folder has no git work-tree at its root (either no repo at all, or it only sits *inside* an ancestor's repo). Shows an **Initialize Repository** empty state. Never a 500/console error — a non-repo folder is a normal state.
2. **Repo, no remote** — `GET /api/git/remotes` is empty. Shows an **Add Remote** prompt to guide first publish.
3. **Repo with remote** — the full panel: CHANGES list, commit box, history graph.

### Ancestor-repo guard
A workspace placed *under* another repo (e.g. a dotfiles `$HOME`, or a monorepo subdirectory) must **not** show that ancestor's git state. `git` resolves `.git` by walking up the tree, so the backend guards with an explicit `isRepoRoot()` check — only the workspace root being a real work-tree root counts. Without this, a workspace would leak the enclosing repo's changes.

## Changes (working tree)

- CHANGES section lists every modified/added/deleted/untracked/renamed file, split into **Staged** and **Changes** groups (mirrors the porcelain X/Y status chars).
- Each row shows a VSCode-style status badge: **M** modified (blue), **A** added / **U** untracked (green), **D** deleted (red), **R** renamed / **C** copied (blue), **U→Conflict** unmerged (red).
- Stage / unstage individual files or all at once (`POST /api/git/stage` · `unstage`).
- Click a file → opens a **Monaco side-by-side diff** (`GET /api/git/diff`); original side is HEAD (or the rename's old path), modified side is the working/staged copy. Binary files show git's "Binary files differ" rather than crashing.
- **Single-file discard is intentionally omitted** — it's an "operation", not a "view". Use the command line (`git checkout`).

## Commit & sync

- Commit box: type a message, commit staged changes (`POST /api/git/commit`). Blank message is rejected.
- **Push** (`POST /api/git/push`): first push of an untracked branch sets upstream automatically (`-u origin <branch>`).
- **Push failure is surfaced as a friendly red banner**, never a raw leak. A missing-credentials push (`fatal: could not read Username for 'https://...'`) is detected and rephrased into a "configure credentials" guide rather than dumping git's stderr.
- Pull (`POST /api/git/pull`).

## Auto-refresh (no polling)

The panel, the history graph, and the Explorer git decorations all refresh on the WebSocket `file:changed` event (debounced ~400ms), never by polling.

- **Panel-driven writes**: every git mutation route (stage/unstage/commit/push/pull/init/remote) re-broadcasts `file:changed` (path `.git`) itself, because the workspace file watcher deliberately ignores `.git`. So after a commit the CHANGES list auto-clears with no manual refresh.
- **Command-line writes**: a lightweight, **non-recursive** watch on the `.git` directory's top-level `HEAD` / `index` files (separate from the recursive workspace watcher, which excludes `.git` to avoid being overwhelmed by object-store inodes) catches terminal `git commit` / `checkout` / `add` / `reset` and broadcasts the same `file:changed`. `.lock` churn is filtered; the operation's events are debounced into a single refresh. So a commit made in the integrated terminal updates the panel without a manual refresh.
- **Two-phase watcher**: `GitDirWatcher` adapts to whether the workspace is a repo yet. A real work-tree watches `.git` directly (the steady state above). A **non-git folder** instead watches the workspace *root* (still non-recursive) for one thing only — `.git` appearing — so a terminal `git init` / `git clone` is noticed and upgrades the watcher onto `.git`, firing once so the [entry auto-surfaces](#entry-visibility-git-gated). The root-watch handler compares the event filename before any disk IO (ordinary file churn costs one string compare), and a real repo never enters this degraded mode.

## Explorer git decorations

The file tree colors and badges files by git status (VSCode-style), driven by the same `/api/git/status` + `/api/git/ignored` data (see also [explorer.md](explorer.md)):

- Changed files get a status-colored name + letter badge; a folder bubbles up its subtree's status (a single color, or neutral gray when the subtree mixes kinds).
- **Ignored files/folders are dimmed.** `GET /api/git/ignored` collapses an ignored directory (e.g. `node_modules`) to one entry; the tree dims that node and everything under it (prefix match). Ignored paths run through `core.quotepath=false` so **non-ASCII paths (Chinese, emoji) dim correctly** — without it git octal-escapes them and the prefix match silently fails.
- A real change always wins over ignored (a force-added file that's both ignored and modified shows its change badge, not dimmed).
- A non-repo workspace (`isRepo:false`) carries no decorations — the tree stays clean.

## History graph

- Commit list from `GET /api/git/log`, newest first; each commit expands to its changed files (`GET /api/git/commit-files`), each file drills into the commit's own diff (`GET /api/git/diff?commit=`).
- **Ref badges, tiered coloring**: local branch (e.g. `main`) solid/highlighted; remote branch (`origin/main`) dimmed outline, no fill; tag amber; current `HEAD` blue.
- **Infinite scroll**: an IntersectionObserver sentinel at the bottom raises `limit` by a page (50) at a time (`log` is capped server-side at 2000). Stops automatically when fewer than `limit` commits come back (reached the root).

## Credentials & SSH

- Managed from a gear (titled **Git Credentials**) on the panel.
- **HTTPS credentials, multiple per setup**: `~/.git-credentials` is the **single source of truth** (one `https://user:token@host` line per host, file mode 0600). No separate encrypted mirror.
  - List shows configured `{host, username}` rows; **the token is never returned to the client / never re-displayed**.
  - Add a new credential without closing the modal (supports adding several in a row).
  - Delete is per-host with an **inline two-step confirm**; deleting actually removes the line from `~/.git-credentials` (idempotent).
- **SSH**: read-only visibility — lists private keys in `~/.ssh` (with an `encrypted` flag, never key contents) and ssh-agent reachability + loaded-key count.
- **Remote protocol switch**: rewrite `origin` between HTTPS and scp-style SSH (`GET/POST /api/git/remote/protocol`).

## Out of scope (this round)

Branch create / switch / merge, ahead/behind indicator, AI-generated commit messages, clone, merge-conflict resolution UI, stash, worktree, timeline, PR management, the **DAG rail graph** (branch fork/merge visualization), and single-file discard. The DAG graph + ahead/behind are deferred to the branch-operations round, where they have live branch actions to feed them — standalone they're decoration, not a viewing need.

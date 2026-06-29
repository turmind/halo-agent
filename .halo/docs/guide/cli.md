# CLI / TUI

Standalone terminal client for Halo. Runs the agent loop directly in the CLI process — no server required. Shares the same agent core, tools, session management, and command system as the admin panel and other channels.

## Installation

```bash
pnpm --filter @turmind/halo-cli build
```

The binary is at `packages/cli/bin/halo.js`. For global access, link it:

```bash
pnpm --filter @turmind/halo-cli link --global
```

### Publishing to npm (maintainers)

The published package is `@turmind/halo` — a self-contained esbuild bundle
(CLI + server + admin-out + templates), staged under `packages/cli/dist-pub/`
by `scripts/build-bundle.mjs`. The workspace `@turmind/halo-cli` can't be
published directly (it has `workspace:*` deps); the bundle flattens them.

```bash
# 1. bump packages/cli/package.json "version" (e.g. 0.1.2)
# 2. build the upstream artifacts the bundle consumes
pnpm --filter @turmind/halo-core build
pnpm --filter @turmind/halo-server build
cd packages/admin && npx next build --no-lint && node scripts/copy-monaco.mjs && cd ../..
# 3. stage the release bundle — HALO_RELEASE=1 stamps the bare version
#    (0.1.2), NOT the default <version>-<sha>: a `-<sha>` suffix is a semver
#    prerelease that `npm install` skips and never tags as `latest`.
HALO_RELEASE=1 node packages/cli/scripts/build-bundle.mjs
# 4. preview + publish
cd packages/cli/dist-pub
npm pack --dry-run        # inspect tarball contents
npm publish               # @turmind/halo@<version>, tag latest, public
```

npm versions are immutable — a published version can never be overwritten,
so bump first and verify with `npm pack --dry-run` before `npm publish`.
End users then install with `npm install -g @turmind/halo`.

## CLI Mode (non-interactive)

Run a one-shot prompt and exit:

```bash
halo "review this PR"
halo -w /path/to/workspace "analyze code"
echo "review the changes" | halo
cat prompt.txt | halo -w /path/to/review-ws
```

### Options

| Flag | Short | Default | Description |
|---|---|---|---|
| `--workspace` | `-w` | cwd | Workspace path |
| `--agent` | `-a` | `default` | Agent ID |
| `--session` | `-s` | auto | Resume session by ID |
| `--format` | `-f` | `text` | Output format: `text` or `json` |
| `--verbose` | `-v` | off | Show thinking, tool calls, usage on stderr |
| `--access` | | `full` | Access level: `full`, `workspace`, `readonly` |
| `--agents` | | | List available agents and exit |
| `--sessions` | | | List recent sessions and exit |
| `--lang` | | `en` | Language: `en` or `zh` |

### Output

- **text format**: Agent response is rendered as styled markdown (headings, bold, code blocks, tables) on stdout. Tool calls, thinking, usage go to stderr (visible with `-v`).

  Usage line mirrors the admin chat-panel badge format (timestamp / in / out / ctx / read / write / cache% / ttft / e2e / think / model). `ctx` is the rolled-up context size — `inputTokens + cacheRead + cacheWrite + outputTokens` — so it doesn't look misleading next to a large cache hit:

  ```
  [ 17:23:02  in 0.0K  out 0.1K  ctx 5.8K  read 5.3K  write 0.3K  cache 94%  e2e 3.3s  think medium  claude-sonnet-4-6 ]
  ```
- **json format**: Single JSON object on stdout after completion:

```json
{
  "text": "...",
  "sessionId": "cli_abc123",
  "toolCalls": [{ "name": "file_list", "durationMs": 1 }],
  "usage": { "inputTokens": 6, "outputTokens": 42, "cacheReadInputTokens": 10000, "modelId": "..." },
  "error": null
}
```

### Pipeline integration

```bash
# Code review in CI
halo -w /path/to/review-ws "review the diff" --format json | jq '.text'

# Pipe content in
git diff HEAD~1 | halo -w /path/to/review-ws "review this diff"

# Exit code: 0 = success, 1 = error, 130 = SIGINT
halo "check for issues" && echo "OK" || echo "FAILED"
```

## TUI Mode (interactive)

```bash
halo -i
halo -i -w /path/to/workspace
halo -i -s sid_abc123   # resume session
```

Multi-turn conversation. Supports all standard Halo slash commands:

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/session new` | Start a new session |
| `/session list` | List recent sessions |
| `/session switch <n>` | Switch to session by number |
| `/session stop` | Stop current agent task (ends the turn, no re-run) |
| `/session interrupt` | Interrupt the running turn now (aborts a command mid-run); any messages queued while busy then run as one follow-up turn |
| `/session compact` | Compact session context |
| `/session context` | Show context window + agent info |
| `/agent <verb>` | Manage agents: `list` / `switch <name\|index>` / `desc` / `delete` / `create` / `update` |
| `/skill <verb>` | Manage skills: `list` / `desc` / `disable` / `enable` / `delete` / `create` / `update` |
| `/workspace info` | Show current workspace |
| `/workspace switch <path>` | Switch workspace (full access only) |
| `/workspace setup` / `/workspace tidy` / `/workspace share` | Set up / tidy the `.halo/` knowledge files, or export a shareable bundle (workspace skill) |
| `/cron <verb>` | Manage scheduled agent runs: `create` / `list` / `update` / `enable` / `disable` / `delete` |
| `/acp <verb>` | Ask other agents over ACP (`kiro <q>` / `claude <q>`) and manage `ask-*` bindings (`add` / `list` / `remove`) |
| `/evo [hint]` | Queue a self-evolution run on this session (full access only) |
| `/quit` | Exit |

Bare `/<obj>` (or `/<obj> help`) lists the verbs you may run. Verbs gated above your access level are hidden.

### Keybindings

| Key | Action |
|---|---|
| `Esc` (while running) | Interrupt the current turn immediately — aborts a command mid-execution, then any messages typed while it was running are folded into one follow-up turn. Same as `/session interrupt`. |
| `Ctrl+C` | Graceful exit; press twice to force |
| `Ctrl+O` | Toggle the sub-agent navigator — lists every sub-agent spawned this session, each showing its agent name, task title (same as the session list), and status (`●` running green / `○` idle grey / `✕` stopped red, plus a `▢ archived` marker when the session is archived); `↑↓` to move, `Enter` to view that sub-agent's log, `Esc`/`q` to close. (Was `Shift+Tab`, but Windows terminals consume that as backtab.) The log viewer auto-refreshes while the viewed session is still running (a `● live` hint shows in the header) and follows the bottom as new output lands — unless you've scrolled up to read, in which case it stays put (`G` jumps back to the bottom and resumes following). |
| `↑` / `↓` | Walk input history (when no popup is open) |

On resume (`-s <id>`, or the default latest session), the TUI replays the session's prior conversation on screen so you see where you left off. `shell_exec` output is shown inline by default (other tools' output needs `-v`).

## File, Image, and Scope References

Attach files or images to your message with `@file` and `@image`, or pull a directory's instructions into the turn with `@scope`:

```
> summarize @file src/index.ts
> compare @file a.ts and @file b.ts
> describe @image screenshot.png
> review @file "path with spaces/readme.md"
> @scope packages/server refactor the session manager
```

- `@file path` — reads the file and inlines its content in the message as `<file>` block
- `@image path` — reads the image as base64 and sends it via the model's vision input
- `@file photo.png` — image extensions (`.png`, `.jpg`, `.gif`, `.webp`, `.bmp`) are auto-detected as images
- `@scope dir` — injects the directory-scoped `.halo/INSTRUCTIONS.md` along the path from the workspace root down to `dir` (root level excluded — it's already in the system prompt) into **this turn only**. Use it to bring a sub-directory's conventions into scope for one request. It does not change where tools run.
- Paths are relative to the workspace; absolute paths also work
- Quoted paths supported for filenames with spaces: `@file "my file.txt"`
- **Tab completion** in TUI mode: type `@file ` (or `@scope `, which lists directories only) then press Tab to browse

### Limits

- **Text files**: truncated at 100KB with a `[truncated]` marker
- **Images**: skipped if larger than 5MB
- If the current model does not support vision, a warning is shown and images are ignored

## Architecture

```
packages/cli/
  src/
    index.ts        — Entry: arg parsing, mode dispatch, SIGINT handling
    harness.ts      — Shared agent harness wrapping SessionManager
    cli.ts          — Non-interactive: stdin/args → agent → stdout → exit
    tui.ts          — Interactive: readline loop + event display + commands
    format-usage.ts — Usage-line formatter (mirrors admin UsageLine badge order)
    resolve-refs.ts — @file / @image reference resolution with size limits
    render-md.ts    — Terminal markdown rendering (marked + marked-terminal)
```

The CLI directly imports server agent-core modules (`SessionManager`, `dispatchCommand`, tools, config, DB) via `@turmind/halo-server/*` subpath exports. No HTTP/WS layer is involved.

Session prefix: `cli_`. Sessions are persisted to `<workspace>/.halo/sessions/` and visible in the admin panel.

### Initialization

The CLI replicates the server's init sequence:
1. `initLogger()` — redirect console to stderr + file logger
2. `ensureHaloHome()` — ensure `~/.halo/` structure
3. `initBwrapCheck()` — probe sandbox availability
4. `setSandboxHiddenPaths()` — configure sandbox paths
5. `new SessionManager(workspace)` — create agent session manager

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.2.1] - 2026-09-19

### Added

- Relay: `relay_interrupt(workspace, session_id, message)` — the hard twin of `relay_send`. `relay_send` to a busy target is a soft interrupt (the target finishes its current tool, then reads the message); `relay_interrupt` aborts the in-flight turn now — including a command mid-execution — and re-runs the target with the message, same shape as `interrupt_session`. Enqueue-before-abort, so the turn end never sees an empty queue and fires a spurious relay report. Idle target → plain send (`interrupted: false`); missing session → error, it never creates one.

- Relay: `relay_list(workspace?)` — the root sessions of a workspace (id / agent / title / status, newest 100), so a dispatcher can pick up an existing conversation instead of minting a new session id each time, or just see what a department is working on. `workspace` defaults to the caller's own, which makes it the `session_list` for roots outside your own tree.

### Fixed

- Admin: the agent-form tool picker only knew `createWorkspaceTools`, so a hand-written `relay_send` rendered as a red "not available on this server" chip (and a click deleted it from the agent). One `relay_send` chip is now listed, described as the whole relay set — the five tools are switched on by that single name, so listing them separately would suggest they can be picked apart.

## [1.2.0] - 2026-09-18

Two changes to how agents hear back from other sessions, both riding the same `runSession` finally seam that already carries sub-agent reports and goal rounds.

### Added

- Relay: a session in one workspace can dispatch work to a session in another workspace on the same server and have the result pushed back, no polling. `relay_send(workspace, session_id, message, agent_id?)` creates the target session if missing, stamps its row with the caller as `reply_to`, and sends (busy target → queued + soft interrupt, so follow-ups and corrections use the same tool); `relay_stop` cascades a stop on the target tree; `relay_read` returns the target's current status / output. When the target root goes idle with its subtree quiet — the same gate `tryReportToParent` and goal rounds use, so a nested dispatch tree reports exactly once, at the end — its wrap-up is appended + sent into the caller's session as a `[Relay report …]` message and `reply_to` is cleared: one dispatch, one report, and a user chatting directly in the department workspace never pings the caller. Opt-in (`tools: [relay_send]` in agent.yaml) and full-access sessions only; CLI / TUI never set the registry, so delivery there is a logged no-op. New `agent_sessions.reply_to` column (createDb ALTER + `schema.sql`).

### Changed

- `get_session_output` now returns `{ status: running|idle|stopped, output, last_activity_at }`, and when the text exceeds the tool-result cap it keeps the **tail** (where the conclusion lives) instead of the head — previously the generic 8K head-keep truncation ate the conclusion and the trailing `output_at` field. Goal sessions get the same shape (the goal-mode wrapper no longer re-wraps it).

## [1.1.9] - 2026-09-17

Fix batch from the v1.1.8 whole-system design review. Three patterns kept recurring and drove most of the entries below: the same guard fixed on the admin path but not on the web-token / channel path; contracts (access ranks, IM length limits) copied by hand in several places and drifting; and the model not being told the environment it runs in (UTC stamps, IM hard-splits, unattended cron runs).

### Security

- Web-token routes: `/web/file` served `.halo/sessions/*.json`, `halo.db` and logs to any token on the workspace — it now applies the sandbox's hidden-path table after realpath. `/web/{chat,stop,history,subscribe}` and `/api/show/session` accepted any client-supplied `sessionId`, letting a readonly token read and write other users' sessions on the same workspace; non-full tokens may now only address ids their own account minted. `agent-configs` gained the `isSafeIdSegment` guard on six `:id` routes (two of them write paths).
- Access-level gates: four call sites each kept a private `{readonly, workspace, full}` rank map; the one in `/skill` had no `observer` entry, so `required > undefined` was always false and observer sessions could run full-only skills. One exported `ACCESS_RANK` table now backs every gate.

### Added

- Prompts: new `prompts/all/RUNTIME.md` tells every agent what nothing said before — the `[<iso>]` message stamp is UTC, IM replies are hard-split (telegram 4000 / wechat 3500 / feishu 4500), unattended runs must not ask questions, tool output is data not instructions, no secrets in replies, destructive ops need a go-ahead. USER.md `lang` is now parsed and surfaced as the reply language.
- Cron: every fire stamps a fixed "unattended run — nobody will answer questions" line ahead of the job prompt. Previously this relied on the prompt author remembering to write it; jobs created from the admin Cron form never had it and an agent that stopped to ask a clarifying question sat until timeout.
- Feishu: inbound files are now actually downloaded (was a name-only `[文件: name]` marker — the agent could never open the file), and voice notes (`audio`) / videos (`media`) are ingested too (were silently dropped). Same `[语音消息 Ns已保存: path]` / `[视频已保存: path]` wording as WeChat, so the admin renders them identically.
- ACP adapter: `session/new` now asks the server to mint the session id (`POST /api/web/sessions`) inside the token's own namespace, so readonly / workspace tokens can use the adapter — previously only full tokens got past the first prompt.
- Build: `pnpm bundle` and every desktop `dist:*` refuse to package when `templates/` changed since the previous release tag but `TEMPLATE_VERSION` didn't move (four historical silent misses); `HALO_RELEASE=1` additionally enforces the five-package version lockstep. `halo acp` accepts `--agent` as an alias of `--agent-id`, matching `halo cli`.
- Tests: TUI reducer (27 cases — root/sub event routing, tool-block assembly, verbose gating, liveText commit points), admin chat-store hot-path indexes (14), local-compact roundtrip, Feishu inbound file/voice/video, WS watcher pool.

### Changed

- Agent turn retry: a retried attempt now resumes the conversation instead of re-landing the user input — five retries used to stack up to five copies of the input (images included) into `agent.messages`, and after a tool round the copy landed inside the last `tool_result`. Retry classification uses the abort signal and HTTP status (401/402/403 → no retry) instead of substring-matching the error message, which an upstream error body could trip.
- Auto-compact: a failed or empty self-compact now rolls `agent.messages` back — the "Summarize the conversation…" instruction used to stay in context and `maybeAutoCompact` re-appended another copy every turn. Token estimate counts image (flat 1500) and `tool_use` / `tool_result` blocks, so the post-compact context figure is no longer systematically low.
- Tools: `grep` / `glob` no longer skip `.halo` wholesale — the agent can reach its own memory / docs / INSTRUCTIONS from the workspace root (only `sessions/logs/evo/tmp/assets/canvas` directly under `.halo` are skipped). `activate_skill` results are exempt from the 8K result cap (acp / cron / self skills are 8–12K and lost their tail). `file_edit` single replace no longer expands `## [Unreleased]

## [1.1.8] - 2026-09-15` / `` # Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

 `` / `$1` in the replacement text.
- Prompts: the agent roster is a factual statement of the team for both root and sub agents; the hard-coded "Default to delegation…" pep-talk is gone (workspace INSTRUCTIONS was already arguing against it). Template facts fixed: cron skill's stale `manage-cron-jobs/` paths (11×), goal agent told to append to the hash-checked `GOAL_SPEC.md` (steering goes through `goal_decide`), halo skill now says a workspace INSTRUCTIONS.md *replaces* the global one.
- Settings: all `general.*` fields are `globalOnly` — the runtime only ever read the global value, the per-workspace override in the UI was cosmetic.
- WS: one `WorkspaceWatcher` + `GitDirWatcher` per workspace root shared across connections (was one native subscription per browser tab).
- Sessions: descendant collection is one range query on the `parent>child` id encoding (was a per-level select in five places); `/list` reads the mirrored `title` column instead of the whole session file.
- Models: DeepSeek registry entry `deepseek-v4-flash` → the rolling `deepseek-flash` alias DeepSeek now documents.
- Docs: `dev/tools.md` discloses that the Windows sandbox is enforcement-free (every access level is effectively full there); `design/` notes synced with the above.

### Fixed

- Slack / Feishu `/workspace switch` replied "✅ Switched" without persisting the new binding (Telegram / WeChat already did).
- Source Control: a workspace initialised from the panel committed its own session transcripts, sqlite db and logs on the first commit — the generated `.gitignore` gains a `# Halo runtime` block.
- Admin: fenced code blocks' language tag overlapped the first line; remaining hard-coded Chinese / English strings (cron form, screenshot-failure bubble, editor toolbar titles, settings hint) moved into the i18n dictionaries; six unreferenced `Ws*Msg` types and a leftover stack-trace debug log removed; the four version-bus modules share one `createVersionBus` factory.
- `/skill` command's module-level skill cache was shared across workspaces (interleaved awaits could serve one workspace's list to another); `routes/error.ts` (zero callers) removed.

## [1.1.8] - 2026-09-15

### Fixed

- Channels: WeChat cron dispatch now echoes the recipient's `context_token` from their most recent inbound message — the gateway intermittently rejected cron sends with `ret=-2 "prepare failed"` even under the 16 KB cap because the chat-reply path carried the token but cron dispatch sent bare `to_user_id + text`.

## [1.1.7] - 2026-09-13

### Added

- Agent: a durable run ledger (`~/.halo/global/runs.db`) nudges root sessions that were mid-run when the server restarted — previously `reconcileOrphansOnBoot` stamped their cut-off sub-agents stopped but never told the root, which then sat waiting forever and answered "waiting on reports" if asked. `runSession` now inserts/deletes its row on entry/exit, so whatever's left at boot is exactly the runs the prior process died in the middle of; a boot sweep appends and sends each affected root a restart notice telling it sub-agents are stopped but revivable via `query_session`. Transient Bedrock transport retries are now logged at warn instead of debug so a hung h2 stream (15 min per attempt) leaves a trace in the file log.
- Models: added GPT-6 Astra to the Bedrock Mantle template (context 1,050,000 / max output 128,000), served from a new us-west-2 endpoint preset alongside the existing us-east-2 default — the Mantle fleet is region-split (us-east-2 serves GPT-5.6 but 404s on Astra; us-west-2 serves Astra + Terra/Luna but 404s on Sol).

## [1.1.6] - 2026-09-12

### Added

- Agent: every user-role turn that reaches the model now carries its arrival time as a leading `[2026-09-12T15:17:44.153Z] ` stamp (ISO-8601 UTC, same format as the existing `[System @ …]` sibling-status line) — the model previously had no clock and could not tell a reply that came two days later from one that came instantly, or how long a sub-agent report took to land. Sub-agent reports read `[<iso>] (from: session X)`. Only the model-facing history changes; the admin chat still shows the user's raw text. Exchange deletion and the cold-path raw→display fallback strip the stamp before matching, so they keep working.

## [1.1.5] - 2026-09-10

### Fixed

- Channels: WeChat / Telegram / Slack / Feishu replies now carry only the agent's closing text of each turn — the interim "thinking aloud" it emits before tool calls is no longer forwarded to the chat. Under the hood the agent loop's `final` flag on text blocks is now propagated through `AgentSessionEvent`, so channel responders can gate on it.
- Cron → WeChat: reports longer than the ilink gateway's 16 KB per-message ceiling failed outright (`ret=-2 "prepare failed"`) — the stock-report job hit this whenever its run was long enough. Dispatch now splits at 3500 chars (same shared `splitText` the chat responders use) and sends chunks in order; a mid-chunk failure is recorded as `chunk i/n: <error>` so the run row shows how much landed. The `ret=-2` hint in the WeChat API wrapper no longer claims "user never messaged the bot" — the same code also means oversized payload.
- CLI: `halo cli` stdout is now the final answer of the last root turn (fallback: that turn's full text) instead of every streamed text block of the whole run — a multi-turn director session that absorbed a dozen sub-agent reports used to dump ~40 KB of interim wrap-ups into cron output. When stdout is not a TTY the text is written as raw markdown (no terminal styling); `-v` echoes root text to stderr as it streams.
- Channels: WeChat streaming replies are now sent in strict order over a serialized send chain (was fire-and-forget), matching Slack / Feishu; Telegram / Slack / Feishu responders share the one `splitText` chunker instead of three private copies.

## [1.1.4] - 2026-09-02

### Added

- Web search: merged the two web-search skills into one `web-search` skill with a fast/deep gear switch — fast (default, Nova grounding, ~3s) for routine lookups, `--deep` (GPT-5.6 via Bedrock Mantle, ~20-40s) for exhaustive multi-round research with per-claim citations. Auth is automatic in both gears, nothing to configure. The old `nova-web-search` skill is retired; existing installs auto-clean its stale global directory on upgrade.
- Models: added Claude Fable 5.1 to the Bedrock invoke model list.

### Fixed

- Admin: viewing a cron-driven session no longer clobbers messages the cron `halo cli` child appended afterward — WS detach-save now only writes back the session snapshot when it's actually dirty, instead of unconditionally overwriting on disconnect/switch.
- Server: transient Bedrock HTTP/2 hangs (`http2 request did not get a response`) now retry instead of failing the turn outright; sub-agent and goal-mode round reports for turns that end in an unrecoverable error are now prefixed `[SUB-AGENT ABORTED]` / `[WORKER ABORTED]` so the parent agent / goal judge doesn't mistake a partial trace for a finished result.

## [1.1.3] - 2026-09-01

### Added

- Cron: per-job configurable max run time (`timeout_sec`, 60–21600s, default 3600) — replaces the hard-coded one-hour cap for every job; settable via API, admin job form, and the cron skill's `--timeout-sec`.

## [1.1.2] - 2026-08-19

### Added

- Explorer file tree: VSCode-style keyboard navigation — Up/Down move selection, Right expands / steps in, Left collapses / jumps to parent, Enter opens (folders toggle), Home/End jump, Shift+Up/Down range-select, F2 inline rename.
- Editor: files over the 10MB read limit now show a friendly placeholder with the file size and a download action instead of a modal alert.

### Fixed

- Server: built-in agent.yaml files are now written atomically (tmp + rename) during template reseed — closes the read/write race that intermittently produced "Agent \"default\" is missing model config" on desktop relaunch; unreadable/torn agent.yaml now warns with the resolved path instead of failing silently.
- CLI: `halo upgrade` now smoke-tests the new install's native modules (better-sqlite3, node-pty) — npm 12's allowScripts policy can block install scripts while still exiting 0, leaving a broken binding that only crashed on next start; the upgrade passes `--allow-scripts` and fails loudly with fix commands instead.
- Admin: jumping workspaces via the Explorer path input no longer fires the browser's leave-site prompt.

## [1.1.1] - 2026-08-09

### Added

- HTTP responses now gzip-compressed (`hono/compress`) — multi-MB archive-segment JSON drops ~99.7%, static admin JS/CSS ~75%; SSE streaming and WS upgrades are unaffected.
- Sessions tab detail panel now loads archived history on scroll-to-top, mirroring the Chat panel's existing archive-segment walk (previously stopped dead at the compact point).

### Fixed

- Chat panel: windowed the message list to the last 30 turns instead of mounting every exchange as DOM — the main cause of "the longer the chat, the laggier"; scrolling up widens the window before falling through to the archive-segment fetch.
- Chat panel: streaming hot path is now O(1) per event (incremental indexes replace full-array rescans and nested toolUseId dedup scans) — the other half of the same lag; also drops `console.debug` from prod builds and fixes a reconcile bug that defeated row memoization on every refetch.
- Editor: Monaco models are now disposed when the last tab referencing a path closes — previously every file ever opened leaked a full-text-plus-tokenization model until page reload.
- Sessions sidebar: selecting an already-loaded session no longer re-fetches its transcript (double-click and tab-switch both produced duplicate fetches).
- Admin: git status/graph/decoration refreshes no longer fire on sqlite WAL churn (session metadata writes, cron, evolution) — machine state git decorations never display anyway.
- Server: idle session UI state is now evicted after 10 minutes instead of held in memory for the process lifetime — channel/cron-driven sessions no longer accumulate hundreds of MB of retained message logs over weeks.
- Archive-history toggle (Chat and Sessions panels): expands upward, anchored to the newest end, instead of dropping the reader on the oldest archived message; the toggle bar now sits below the expanded content with a correctly-oriented chevron.

## [1.1.0] - 2026-08-08

### Added

- Canvas can preview Parquet and SQLite (.db/.sqlite/.sqlite3) files — a paginated table (SQLite adds a table-selector sidebar with per-table row counts), parsed server-side so large files open instantly.
- CSV/TSV previews now page server-side instead of loading the whole file into the browser (delimiter auto-detected, including semicolon-separated files); XLSX/XLS previews page client-side too, so rows past 500 are reachable instead of being silently cut off.
- Session file archiving: once a session's active log passes 3MB it archives everything but the newest exchange into a gzipped segment, keeping the active file small; the admin loads archived history on scroll-up (segment-by-segment, cached client-side).
- Session-list metadata (title, exchange count, tokens) now served from sqlite columns instead of parsing every session file, cutting a 50-row page from ~1.6s to single-digit ms.

### Fixed

- 30+ findings from the audit-20260806 pass: path traversal in id params, settings prototype-pollution guard, cron shutdown timer leak, WS session-routing key collisions, git-panel ancestor-repo leakage, various cache/timer/listener leaks, and periphery hardening across cli/desktop/web-demo/halo-city.
- CLI TUI: Esc now consistently closes whatever surface is open (log viewer/navigator/completion popup) before reaching the running-turn interrupt handler; corrected display-width math for CJK/emoji/ANSI-escaped text; keybinding docs rewritten to match the implemented semantics.
- CI: TUI tests forced interactive ink so GitHub Actions renders real frames instead of silently passing against empty output.

## [1.0.3] - 2026-08-05

### Security

- workspace/readonly sessions could read `<workspace>/.halo/sessions/` transcripts (other users' full chat history on a shared workspace), `halo.db` (+WAL/SHM), `.halo/logs/` and `.halo/evo/` run dumps by naming absolute paths — both sandbox layers (bwrap masks and the no-bwrap `assertPathAllowed` fallback) now hide the workspace's own runtime state while keeping knowledge files (docs/memory/skills/tmp/assets) readable. Admin (full) sessions unaffected.

### Added

- Settings → Security: change the admin password from the panel (current + new twice, strength rules: ≥8 chars with letters and digits; same scrypt format and `config.yaml` writer as `halo setup`, effective immediately — no restart) and a logout button (the `/api/auth/logout` endpoint existed; the UI entry didn't). When `HALO_PASSWORD` env manages the password, the endpoint refuses instead of silently not applying.
- Session detail timestamps now include the date (`MM-DD HH:mm:ss`) — sessions routinely span days.
- Cron `MEDIA:` attachments dispatched per target — WeChat/Slack targets receive the actual file, Telegram/Feishu (no media support yet) receive the path as visible text instead of silently losing both; marker-only runs no longer send empty messages.
- Default agent templates (default / goal / deep-executor / evolution internals) moved to Claude Opus 5 — prompt caching and thinking effort unchanged; template v49 reseeds existing installs.
- New WS frame `listener:released` (S→C): the server reclaims a session's event listener from an abandoned connection (socket CLOSED, or >3 min of client silence while the browser's network process keeps answering protocol pings) and tells the tab to resubscribe on resume.

### Fixed

- WS listener leak: abandoned admin connections piled up session event listeners (4 on one session observed in prod), buffering events into dead sockets; reclaimed as above, and a chat sent after reclaim re-registers the listener instead of running the agent with no viewer attached.
- All four chat channels dropped messages that arrived during context compaction (the busy hint returned early — the message was never queued); hints are now advisory-only and delivery always proceeds. Hint/upload-failure copy i18n'd; WeChat error/system prefixes now ❌/ℹ️.
- Orphan "Compacting context…" notices with no outcome: compaction is now feasibility-gated before the notice, and an empty LLM summary or a thrown summarize call emits a close-out line (auto and manual `/compact`).
- Git panel leaking an ancestor repo's state into a workspace nested inside it: all six git read endpoints now share the `isRepoRoot()` guard (was: status only) and return `{isRepo:false}` with a well-shaped empty payload.
- Admin refresh storm: session-log writes (`.halo/sessions/`, `.halo/logs/`) no longer trigger git status/graph/decoration refreshes on every streamed event.
- Duplicate system/queued notifications rendering twice in admin chat — adjacent identical notifications collapse; repeats separated by real messages still render.
- `~/.halo/secrets/config.yaml` was read once at startup — runtime credential changes (the new change-password endpoint) needed a restart to take effect; now mtime-watched like `settings.yaml`.

## [1.0.2] - 2026-07-25

### Added

- Claude Opus 5 on Bedrock Invoke (adaptive effort low/medium/high/xhigh/max, 128K output, 1M context); GPT-5.6 xhigh/max reasoning-effort tiers (live-verified: max is honored, not downgraded); chat media-preview download button; session-delete confirmation in both the chat sidebar and the Sessions page (the latter warns about the sub-session cascade).

### Fixed

- Chat media preview showing stale images after a file is overwritten in place (per-open cache-buster); parallel tool calls rendering with cross-matched/swapped outputs in the live view (results now pair by toolUseId, first-pending fallback); duplicated tool rows and streamed text after a mid-turn WS reconnect (reattach replay is now tagged and replaces the client's in-flight turn instead of appending; thinking blocks now survive reconnect; reconnect resubscribe single-owner).

## [1.0.1] - 2026-07-20

### Added

- Admin chat panel: session list moved from a popup dropdown to a fixed, collapsible right sidebar (terminal-list style) — toggled by the History button or the empty-state link, open state persisted in `localStorage`; rows support inline rename (Enter/blur commits, Esc cancels).
- Admin chat panel: sub-agent report and compact-summary callouts now have hover Copy/Delete actions like regular user bubbles — Copy strips the marker line and copies the body only; deleted callouts grey out with a "deleted" badge.

### Changed

- Session switching shows real loading driven by the server's `state:snapshot` (replacing a 2s fake timer), with a per-row spinner and a slow-network notice + Retry after 30s (slow is not treated as failure).

## [1.0.0] - 2026-07-18

### Added

- Model providers: Kimi K3 (1M context, always-on thinking via top-level `reasoning_effort`, base64-only vision), MiniMax M3 (1M context, Anthropic-compatible, adaptive thinking, new default for the minimax provider), GPT-5.6 Sol/Terra/Luna on Bedrock Mantle (272K context; new default `gpt-5.6-sol`).
- Model registry: per-model `contextWindow` field across all 28 models / 11 providers; session context budget now resolves `agent.yaml`'s `context.maxTokens` > registry `contextWindow` > the global 200K default.

### Fixed

- Sessions permanently bricked after a provider 4xx on multimodal content (e.g. "Multimodal data is corrupted"): history images are degraded to text placeholders, state is persisted, and the turn retries once.
- Session abort reasons normalized to `AbortError` — Node 22 let a bare-string abort reason escape as an unhandled rejection, producing spurious "Unrecoverable: interrupt" errors.
- Non-vision image mime types are now filtered at input with a warning instead of reaching the provider.

### Removed

- GPT-5.5 and GPT-5.4 retired from the Mantle provider — the 5.6 family covers both, with Terra matching 5.5-level performance at half price.

## [0.2.6] - 2026-07-12

### Added

- Goal Mode: hand off the two roles a user unconsciously plays in long agent collaborations — the pusher ("continue") and the evaluator ("is it actually done?") — to a dedicated judge agent. `/goal create [description]` starts an intake conversation on the current session (which becomes the worker) and mints a peer judge session that dispatches work orders and re-dispatches until acceptance or a guardrail halts it; `/goal status` reports round/cap, elapsed time, no-progress counter, and delegated decisions; `/goal pause` hands control back to the user for manual takeover; `/goal resume` nudges the judge to re-read the spec and continue; `/goal clear` tears down the binding from any state. All five verbs require full access.
- Admin: a goal banner above the chat composer shows live status (intake / running round N/max / paused / halted / done), a `Worker →` button to jump to the worker session, and a 🎯 badge on sessions bound to an active goal. Terminal states (done/halted) are dismissible.

### Fixed

- Goal Mode: the intake kick, resume nudge, and restart-sweep nudge only fed the LLM context and skipped the UI transcript append, leaving the judge's first turn with an empty assistant bubble and no visible record of the user's initial goal description after a reload.
- Goal Mode: `/goal create` and `/goal resume` switch the chat panel to the judge session, but the admin never re-subscribed to the new session's event stream — its streaming replies kept flowing to the old session.
- Goal Mode: deleting the judge session or the worker session left the other side's binding dangling (stale 🎯 badge, banner still showing a goal with no counterpart); both delete paths now dissolve the binding before the row is removed.
- Admin: dismissing a goal banner no longer comes back after a page refresh.

### Changed

- Goal Mode: default round cap lowered from 50 to 10 — a goal that hasn't converged by round 10 is looping, not progressing.
- `shell_exec` default timeout raised from 120s to 600s for long-running commands (builds, test suites, deploys); the tool description now states the effective timeout live from config.

## [0.2.5] - 2026-07-08

### Added

- `GET /api/health` now reports `gitSha` (short sha, `-dirty` suffix on a modified tree) on source builds, so "which commit is deployed?" is one curl away; published bundles keep carrying the sha inside `version` and report `gitSha: null`.

### Fixed

- Workspace-scoped provider secrets (API keys configured per-workspace in Settings) never reached the model call — only the global secrets file was read on the model-call path; workspace overrides now take effect.
- `pnpm run dev` for admin was broken on a fresh clone — the dev script ran `next build && next start`, but `output: 'export'` makes `next start` refuse to serve; switched to `next dev` (Monaco now stages to `public/` via a `--dev` flag), and documented dev mode in `env.md`.
- Server workspace file watcher hardened for Windows: Explorer live-refresh was silently dead (parcel emits realpath-based events while the workspace root was a symlinked path), and switching workspaces could crash the server child (a native subscribe/unsubscribe race plus an MSVC std::regex overflow on long ignore-glob lists). Native ops are now serialized with an epoch guard, and win32 uses exact-match ignore segments instead of regex.
- Admin Explorer: a folder once observed empty was never refetched, so files added inside it later stayed invisible until a full tree refresh — now refetched on every collapsed→expanded transition.
- Desktop (Windows): an orphaned server child survived every quit path except the normal one, keeping `node.exe` locking the install directory and forcing an uninstall prompt on every reinstall — all quit paths now route through a synchronous `taskkill` cleanup, plus an installer pass and crash-reporter minidumps.
- Admin editor: switching between a rendered markdown preview and a text file blanked the pane for a few frames on every switch (forced remount); the editor now stays mounted and swaps Monaco models instead. Markdown outline entries could visually squash together in a short list.
- Builtin agents' `context.maxTokens`/`compressAt` reset to template defaults after a reseed (e.g. every desktop launch) — the merge now preserves the whole context block instead of just the model block.
- Admin Sessions sidebar: renaming a session title flickered the detail panel while typing, caused by a self-sustaining reload loop (bus-driven tree rebuild blurring the rename input, unchanged-value PATCH re-triggering the loop); reloads are now suspended during an open edit and no-op PATCHes are skipped.

## [0.2.4] - 2026-07-06

### Added

- Desktop: Cmd/Ctrl+W closes the active editor tab (same confirm-unsaved path as Alt+W); with no tab open it closes the window, preserving the platform-standard meaning. Browser behaviour unchanged.

### Fixed

- Markdown links now open in a new tab instead of navigating the current page away — admin chat and md preview (in-document `#anchors` still scroll in place), web demo, and AgentCore demo. In the desktop app, external links (including same-tab navigations) open in the system browser via `will-navigate` interception; `about:blank` is allowed again, un-breaking the docx/media Print popup.
- Admin editor: Alt+W close-tab shortcut never fired on macOS — Option+W types '∑' so the `e.key` check couldn't match; now matches on physical `e.code` KeyW.

## [0.2.3] - 2026-07-05

### Fixed

- Admin explorer: dragging a file over a collapsed folder no longer bursts it open in passing — spring-loaded expand after a ~600ms hover (VSCode/Finder behaviour), cancelled on drag-leave; dropping into a collapsed folder still expands it.

## [0.2.2] - 2026-07-05

### Added

- Amazon Bedrock AgentCore runtime mode (`HALO_RUNTIME_MODE=agentcore`): `/ping` + `/invocations` + streaming WS adapter, per-user EFS-backed workspaces, channels/cron/evolution disabled — plus a full demo package (Dockerfile, chat frontend, CDK stack, auth/presign Lambdas) under `packages/agentcore-demo/`.
- Halo City: gentle procedural background music — a quiet music-box pentatonic line, pure Web Audio with zero assets, 🎵/🔇 HUD toggle with localStorage persistence.
- Halo City: desk-slacking idle activities — citizens can play a falling-blocks mini-game on their own monitor or scroll their phone at their desk.
- Web demo rebuilt on the agentcore-demo visual foundation: markdown rendering with streaming typewriter, collapsible thinking/tool blocks, mobile-first layout, and a direct-connect mode (server URL + web token straight from the browser, no proxy).
- Vitest infrastructure for core, cli, and admin (previously only server had tests) — 106 new tests, 345 total across the four packages, CI now runs all four `test` scripts.
- `start_session` tool gains an optional `title` parameter — sub-sessions can have a meaningful sidebar title from creation instead of waiting for auto-generation.
- `halo setup` auto-bind: when a non-Bedrock provider has keys configured, setup offers to rebind built-in agents (default/executor/deep-executor) to that provider. Non-interactive: `HALO_DEFAULT_PROVIDER=<provider>`.

### Fixed

- Halo City: stable desk assignment — `/api/show/state` orders sessions by `updated_at`, which reshuffled desks every poll; citizens now keep one desk for their whole stay and return to it after breaks.
- Halo City: citizens roam within ±4 floors of their home floor instead of trekking the whole tower; deeply-nested sub-agents spawn on their session tree's root floor instead of the lobby; floor panel lists a citizen on their desk floor even while away on a break.
- Web demo: `GET /file` proxy route was missing auth middleware.
- `validatePath` sibling-directory escape: a bare `startsWith(projectRoot)` prefix check let a sibling like `/x/myapp-secret` pass `/x/myapp`'s guard; now matches on a path-segment boundary.
- `validatePath` now resolves symlinks (realpath) — a symlink pointing outside the workspace is rejected instead of silently followed. Windows-compatible (junctions handled).
- `/api/web/file` symlink traversal: the endpoint followed symlinks pointing outside the workspace; now rejects with 403 (dangling symlinks return 404).
- `verifyPassword` degenerate-digest fail-open: a stored hash with an empty/corrupt digest segment caused `timingSafeEqual(empty, empty)` → true, accepting any password. Now rejects if digest length ≠ 32 bytes.
- `/api/metrics` used `getOrCreate` instead of `peek`, causing disk writes and orphan reconciliation from a read-only endpoint. Aligned with `/api/show` (peek + readonly fallback).
- `~/.git-credentials` / `~/.netrc` / `~/.config/gh` added to sandbox hidden list — previously readable by workspace/readonly sessions despite containing plaintext tokens.
- `~/.halo/global/{evo.db,cron.db,internal-sessions/,logs/}` hidden from non-full sessions — prevents cross-workspace metadata leakage.
- `secret: true` skill params now participate in shell_exec output masking (previously only `<<ENV>>`-injected values were masked).
- Brute-force rate limiter now uses socket address by default; XFF only trusted when `server.trust_proxy: true`.
- `settings.yaml` written via admin UI now gets mode 0600 (previously inherited umask 0644); secrets dir gets 0700.
- `sandbox.hidden_dirs` / `hidden_files` / `writable_dirs` marked `globalOnly` in schema — workspace-level overrides are now rejected.
- Cron/evolution child processes no longer inherit `HALO_PASSWORD` / `HALO_JWT_SECRET` in their environment.
- `getCommitFiles` rename detection: `diff-tree` ran without `-M`, so renames surfaced as delete+add pairs instead of a rename.
- Slack bold rendered as italic (`transformProse` pass ordering); corrupt password hash caused a 500 on login instead of a false-negative.
- `path-suggest` doubled the `@file` marker when completing inside a quoted directory path.
- evo phase timeouts (`PHASE_TIMEOUT_SEC` / `DRY_RUN_TIMEOUT_SEC`) widened from 10min to 30min — slow providers were hitting the per-phase SIGTERM during legitimate multi-turn drafts.
- `evolution.level` / `triggers.pre_compact` setting descriptions still referenced the renamed `/note` command (now `/evo`).

### Changed

- Settings schema now declares `agent.max_retries` and `limits.auto_report_chars`, which the code already read but the schema never exposed.
- New setting: `server.trust_proxy` (boolean, default false, globalOnly) — enables XFF-based client IP for rate limiting behind a reverse proxy.
- README revamped for launch: orchestration-focused hero, "Why Halo" section with real screenshots, onboarding fixes (AWS no longer implied required, setup-key-binding callout, curl/SSE example).

## [0.2.1] - 2026-07-03

### Added

- Multi-theme support — dark, light, midnight, warm — synced server-side.
- TUI input overhaul: rewritten line editor, verbose mode, persistent history across sessions.
- Speaker-notes sidebar for the PPTX preview, with resilient loading.
- Claude Fable 5 model on the AWS Bedrock Invoke provider.
- `--header` flag on the ACP adapter to forward arbitrary headers for upstream auth.

### Fixed

- Interrupted tool calls are now synthesized into a proper `tool_result` and surfaced in the session UI, instead of being stripped or shown as orphaned.
- Sub-session events enriched with `fullText` and `toolName`.
- Workspace runtime lock prevents cross-server orphan reconciliation.
- Read-only workspace peek for `/api/show`.
- `glob`/`grep` no longer follow Windows junctions into infinite recursion.
- CLI bundling now builds workspace deps first so their `dist` can't go stale.
- `setup` honors `HALO_PASSWORD` at the startup gate, uses real env placeholders, exits non-zero on stdin EOF.
- Internal-agent evolution prompts aligned with fresh-session reality + `ABORT.md` protocol.

### Changed

- Halo City: viewport culling, offscreen skyline, memoized palettes — smooth on busy servers.
- Deterministic team roster ordering + tighter self-delegation guidance.
- Agent guidance and workspace-conventions prompt updates.

## [0.2.0] - 2026-07-01

### Added

- Desktop: agent status light, dynamic title, unfocused-finish notification; multi-window support (Cmd/Ctrl+N) sharing one server.
- Admin: finished-notification chime (decoupled from window focus), off-by-default toggle, extended to the web/browser.
- Admin/Explorer: recent-workspaces dropdown, "Reveal in File Manager" action.
- ACP: support an https upstream via `--scheme`.
- Claude Sonnet 5 model; executor default switched to it.

### Fixed

- `halo acp` no longer rejects its own subcommand or boots a redundant server.
- `better-sqlite3` ABI pinned to the bundled Node version on desktop, with a build guard.
- Collapsible chat content re-measures with a `ResizeObserver`; terminal bottom panel renders once and is portaled between slots.

## [0.1.9] - 2026-06-30

### Fixed

- Release bundling excludes local-only docs and hardens bundle filtering.

### Changed

- Packaging docs gain a version-lockstep gate in the build checklist.
- `/evo` command references and login password steps corrected in docs.

## [0.1.8] - 2026-06-29

### Fixed

- Monaco-less admin bundles (missing `copy-monaco.mjs` step) and the template reseed gate.

### Added

- Packaging docs: core-before-server build order requirement, `pnpm --filter ... build` for admin.

## [0.1.7] - 2026-06-29

### Added

- Source Control panel: git backend with credential/SSH management, multiple HTTPS credentials per host, tiered branch badges, infinite-scroll log, SSH key unlock via in-app dialog.
- Session tools scoped to the caller's own session tree (by-id lookups).

### Fixed

- Sandbox force-kills `setsid`-escaped workers so `shell_exec` can't hang forever.
- Delegation roster collapses shadowed agents and hides disabled/overridden agents from the Team picker.

### Changed

- Chat exchange rows memoized so streaming doesn't re-render the whole log.

## [0.1.6] - 2026-06-27

### Added

- Session titles surfaced in `session_list` output; sub-agent sessions can be renamed inline.
- Per-call model request timeout (default 30min, `HALO_MODEL_TIMEOUT` override).

### Fixed

- Self-compact instruction no longer leaks into the kept tail of a session.
- Halo City citizens stay on their home floor instead of drifting downward.

### Changed

- `list_agents` replaced by a team-scoped delegation roster.

## [0.1.5] - 2026-06-22

### Changed

- `session.output` split into full-text and auto-report-summary variants.

## [0.1.4] - 2026-06-21

### Added

- `/session info`, command aliases (`/w`, `/sn`, agent switch/list shortcuts), `/workspace` rename from `/ws`.
- Root prompt surfaces sibling sub-agent running status.
- Admin-only inline session title rename.

### Fixed

- Sub-session logs keyed by `agentId` instead of case-split directories.
- All model providers retry transient 5xx/timeouts.
- Channel-created sessions pick the highest-priority agent instead of a hardcoded default.

### Changed

- Interrupt handling hardened; merge-answer queueing; sibling status and report limits; `max_queue_size` default raised 3 → 256.

## [0.1.3] - 2026-06-17

Interim release; see [0.1.2] and [0.1.4] for the surrounding feature set.

## [0.1.2] - 2026-06-16

### Added

- Prometheus `/api/metrics` endpoint.
- `observer` access level (global read-only).
- `halo upgrade` to bump the npm install in place.
- ESLint baseline for server, extended to cli and admin, wired into CI.

### Fixed

- Model registry loads lazily, fixing a new-provider startup race.
- Repeated-tool-call warning fires once per pattern instead of on every repeat.
- `glob`/`grep` no longer follow symlinks into infinite recursion.
- `view_image` sniffs media type from bytes instead of file extension.
- Disabled agents blocked from delegation, query, and cron.

### Changed

- Live agent roster injected into root prompts, replacing the static `ORCHESTRATION.md`.

## [0.1.1] - 2026-06-13

### Added

- Halo City: isometric pixel-art runtime visualizer + `/api/show/state` (replacing halo-show).
- `self.voice()` — play synthesized speech, with the face riding its live amplitude.
- Object-style command routing (`/agent`, `/skill`, `/session`, `/ws`, `/acp`, `/cron`) with noun-verb verbs and per-verb access control.
- ACP: Claude Code and Kiro binding kinds, direct-ask verbs.
- Desktop: build version stamp (`<version>-<sha>`) injected into the packaged server.

### Fixed

- Cron blocks same-job re-fire while a previous run is in-flight.
- Sub-session log entries lazy-init to stop sub-events leaking into the root file.
- WS/terminal tolerates 2 missed pongs, re-logs in on auth expiry, resyncs bracketed paste.
- Sandbox probes `bwrap` with a real namespaced run instead of `--version`.

## [0.1.0] - 2026-06-07

Initial public release.

### Added

- Multi-agent workspace: primary agent + sub-agent delegation, `.halo/` as the persisted knowledge/skill/session store.
- Channels: Admin (WebSocket), Web (HTTP+SSE), Telegram, Slack, Feishu, WeChat, CLI/TUI, ACP adapter.
- Self-evolution (`/evo`): drafts prompt-file patches, sandbox dry-run, scoring, admin review/apply.
- Cron tasks: scheduled agent runs with channel fan-out.
- Bubblewrap sandbox with `full` / `workspace` / `readonly` access levels.
- "Express Self" particle face driven by runtime `<<<SHOW>>>` markers.

[Unreleased]: https://github.com/turmind/halo-agent/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/turmind/halo-agent/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/turmind/halo-agent/compare/v1.1.9...v1.2.0
[1.1.9]: https://github.com/turmind/halo-agent/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/turmind/halo-agent/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/turmind/halo-agent/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/turmind/halo-agent/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/turmind/halo-agent/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/turmind/halo-agent/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/turmind/halo-agent/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/turmind/halo-agent/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/turmind/halo-agent/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/turmind/halo-agent/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/turmind/halo-agent/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/turmind/halo-agent/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/turmind/halo-agent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/turmind/halo-agent/compare/v0.2.6...v1.0.0
[0.2.6]: https://github.com/turmind/halo-agent/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/turmind/halo-agent/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/turmind/halo-agent/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/turmind/halo-agent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/turmind/halo-agent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/turmind/halo-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/turmind/halo-agent/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/turmind/halo-agent/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/turmind/halo-agent/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/turmind/halo-agent/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/turmind/halo-agent/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/turmind/halo-agent/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/turmind/halo-agent/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/turmind/halo-agent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/turmind/halo-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/turmind/halo-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/turmind/halo-agent/releases/tag/v0.1.0

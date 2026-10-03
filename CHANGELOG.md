# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.5.5] - 2026-10-03

### Added

- Admin: the pin, finish-bell and connection-light buttons at the bottom of the activity bar are merged into one quick-toggles gear. A thin bar under the gear shows each item's state: network, finish notification, and in the desktop app also pin and keep-awake. The gear turns red when the connection is down. Click it to open a panel where you switch the items; the panel stays open while you switch.
- Desktop: a "Keep screen awake" toggle, per window. While it's on and the window isn't minimized or hidden, the screen won't sleep or lock. It starts off after a restart and in new windows.
- Skills: workspace share bundles the workspace's own `.halo/settings.yaml`, with secret values blanked.

### Changed

- Admin: a session tab's delete button is a trash icon shown on hover, on every row (was ✕, always visible on the active row).
- Settings: the unused `general.limits.ws_event_buffer` key is removed.

### Fixed

- Agents: a tool call with malformed or truncated JSON arguments gets an error result the model can retry on. Before, it failed the whole model call (Anthropic family) or ran the tool on `{}` (OpenAI family). A reply cut off at the output token limit gets an error for each of its tool calls before the turn stops.
- Agents: OpenAI-compatible and Kimi providers read cached prompt tokens from every key the API reports them under, so cache hits show up in usage.
- Telegram: a long reply split into several messages arrives in order. A cron report over 4000 characters is sent as several messages instead of failing. In groups, builtin commands check the sender against the whitelist, and `/cmd@thisbot` skill commands match.
- WeCom: after a restart the account re-attaches to the last active chat; replies go out as active pushes until the user's next message.
- WeChat: PATCHing an account changes only label / workspace / enabled / access level / language; other keys in the body no longer overwrite its config.
- Web channel: a failed media save or send no longer leaks the session listener, and a client that disconnects ends its stream at once (the turn keeps running).
- Admin: the agent form no longer saves an empty config over `agent.yaml` when the file fails to load or parse; it shows an error with a Retry button.
- Admin: the finish bell rings once after a run of queued turns, not after each one.
- Admin: channel pages show the Observer badge for observer accounts and WeChat's "path does not exist"; Slack and Telegram tokens are masked inputs. Missing translations on the agent page and the channel forms are filled in.
- Admin: Explorer sends one file stat per window focus (was two), and the Sessions page's background refresh fetches only the first page.
- Server: agent operations at workspace scope without a `projectId`, or with an unknown scope, are rejected with 400 instead of acting on the global agent — a DELETE could remove the last global agent. Workspace AGENT.md / INSTRUCTIONS.md routes without a `projectId` are rejected too.
- Settings: resetting a key (e.g. a sandbox setting) takes effect without a restart, and deleting a global-only key at workspace scope is rejected like setting it.
- Server: a failed bundled-doc copy at startup is logged instead of silently skipped.

## [1.5.4] - 2026-10-02

First stable release since 1.4.6. It includes everything in 1.5.0-alpha through 1.5.3-alpha, plus the changes below.

### Changed

- Admin: each session tab leads with one fixed-size status dot instead of a spinner and an unread dot. Pulsing amber means the tab's turn is running, blue means new output arrived while the tab was in the background, and green means idle. A session no tab has loaded yet, or one a reconnect released, shows green. A state change no longer shifts the row's width.
- Admin: the finish bell now rings when any loaded tab finishes a turn, not only the session on screen. The notification raised while the window is unfocused names the session that finished.

## [1.5.3-alpha] - 2026-10-02

### Added

- Admin: chat sessions are tabs. Switching sessions no longer wipes the one you were in: each session you open keeps its own content, scroll position and in-progress output, and background sessions keep streaming and show running / new-message badges. After a reload only the active session loads, and the others load when opened. "+ New Session" and `/session new` open a new draft tab.
- Admin: the session list and the terminal list are Chrome-style vertical tabs. The session list is the tab list. Both lists stay on screen, can be dragged wider, and collapse to a narrow rail. The History / New session buttons next to the input are gone. ✕ on a session deletes it, with its sub-sessions, after a confirm in the UI language. The session list has no 300-session cap any more.
- Admin: the Sessions page keeps the last 20 sessions you viewed in memory and shows them instantly when you switch back, then refreshes them in the background.

### Changed

- WS protocol: one connection now carries a set of subscriptions. `subscribe` adds a session to the set, and the new `unsubscribe` releases its listener while the agent keeps running. `session:clear` / `session:cleared` are removed. `session:switched` means "added to your set" and carries `fromSessionId`. `listener:released` is sent once per released session, and its `sessionId` is no longer nullable. Session-scoped frames carry `sessionId`. Session list REST responses include `status`. On reconnect the admin re-subscribes only the active tab.
- Admin: long user messages collapse to a header row (chevron, send time, first 20 characters), and clicking the row toggles the message. The sub-agent report toggles from its title row the same way. Expanded bodies are capped at 40% of the window height and scroll inside the bubble.
- Sessions: a root session's title comes from its first message. It used to be a creation label such as "Explorer chat". Sub-sessions are still titled from their brief.
- Agents: the default context window is 272K and auto-compact fires at 90% (was 80%). Bundled models with a larger native window are pinned to 272K.
- Prompts: the root `DELEGATION.md` keeps "do it yourself" for light work only. Technical unknowns stay with the worker, and a worker's report should carry the context it gathered so the next brief can reuse it.

### Fixed

- Agents: a long-running sub-agent's log grew without limit because only root sessions moved old messages into archive segments on compact. Sub-sessions now archive into their own file too, and the parent's log is untouched.
- Admin: deleting a session tree left sub-session files on disk.
- Admin: in debug mode, a blank strip appeared above the first message.
- CLI: after `/session switch`, image paste followed the old session's model. Non-interactive `halo cli` output now keeps system notices such as compaction, so cron receives them too.

## [1.5.2-alpha] - 2026-10-01

### Changed

- Prompts: the root `DELEGATION.md` adds two rules. If the cause, the files and the pattern to copy are already settled, do the fix yourself instead of delegating, because a complete brief would restate the whole fix. And state what the conversation has already established as facts in the brief instead of leaving open branches ("if you find X, pick the simplest"), which hand the worker an investigation. 1.5.1-alpha carries the rest of this round's changes; this release also ships the Windows installer, which 1.5.1-alpha does not have.

## [1.5.1-alpha] - 2026-10-01

### Changed

- Agents: the per-model-call timeout is now a 10-minute idle timeout (was 30 minutes), and every streaming provider re-arms it on any data the stream delivers — pings, tool-argument fragments, empty reasoning chunks, SSE comment frames — so a long but live stream is never cut off while a dead connection fails three times sooner.
- Agents: auto-compact has no overall time limit any more (the `general.compact.summarize_timeout_sec` setting is removed; only the model idle timeout bounds it) and can't be interrupted — Stop / Esc during it take effect once it finishes. When the LLM summary fails, Halo compacts locally right away instead of retrying and says so (`Auto-compacted N older messages (local fallback — LLM summary failed: …)`).
- Admin: on the user bubble and the sub-agent report callout, Show more / less is an expand / collapse arrow left of Copy (only when the body is clipped), the Copy / Delete icons are always visible, and the send time sits at the bubble's bottom-right.
- CLI: the TUI status bar shows the session's agent id instead of the model name; its first slot used to read a fixed `agent`. The model still shows in verbose mode's per-turn usage line, the Ctrl+O log viewer and `/session context`.

### Fixed

- Agents: a session whose auto-compact kept failing retried it on every model call, minutes each, and looked frozen with Stop and new messages ignored — the local fallback above ends that.
- Agents: stopping a manual `/compact` reported `Compaction failed` instead of `Compact cancelled`, and `POST /api/web/stop` / the channel `/stop` and `/interrupt` couldn't cancel a manual compact at all (they answered "not running").
- Agents: relay interim reports — a local user's reply in a root that still owed a relay report could be forwarded to the caller, and a target waiting on its own sub-agents lost the answer to a follow-up `relay_send`.
- Agents: an account error (401 / 402 / 403, bad key, no balance) in a relay / sub-agent / goal report now says to fix the model configuration instead of suggesting a re-dispatch that fails the same way.
- Admin: a message or notice that arrived while a reply was streaming was laid out differently live than after a reload; the live view now matches the saved log, and `<<<SHOW>>>` / `<<<CAPTURE>>>` markers fire for every reply of the round, not only the last.
- Admin: after an auto-compact fell back to the local compact, the compacting ring stayed on and new messages kept queueing.
- Admin: a sub-session's in-progress content is saved to its own log on the same rules as a root's, so its detail view no longer loses it on reload, and pending UI logs are flushed on shutdown.
- Editor: after a reload, a restored tab for a file only an extension previews (`.glb`) opened as text.
- Server / Desktop: a graceful shutdown releases the workspace `.halo/runtime.lock`; the desktop app's quit waits for the server process to exit (3 s cap), so a stuck server is killed instead of left holding the port.

## [1.5.0-alpha] - 2026-09-30

### Added

- Agents: replies now stream. Every model provider sends text and thinking to the admin, CLI and TUI as it is generated instead of all at once when the call finishes — Bedrock Claude, the Anthropic-Messages providers (`anthropic`, MiMo, MiniMax, Qwen), the OpenAI chat/completions providers (`openai`, DeepSeek, Kimi, Zhipu, Doubao, Hunyuan) and the Responses API providers (`aws-bedrock-mantle`, `aws-bedrock-openai`). Before, a long thinking turn showed a blank bubble for minutes, and on Bedrock the connection could be dropped with `http2 request did not get a response` after ~15 minutes of silence, before Halo's own timeout ever applied. The per-call model timeout (`timeout.modelRequest` / `HALO_MODEL_TIMEOUT`) is now an idle timeout: it restarts on every chunk, so a slow but alive stream is no longer mistaken for a hang, while a stalled one still fails and retries. Each call also records its time to first token, shown in the admin debug badge and the CLI usage line. Errors that arrive mid-stream (throttling, 5xx, `ModelStreamErrorException`) take the normal backoff-and-retry path, which needed `@aws-sdk/client-bedrock-runtime` bumped to `^3.1142` — on the older SDK they were classified as fatal and ended the turn on the first attempt. A failure after some text has already been shown re-streams into the same message on retry.
- Observability: time to first token is exported for every streamed model call — as a `halo.ttft_ms` attribute on the `chat` span and as the semantic-convention `gen_ai.server.time_to_first_token` histogram (seconds, 1 ms…10 s buckets). Calls that were not streamed record nothing, so the histogram counts streamed calls only.
- Editor: canvas preview extensions — installable viewers for file types the editor has no built-in preview for; the first one is `.glb` 3D models (published in [halo-hub](https://github.com/turmind/halo-hub)). An extension is a static HTML bundle in `~/.halo/global/extensions/<id>/` with a `halo-extension.json` manifest, and the directory *is* the install: the server watches it and pushes the list to every open admin, so installing, upgrading or removing takes effect immediately with no restart or reload. Install from Settings → Extensions (zip upload, remove, invalid directories listed in red), with the new full-access `/extension install <id|zip|url>` skill (`list` / `remove` too), or by copying a directory in. Files with more than one viewer get an **Open with** menu in the preview header (extensions marked `default` win over the built-in preview, `option` ones are offered alongside it). An extension that declares the `save` capability can edit the file: the tab shows a dirty marker and a Save button (Ctrl+S too), and a save that finds the file changed on disk asks whether to overwrite instead of clobbering it (new `PUT /api/files/raw` endpoint). Extensions run in a sandboxed iframe with `allow-scripts allow-same-origin`, the same grant as HTML preview — required so a cookie-authenticated reverse proxy in front of Halo sees its cookie on module-script and `fetch` requests (with an opaque origin the proxy bounced them to its login page and the viewer timed out with "extension unresponsive"). The trade-off is that an extension can reach the page around it, so install only extensions you trust, as with skills. Template v69.
- Models: Claude Sonnet 5.5 (`global.anthropic.claude-sonnet-5-5`) on the Bedrock Invoke provider — 1M context, adaptive thinking with effort low / medium / high / xhigh / max, image input; Sonnet 5 stays listed. The bundled `executor` agent moves to it (effort and 200K working context unchanged) on fresh installs; an install that already set its own `model:` keeps it; template v68.
- Models: GPT-6.1 Sol on both Bedrock OpenAI-compatible providers — `global.openai.gpt-6.1-sol` on `aws-bedrock-openai` (answers from all four regions) and `openai.gpt-6.1-sol` on `aws-bedrock-mantle` (us-east-1 only; the other regions 404). Reasoning effort low / medium / high / xhigh / max (unlike GPT-6 Sol there is no "none" — the API rejects it), image input, 1,050,000 context, 128,000 output; template v73.
- Prompts: root agents get a bundled `DELEGATION.md` — when a task fits a sub-session and when to do it yourself, three checks before `start_session`, and a brief checklist (goal and done criteria, decisions already made in the conversation, known facts, boundaries, verification commands, one task per session). Before, this guidance lived only in the default agent's own prompt, so custom root agents in other workspaces got neither the criteria nor the checklist; it is not gated on having a team. The `start_session` `message` description carries the same checklist, so the model sees it at the call site, and the default agent's now-duplicate "Briefing sub-agents" section is dropped. Workspace-specific routing (agent names, size thresholds) stays in each workspace's `INSTRUCTIONS.md`; this repo's own copy now states its delegation rules as plain runtime facts (interruptions only land between tool calls, workers run in parallel and report back, a worker knows only its brief) with a who-does-what table, and defaults to delegating the doing so the orchestrator stays reachable. Template v71.
- Admin: the user message bubble shows its send time (`HH:mm` in the browser's timezone, full date on hover) next to the Copy / Delete actions, on the Chat page and in the Sessions tab. The Chat page also gets the Debug toggle (bug icon) the Sessions tab already had — usage lines with token counts, latency and model, agent start / done markers and thinking blocks; it is remembered separately from the Sessions tab's setting.

### Changed

- Agents: relay and sub-agent interim reports are now sent at the end of the turn that answered the follow-up, not at the moment `continue_task` is called. The old trigger lost the answer in three cases: a second message was already queued when the turn ended, the model wrote its answer and then called `continue_task` in the same response (only the trailing line was forwarded), and a follow-up that arrived during the opening turn. The forwarded text is now the turn's complete answer, and the `continue_task` tool description asks the model to write its reply before calling it. Relay report headers gained a status field — `· status: completed` or `· status: aborted` on the final report, `· status: still running` on interim ones — and an interim report no longer claims the task was "interrupted"; the `[Relay report` / `[Relay interim report` prefixes are unchanged. Pressing Esc after `continue_task` still sends no interim; the final report covers that turn.
- Agents: the opt-in `draft` self-review tool is removed. Every use cost an extra model round (draft → checklist → revise) and the revised answer was rarely better than the first pass plus thinking. Existing `agent.yaml` files that list `- draft` keep working — the unknown name is ignored — but the admin agent form shows the chip as missing; the bundled default and deep-executor agents no longer list it; template v70.
- Channels: an account with full access can send `MEDIA:` attachments from any path — its shell and file tools are already unrestricted, so the workspace-plus-temp-dir rule protected nothing and only forced the agent to copy the file into `/tmp` first. Other access levels (and cron pushes) keep the rule. A blocked path is no longer dropped silently: WeChat shows a `⚠️ WeChat delivery failed` notice in the session, and Slack / Feishu / WeCom / Telegram reply with the usual upload-failed message (Telegram had no failure path at all before). The `send-file` skill describes the per-level rule; template v72.
- Goal mode: its entry points — the `/goal` command, the admin goal banner / 🎯 badge / composer lock, and creation of new goal sessions — are now hidden and disabled by default behind an internal, global-only setting (`general.goal_mode_enabled`, off unless set in `~/.halo/secrets/settings.yaml`; takes effect after a server restart). The runtime mechanism and all existing goal history and data are left untouched, and the current docs no longer describe it.

### Fixed

- Agents: pressing Esc / Stop while a reply was still streaming left the model with no memory of it — the admin showed the partial text, but the conversation history did not contain it, so the next turn the model said it had not written anything. The text already shown is now kept in history with an `[reply interrupted …]` marker.
- Agents: the CLI / TUI relay error is worded as permanent — relay only runs inside `halo server`, do not retry — and points to the admin UI, an IM / Web channel, or `halo tui -w <workspace path>`. The old "unavailable in this runtime" read like a transient outage, so agents retried the call and told users it was a temporary failure.
- Admin: with sub-agents running, a sub-session's usage row could cut the turn in two and leave its tool calls attached to the next model call's text, in a message no usage row matched; each sub-session usage row now stays in its own assistant message. After switching sessions, frames from the previous session's still-running turn kept arriving and landed in the newly opened one; chat frames now carry their session id and the admin drops those that belong to another session.
- Admin: the sibling-status line appended to a root's merged turn showed raw ISO timestamps (`[System @ 2026-09-29T15:51:02.063Z] … (created …, last active …)`); it now reads `[System]` with relative ages (`42s`, `17m`, `1h05m`). The model still receives the full timestamps.
- Channels: a WeChat reply that failed to send was invisible — the session log showed a normal turn while the message never reached the user. Send failures now add a `⚠️ WeChat delivery failed` notice to the session, and the gateway's `ret=-2 "prepare failed"` names all three known causes (payload over 16 KB, no `context_token`, expired `context_token`) with the age of the token that was echoed, e.g. `context_token age 79m`. The token expires server-side with no fixed lifetime and only the user's own message renews it, so nothing Halo can do fixes an expired one — the user has to write to the bot again. Sending behaviour is unchanged.
- Server: opening a large workspace no longer stalls the file watcher — subscribing took ~13 s on this repo (about 26k files) because every path was tested against 52 separate ignore patterns, during which the admin got no live file changes and the next workspace switch logged `unsubscribe still pending`. The patterns are now one, and the same subscribe takes under a second.

## [1.4.6] - 2026-09-28

### Added

- Models: Zhipu AI (GLM) provider `zhipu` — OpenAI-compatible chat completions on `open.bigmodel.cn`, key from `ZHIPU_API_KEY`. Ships `glm-5.3` (default), `glm-5.3-flash`, `glm-5.3-flashx` and `glm-5.2`; all 1M context / 128K output. Image input (attachments and `view_image`) is on for the two Flash models only — `glm-5.3` and `glm-5.2` are text-only and reject image parts, which is now recognised as a multimodal rejection so a session switched onto them from a vision model drops its old images and carries on instead of failing every turn. The glm-5.3 family always thinks (effort low / high / max); glm-5.2 can switch it off. Output is capped with `max_tokens`, since Zhipu silently ignores `max_completion_tokens`.

## [1.4.5] - 2026-09-28

### Fixed

- Agents: a busy relay target or sub-agent that answered a follow-up in a drained turn, then called `continue_task` to resume, dropped that answer from the eventual relay/report — every turn resets its output, and the end-of-run report only reads the last turn. The follow-up answer is now snapshotted and forwarded as an interim report the moment the resume kicks off: a relay root sends a `[Relay interim report · …]` message (the final report still fires exactly once), a sub-agent tells its parent via `querySession` without marking itself done. Local chat, other-session messages, errored/empty answers and goal workers are unaffected.

## [1.4.4] - 2026-09-27

### Fixed

- Agents: a session that had loaded many images with `view_image` could stop working with Bedrock's `Input is too long.` while far under the token limit — every request re-sends the whole history, images included, and past ~32 MB of request body Bedrock rejects it with the same message as a token overflow (the reported session: 31 PNG renders of 896×896, ~34 MB at 113K tokens). Auto-compact only counts tokens, so it never fired, and the message wasn't recognised, so the turn ended on the first failure. Now: (1) before every model call, once the history's images exceed 20 MB of base64 or 100 images, the oldest are replaced with a placeholder (`view_image it again if still needed`) until both are under half, and a system notice says how many were removed; (2) `Input is too long` is treated as a context overflow, so the turn compacts and retries instead of failing; (3) `view_image` sends an opaque PNG over 256 KB as JPEG when that is smaller, as the admin already does for every attached image — a typical 896×896 render goes from ~850 KB to under 100 KB. Transparent PNGs, small PNGs and other formats are sent as before, and the file on disk is never changed.

## [1.4.3] - 2026-09-27

### Fixed

- Agents: on the OpenAI-format runtimes, an image returned by `view_image` never reached the model — the tool result was flattened to the text `[image]`, so the model answered from the file name and whatever else was in context. Affected: GPT / Grok / Kimi K3 on Bedrock (`aws-bedrock-mantle` / `aws-bedrock-openai`, Responses API), Kimi (`kimi-k3`), DeepSeek (`deepseek-flash`) and the generic `openai` provider. The Responses API now gets `input_image` parts inside `function_call_output`; the Chat Completions runtimes, whose `tool` messages are text-only, send the images in a user message right after the tool messages. On the generic `openai` provider, images the user attached were dropped as well — user content was sent as text only; it now carries `image_url` parts. Claude, Qwen, MiniMax and MiMo already passed images through; Doubao and Hunyuan register no image-capable models, so they are not offered `view_image`.

## [1.4.2] - 2026-09-26

### Fixed

- Channels: after a server restart, WeChat / Telegram / Slack / Feishu replies from a session that resumed on its own (the run-ledger restart nudge, a queued turn, a message typed in the admin) were dropped until the user wrote to the bot again — the reply route only existed in memory and was only created by an inbound message. Each account now re-wires, at start, the latest existing session of every conversation it can address from the account row: WeChat users with a stored `context_token`; the `lastActiveChatId` conversation on Telegram (private chats only — a group chat id doesn't say whose session it was), Slack (DM or channel thread) and Feishu (p2p only — a group-thread reply needs the inbound message id, which isn't persisted). Other conversations re-wire on their next inbound message as before. No session is created, and a workspace whose runtime another live server owns is skipped. Failed WeChat / Telegram / Slack reply sends now log at `warn` instead of `info`, so they show up at the default log level.
- Channels: WeChat cron attachments now echo the recipient's `context_token` like the cron text does — an attachment send is also a `sendmessage`, and without the token the gateway intermittently rejected it with `ret=-2 "prepare failed"`.

## [1.4.1] - 2026-09-26

### Added

- Docs: new bundled guide `guide/delegation-and-access.md` — scope override, when config edits take effect, team / roster / `start_session` checks and errors, nesting depth, access levels and where each entry point's level comes from, relay. The halo skill points to it; template v66.

### Fixed

- Docs: `dev/tools.md` said the Web channel defaults to full access (every channel account defaults to readonly) and that hand-edited sandbox `hidden_*` / `writable_dirs` lists apply immediately (only a save through the settings API re-applies them; a hand edit of `settings.yaml` waits for the next restart).

## [1.4.0] - 2026-09-25

### Added

- Cron: a job can run inside an existing root session instead of its own `cron-<jobId>` — pick one in the admin Cron form (recent root sessions, or type an id), send `sessionId` on `POST`/`PUT /api/cron/jobs`, or pass `--session` to the cron skill. The session keeps its own agent and access level; a fire is skipped (recorded as `skipped`) while a turn is running in that session or another job's run is on it, and a message sent into the session while its run is in flight can lose one of the two turns (logged as a warning, not prevented). `cron.db` gains a nullable `session_id` column (migration v2); template v65.
- Sandbox: `workspace` / `readonly` sessions now work on macOS. `shell_exec` runs under `/usr/bin/sandbox-exec` with a profile of the same shape as the Linux bwrap mounts. Before this, those levels lost `shell_exec` on a Mac. `/api/health` reports the backend as `sandbox: "bwrap" | "seatbelt" | null`.
- Chat: an access-level selector (Full / Workspace / Readonly) sits leftmost in the message input toolbar. It applies from the next message and is locked to Full when the host has no sandbox (Windows).
- Sandbox: `rm` / `rmdir` aimed at `/`, `$HOME`, `~/.halo`, the workspace root, one of their parents or a system directory is refused at every access level, Full included (not on Windows). It is a guard against typos, not a shell parser.

### Changed

- Models: the MiMo provider shows as "Xiaomi MiMo" (id `mimo-token-plan-china` unchanged, existing configs keep working) and its endpoint presets now cover the Token Plan Singapore / Europe clusters plus the pay-as-you-go `https://api.xiaomimimo.com/anthropic` — `sk-` keys only work there, `tp-`/`ttp-` keys only on the `token-plan-*` hosts; template v63.

- Default agent templates (default / goal / deep-executor / evolution internals) moved to Claude Opus 5.5 — prompt caching and thinking effort unchanged; template v61 reseeds existing installs, but an install that already set its own `model:` keeps it. The agent skill's model guidance and the new-skill model-override dropdown follow (the dropdown's old Opus entry, `claude-opus-4-6`, wasn't a registry id at all).
- Build: `build-bundle.mjs` writes to `packages/cli/dist-pub/` only with `HALO_RELEASE=1`; every other run — including the desktop `dist:*` stage — writes a sha-suffixed bundle to `packages/cli/dist-dev/`. A desktop build used to overwrite the npm release bundle in place, and a second `npm publish` from it put the stray `1.3.4-<sha>` prerelease on npm.

### Fixed

- Sandbox: `git commit` works in a `workspace` session. Hidden files such as `~/.gitconfig` used to be covered with `/dev/null`, which reads as a permission error inside bwrap and makes git abort; they now read as empty, and the host git name/email are passed in. File tools outside bwrap follow the same rules as the OS sandbox: read anywhere except the hidden paths, write only to the workspace and `writable_dirs`. A write refused by the sandbox adds a `[Sandbox]` hint to the result, telling the agent to ask the user to switch to Full instead of retrying.
- Channels: a `MEDIA:` attachment outside the workspace and the temp dir is now logged at warn, so the block shows up in `server.log`. It used to be dropped at info level with no visible trace. The send-file skill states the rule and says to copy the file in first; template v64.
- Cron form: typing a workspace path no longer creates `.halo/` (plus a `halo.db`) in each real directory passed on the way, e.g. `/home/<user>`. The agent / session lists now load when the field loses focus or on Enter, not on every keystroke, and `GET /api/sessions/logs` / `GET /api/agent-configs` return an empty or global-only list for a path without `.halo/` instead of scaffolding it (or failing with a 500 on a partial path).

## [1.3.4] - 2026-09-24

### Added

- Models: new `aws-bedrock-openai` provider — the `bedrock-runtime` host's OpenAI Responses API (`https://bedrock-runtime.<region>.amazonaws.com/openai/v1`, AWS's recommended endpoint for new apps; Mantle stays for server-side `web_search`). Reuses `MantleAgent`; cross-Region `global.*` profile ids only, no region split (all models answer from us-east-1 / us-west-2 / eu-west-1 / ap-northeast-1). Ships GPT-6 Astra / Sol / Luna, GPT-5.6 Sol / Terra / Luna, xAI Grok 4.6 (500K context, effort low/medium/high/xhigh) and Moonshot Kimi K3 (1M context).
- Models: Claude Opus 5.5 (`global.anthropic.claude-opus-5-5`) on the Bedrock Invoke provider; GPT-6 Sol / Luna on the Mantle provider (default endpoint moves to us-east-1, default model `openai.gpt-6-sol`); MiMo 2.6 Pro / Flash (both vision, 1M context) on the MiMo provider, v2.5 kept until its 2026-10-21 deprecation.
- Agents: `continue_task` — a built-in no-parameter tool every agent gets; calling it after an interrupt makes the session resume its own turn once the new message is answered, so "continuing…" is followed by actual continuation, and sub-agents no longer report a mid-task answer to their parent as the finished result.

### Fixed

- Agents: an interrupt during a parallel tool_use batch dropped every result that had already finished, so the model re-ran side-effecting work; finished results now land and only the tool the abort hit is marked do-not-retry.
- Models: `deepseek-flash` now sees images (DeepSeekAgent used to drop image blocks entirely; `deepseek-v4-pro` stays text-only because it accepts the block but can't read it).

## [1.3.3] - 2026-09-20

### Fixed

- Agents: the LLM history (`rawMessages`) of a session is now written to disk when each tool call is issued and again when its result lands, not only when the turn ends. A server restart or crash in the middle of a long tool-using turn used to lose the whole turn from the model's memory — the user's message and every tool call — while the UI log (written per event) still showed it all, so the agent came back with no recollection of what it had just been asked to do. Saving the call itself before it runs also matters when the tool *is* the restart (`systemctl restart` after a self-upgrade): the agent now wakes up seeing that it already issued the command instead of issuing it again in a loop. Only the result of the single tool call in flight at the moment of death is lost.
- Agents: the `[System] The server restarted …` nudge sent to sessions interrupted by a restart now tells the agent that its history up to the last completed tool call is intact and to continue the task from there; it previously only talked about re-dispatching sub-agents, so a root killed mid tool-loop went looking for stopped children instead of resuming its own work.

## [1.3.2] - 2026-09-20

### Added

- Channels: WeCom (企业微信) 智能机器人 — the sixth IM channel, modelled on Feishu. Long-connect over wss via the official `@wecom/aibot-node-sdk`, no public webhook; replies, proactive cron pushes and media uploads all ride the same socket (WeCom has no HTTP send API). Per user in single chat, one shared session per group; slash commands in single chat only; `allowedUsers` gate on `from.userid`. Inbound text / image / mixed / voice / file / video; outbound `MEDIA:` as image (png/jpg/gif), video (mp4) or file, 20 MB cap. Admin Channels → WeCom tab (botId, write-only secret, agent, access level, allowed users), `/api/wecom/accounts` REST, cron target `wecom:<accountId>:<chatId>` (explicit chatId required, like slack / feishu). Onboarding in `guide/channels/wecom.md`. The bundled send-file / cron skills and RUNTIME.md know about it (TEMPLATE_VERSION 59).
- Server: versioned schema migrations. Every sqlite file (workspace `halo.db`, global `cron.db` / `channels.db` / `evo.db` / `runs.db`) used to evolve by re-running additive `ALTER TABLE … ADD COLUMN` probes on each boot — fine for adding a column, impossible for anything else. `db/migrate.ts` runs an ordered per-db migration list against `PRAGMA user_version`, each slot in its own transaction, stamped after; a database already altered by the old boot path lands on the current version without re-applying anything, and a db stamped by a newer halo is left alone with a warning rather than refused.
- Core: `@turmind/halo-core/protocol` — the session-message shape and every admin WebSocket frame (`WsClientMessage` / `WsServerMessage`, a 43-member discriminated union) as one shared type source. Server and admin each kept their own copy before, and the admin cast every inbound frame to a hand-written local type; now a field added on one side fails `tsc` on the other. No wire field renamed or added.
- Tests: contract tests for the three least-covered spines — `AgentLoop`'s tool cycle (parallel tool_use result ordering, unknown / throwing tools, timeout vs cancel, refusal), the ACP adapter's stdio JSON-RPC framing and SSE parsing (first tests in that package, now in CI), and the evolution wrapper's fs-level phases driven in-process against a tmp workspace. Model-error classification is a pure function (`classifyModelError`) with a 28-case table.
- Repo: `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1); private vulnerability reporting enabled on the GitHub repository.

### Fixed

- Web channel: `?sessionId=` / `/api/sessions/logs/:id` accepted any string; an unknown id was created verbatim and its leaf segment became the session file name, so a crafted id could escape the sessions directory. Both now reject unsafe id segments (400) before the ownership check (403).
- Server: the full-access shell and the admin terminal PTY inherited the whole server `process.env`, including `HALO_JWT_SECRET` / `HALO_PASSWORD`; both now spawn with the same scrubbed env cron / evolution children already got.
- Web channel: the `agentId` override bypassed the disabled / internal-agent filter; it is now matched against the same agent scan the admin uses and anything else is rejected.
- Git panel: saving HTTPS credentials ran `git config --global credential.helper store`, rewriting the server user's global git config; the helper is now passed per command.
- Logger: `?token=` query values are scrubbed before any sink (stdout / file / OTel) — web tokens ride in the URL for SSE and `<img src>`, so a logged URL was a live credential.
- Agents: Anthropic `stop_reason: "refusal"` (HTTP 200, safety classifier) was handled like `end_turn` — the empty / partial assistant message was pushed into history and a partial `tool_use` was executed, after which every later turn in the session was refused too, so the user saw an endless run of instant empty replies. The loop now discards the partial output, runs no tool, and emits a system message naming the category and explanation and pointing at `/new`.
- Agents: a real Bedrock `ThrottlingException` ("Too many requests, please wait before trying again.") carries none of the keywords the throttle branch matched on, so genuine throttling fell through to fatal and killed the turn on attempt 1 instead of backing off. Classification now checks the structured error name / HTTP 429 before the message text.
- Sessions: the per-exchange Delete button silently did nothing on any session that had ever compacted. `exchange:delete` now carries the `archiveCount` the client's view was opened against, and the server refuses (`'archived'`) only when it differs from the on-disk count — the one case where the ordinal is actually stale. Reopening re-anchors and the delete goes through.
- Evolution: the sandbox copy of `.halo/` used `fs.cpSync({ dereference: true })`, which Node ≥ 22.17 ignores for symlinks nested below the top level (nodejs/node#59168) — a symlinked file under `.halo/` was copied as a link back into the live workspace, so an evolution edit through it would have written straight into main. Replaced with a hand-rolled walk that copies bytes.

### Changed

- Dependencies: `pnpm audit --prod` 137 → 29 advisories (critical 2 → 0, high 49 → 2) via hono / @hono/node-server / ws / nanoid / next bumps and workspace overrides for transitive highs. Dead `chokidar` and `drizzle-kit` (never wired) dropped.
- Admin: the never-emitted task-plan WS surface (`task:plan` / `task:status` / `plan:complete` / `agent:configs`, `task-store`, `TaskPlan*` types) is removed; `state:snapshot` stops sending its placeholder fields.
- Log prefixes use one casing (`[WeChat]`, `[Telegram]`, `[EvoTicker]`, …) — the prefix is the `halo.module` attribute in OTel, so the split showed up in dashboards.

## [1.3.1] - 2026-09-19

### Changed

- Observability: with `capture_content` on, a `chat` span's `gen_ai.input.messages` now carries only the messages appended since the previous `chat` span of the same turn (the user message on the first call, that cycle's tool results after), and `gen_ai.system_instructions` moves to the `invoke_agent` span, once per turn. Previously every model call replayed the whole history plus the system prompt, so a turn's exported bytes grew quadratically with the conversation — a 4-turn / 9-call session shipped 129 KB of content attributes (~74 KB of it the same system prompt nine times); the same session now ships 44 KB. The full conversation is still the in-order concatenation of the chat spans' input + output; AgentCore Evaluations scores are unchanged.

## [1.3.0] - 2026-09-19

### Added

- Observability: the server now speaks OpenTelemetry. Set `general.observability.endpoint` to an OTLP collector (e.g. `http://localhost:4318`) and traces, metrics and logs leave over OTLP http/protobuf; leave it empty and nothing is loaded — the SDK is a dynamic import behind a single `enabled` gate, so an unconfigured server (and the CLI, which shares `logger.ts`) pays one boolean check per hook. Companion settings: `service_name` (resource `service.name`), `headers` (secret, comma-separated `k=v` for hosted backends), `capture_content` (default off — put prompt / completion / tool argument and result text on spans; off keeps only model, tokens, latency, tool names). All four are global and take effect on restart. `http://` or `https://` by URL scheme (TLS via the standard `OTEL_EXPORTER_OTLP_*CERTIFICATE*` env); no gRPC exporter — point at the collector's OTLP/HTTP port (4318), not 4317.
- Spans follow the OTel GenAI semantic conventions under scope `opentelemetry.instrumentation.halo`, so any semconv-aware backend reads them without a framework adapter: one `invoke_agent <agent>` per turn → `chat <model>` per model call (`gen_ai.usage.*`, `finish_reasons`) → `execute_tool <tool>` as its child, all stamped with `session.id`. With `capture_content`, `gen_ai.input/output.messages` (parts format), `gen_ai.system_instructions`, `gen_ai.tool.call.arguments/result` and `gen_ai.task.input/output`. Metrics: `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `halo.tool.duration`, `halo.turn.duration{outcome}`, `halo.model.retries{kind}`. Every `logger.*` call is bridged to an OTel LogRecord with severity + `halo.module`.
- Vendor-neutral by design: the server has no AWS or vendor code — SigV4, backend endpoints and resource enrichment live in the collector. Verified end to end against a local collector → CloudWatch (`aws/spans`, logs, EMF metrics) and Amazon Bedrock AgentCore Evaluations, both the online-config path and the on-demand `evaluate` API fed straight from the collector's file exporter (no CloudWatch in the loop). The reference collector config and the Evaluations contract for custom instrumentation are in `design/observability.md`.

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

[Unreleased]: https://github.com/turmind/halo-agent/compare/v1.5.5...HEAD
[1.5.5]: https://github.com/turmind/halo-agent/compare/v1.5.4...v1.5.5
[1.5.4]: https://github.com/turmind/halo-agent/compare/v1.5.3-alpha...v1.5.4
[1.5.3-alpha]: https://github.com/turmind/halo-agent/compare/v1.5.2-alpha...v1.5.3-alpha
[1.5.2-alpha]: https://github.com/turmind/halo-agent/compare/v1.5.1-alpha...v1.5.2-alpha
[1.5.1-alpha]: https://github.com/turmind/halo-agent/compare/v1.5.0-alpha...v1.5.1-alpha
[1.5.0-alpha]: https://github.com/turmind/halo-agent/compare/v1.4.6...v1.5.0-alpha
[1.4.1]: https://github.com/turmind/halo-agent/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/turmind/halo-agent/compare/v1.3.4...v1.4.0
[1.3.4]: https://github.com/turmind/halo-agent/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/turmind/halo-agent/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/turmind/halo-agent/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/turmind/halo-agent/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/turmind/halo-agent/compare/v1.2.1...v1.3.0
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

# Session & Channel Test Cases

Manual smoke + regression checklist before a release. Last refreshed for the 2026-05 schema/refactor wave.

**Test environment** (matches `reference_test_env.md` memory):
- Local URL: `http://localhost:9527/?folder=<absolute-workspace-path>`
- Password: `HALO_PASSWORD` env var (or the random one printed on first startup)
- Workspace under test: `/path/to/test-workspace`
- Required workspace agents: `default`, `sleeper`, `test-agent`
- Required env vars for the LLM-touching cases: at least one of `KIMI_API_KEY` / `DEEPSEEK_API_KEY` / AWS credentials, configured via Settings page.

**How to use this doc**:
- Run the **automated regression script first** (covers ~25% of cases below): `HALO_TEST_PASSWORD=... HALO_TEST_PROJECT=/path/to/test-workspace node packages/server/tests/test-session-system.mjs`
- Then walk the table top-to-bottom for full release validation.
- 🟢 = automated covers it; 🟡 = automated partial; ⬜ = manual only.

---

## A. Agent system (REST + UI, no LLM)

| # | Coverage | Scenario | Method | Expected |
|---|---|---|---|---|
| A1 | 🟢 | Default agent loads from global | `GET /api/agent-configs` | `default` present, `scope=global`, `priority=99` |
| A2 | 🟢 | Workspace agents visible | `GET /api/agent-configs?projectId=...` | `sleeper` + `test-agent` listed alongside global ones |
| A3 | 🟢 | Create workspace agent via API | `POST /api/agent-configs` then `GET .../yaml` | YAML round-trips name/description/model |
| A4 | 🟢 | Delete workspace agent | `DELETE /api/agent-configs/:id?scope=workspace` | 200; gone from list |
| A5 | 🟢 | `list_agents` tool | Chat: "Use list_agents to show available agents" | Returns id+name+description (no model/tools) |
| A6 | 🟢 | `query_agent` tool | Chat: "Use query_agent to inspect 'sleeper'" | Full fields (model/tools/skills) |
| A8 | ⬜ | Provider switch carries over thinking effort if still valid | UI: change Bedrock → Bedrock other model with same effort presets | Effort label stays highlighted |
| A9 | ⬜ | Provider switch resets effort when vocabulary differs | UI: Bedrock (effort=medium) → Kimi | Effort resets to Kimi's `defaultEnabled` config |
| A10 | ⬜ | Provider switch turns prompt-caching default on for Bedrock | UI: switch any provider → Bedrock | Prompt caching toggle on, value = `1h` |
| A11 | ⬜ | Provider switch clears prompt caching when target doesn't support it | UI: Bedrock (caching=1h) → DeepSeek | Caching toggle off, no stale `promptCaching:` field saved |
| A12 | ⬜ | Agent form Context fields reflect settings.yaml `general.compact.compress_at` default | New agent without override | `compressAt` placeholder shows `0.8` |

## B. Default agent basics (WS + LLM)

| # | Coverage | Scenario | Input | Expected |
|---|---|---|---|---|
| B1 | 🟢 | Multi-turn context | "Say hello" → "What did I just say?" | Context preserved; recalls |
| B2 | ⬜ | Stop + resume | "Write a 500 word essay" → Stop → "Continue" | Clean stop; resume produces continuation |
| B3 | ⬜ | Refresh during tool | "sleep 10, then tell a joke" → refresh mid-sleep | Reconnect shows in-progress; completes |
| B4 | ⬜ | Stop during tool | "sleep 10, then tell a joke" → Stop mid-sleep | Clean abort, no stray "stopped" badges on unrelated sessions |
| B5 | ⬜ | New message interrupts | "sleep 10, then tell a joke" → new msg mid-sleep | New msg handled after current tool completes (graceful interrupt) |
| B6 | ⬜ | Agent selector switch | Agent dropdown → `sleeper` → send msg | Session uses sleeper |
| B7 | ⬜ | Session lock during conversation | Start chat then try switching agent | Dropdown locked |

## C. Agent capabilities (LLM + tools + features)

| # | Coverage | Scenario | Input | Expected |
|---|---|---|---|---|
| C1 | ⬜ | Tool call basic | "Read /tmp/test.txt" | `file_read` tool fires; result rendered |
| C2 | ⬜ | Multiple tools in one turn | "List files in /tmp and read /tmp/test.txt" | All tool calls visible |
| C3 | ⬜ | Long shell output | `find /path/to/halo -name '*.ts' -type f` | Truncation marker shown only past `toolResultMax` |
| C4 | 🟢 | Prompt caching 5min | Two messages in succession | Second usage event has `cacheReadInputTokens > 0` |
| C5 | ⬜ | Prompt caching 1h | Agent.yaml `promptCaching: 1h` | First message creates cache, subsequent reads it; `cacheWriteInputTokens` only on write |
| C6 | ⬜ | Thinking adaptive low | Agent `thinking.effort: low` | Reply contains thinking block; small char count |
| C7 | ⬜ | Thinking adaptive medium | `thinking.effort: medium` | Larger thinking block |
| C8 | ⬜ | Thinking adaptive high | `thinking.effort: high` | Largest thinking block |
| C9 | ⬜ | Thinking manual mode (Haiku 4.5) | Agent on `claude-haiku-4-5` w/ `thinking.budget_tokens: 8192` | Usage badge shows `think 8192` (NOT `think medium`) |
| C10 | ⬜ | Streaming completes after error | Bad credentials in agent.yaml provider | Red "Error: ..." system message rendered; `isStreaming` reverts to false (no spinner stuck) |
| C11 | ⬜ | Image input passthrough | Paste image into chat → "describe this" | Image saved under `<workspace>/.halo/assets/web/inbound/`, agent sees and describes |
| C12 | ⬜ | Image filtered for non-vision provider | Paste image while on DeepSeek | Image dropped with `[图片已保存]` marker; agent still answers |

**C4-C5 verification (raw usage):**
```bash
python3 -c "
import json, glob
files = sorted(glob.glob('/path/to/test-workspace/.halo/sessions/default/*.json'), key=lambda f: -__import__('os').path.getmtime(f))
if files:
    d = json.load(open(files[0]))
    for msg in d.get('rawMessages', []):
        u = msg.get('usage', {})
        if u.get('cache_read_input_tokens', 0) > 0:
            print(f'Cache hit: read={u[\"cache_read_input_tokens\"]} create={u.get(\"cache_creation_input_tokens\", 0)}')"
```

## D. Session tools (sub-agent delegation)

| # | Coverage | Scenario | Input | Expected |
|---|---|---|---|---|
| D1 | 🟢 | Basic delegation | "Ask sleeper to sleep 10s then tell its height" | start_session → wait → auto-report |
| D2 | ⬜ | query_session continues | After D1: "Ask it again, what's its weight?" | Same session reused (no second start_session) |
| D3 | ⬜ | interrupt_session | "Ask sleeper to sleep 30s then tell story" → "Interrupt and ask weight" | interrupt fires, new task runs |
| D4 | ⬜ | stop_session | "Ask sleeper to sleep 30s" → "Stop it" | clean stop |
| D5 | ⬜ | New session | After D1: "Start another sleeper" | Fresh start_session (different sessionId) |
| D6 | ⬜ | Parallel delegation | "Start two sleepers concurrently" | Both auto-report |
| D7 | 🟢 | session_list inside agent | Agent calls session_list mid-conversation | Returns active children |
| D8 | ⬜ | get_session_output | After D1: "Read full output from sleeper" | Returns full last-turn text |
| D9 | ⬜ | archive_session | Agent calls archive_session on a sub-tree | Cascade archives, no longer in session_list |
| D10 | ⬜ | Tool **only sees agent's declared params** | `test-agent` tries `{{tavily-web-search.params.api_key}}` in shell_exec but doesn't list tavily as a skill | Placeholder kept literal, curl 401 — verifies new namespace whitelist |

## E. Session ops (REST + WS lifecycle)

| # | Coverage | Scenario | Method | Expected |
|---|---|---|---|---|
| E1 | ⬜ | start_session emits sessionId | Chat triggers start_session | UI shows sub-session in tree, sessionId returned |
| E2 | ⬜ | session_list during running | Agent calls during another's run | Status `running` |
| E3 | ⬜ | query_session restores idle | Query a completed session | Restored from disk; reply produced |
| E4 | ⬜ | query_session queues busy | Query a running session | Message queued, handled after current turn |
| E5 | ⬜ | stop_session sets stoppedAt | Agent stops a peer | SQLite has stoppedAt; UI shows stopped badge |
| E6 | 🟢 | delete_session cascades | WS `session:delete` | SQLite + JSON files for parent + descendants gone |
| E7 | 🟢 | delete via REST goes through SessionManager | `DELETE /api/sessions/logs/:id` | Tombstone set; pending in-flight saves don't resurrect file |
| E8 | ⬜ | Resurrection guard | Active session being subscribed; delete via REST while a `chat:complete` save is pending | File stays gone after delete (regression test for the WS save resurrection bug) |
| E9 | ⬜ | UI Reset button hidden when value = default | Settings page general field at default | "Reset" link not visible |
| E10 | ⬜ | UI Reset reverts to schema default | Settings page general field overridden, click Reset | Field shows muted-italic placeholder = schema default; source badge `unset` |

**E6-E8 verification:**
```bash
# Before delete
sqlite3 /path/to/test-workspace/.halo/halo.db "SELECT id, agent_id, parent_id FROM agent_sessions ORDER BY created_at DESC LIMIT 5;"
ls -lt /path/to/test-workspace/.halo/sessions/*/ | head

# After delete — both should be empty for the deleted id
sqlite3 /path/to/test-workspace/.halo/halo.db "SELECT id FROM agent_sessions WHERE id = '<deleted-id>';"
find /path/to/test-workspace/.halo/sessions -name '<deleted-id>*'
```

## F. Background & restore

| # | Coverage | Scenario | Input | Expected |
|---|---|---|---|---|
| F1 | ⬜ | Detached run | Start sub-agent → `/new` → switch back later | Sub-agent finishes in background; result visible |
| F2 | ⬜ | WS disconnect/reconnect | Start sub-agent → close tab → reopen | Sub-agent finishes; reconnect shows report |
| F3 | ⬜ | Server restart restore | Active session → restart server → reconnect | UIState restored from disk; conversation visible |
| F4 | ⬜ | UIState flush on release | Start agent, immediately interrupt mid-stream | Disk file `.json` `messages` stays in sync with `rawMessages` (regression for releaseSession flushPersist) |

## G. Loop & depth

| # | Coverage | Scenario | Input | Expected |
|---|---|---|---|---|
| G1 | ⬜ | Ping-pong | "Play ping-pong with sleeper, 3 rounds" | Two-way query_session; LLM stops naturally |
| G2 | ⬜ | 3-level chain | "Start test-agent, have it start another, depth 3" | 3-level parent chain; reports bubble up |
| G3 | ⬜ | Cross-agent delegation | "Have test-agent ask sleeper its name" | test-agent → start_session(sleeper) |
| G4 | ⬜ | Max nesting depth guard | Manually trigger 17-deep delegation chain | start_session returns `code 1` "Maximum nesting depth (16) reached" |

## H. Context window & compact

| # | Coverage | Scenario | Input | Expected |
|---|---|---|---|---|
| H1 | ⬜ | Auto-compact at threshold | Read large files until 80% (default `compress_at: 0.8`) | Auto-compact fires; tokens drop |
| H2 | ⬜ | `general.compact.compress_at` honored | Settings → set 0.5 → start session, fill | Compact fires earlier (50% instead of 80%) |
| H3 | 🟢 | Manual `/compact` | Type `/compact` or click TokenRing | `compact:progress` → `session:compacted` → `compact:done` |
| H4 | ⬜ | Compact disabled while streaming | Click TokenRing while agent runs | Button disabled (isStreaming guard) |
| H5 | ⬜ | Stop during compact | Click Stop during compact | Compact cancelled; messageLog unchanged |
| H6 | ⬜ | **Message during compact drains after** | Send msg during compact | "Queued" notification → after compact ends, message **immediately runs** (regression for `endCompact` drain fix) |
| H7 | ⬜ | Refresh after compact | Reload after compact | Message order correct; tool calls render in their turns |
| H8 | ⬜ | Sub-agent context overflow recovery | Sub-agent reads huge files, hits overflow | Local truncation fallback fires + retry; no crash |
| H9 | ⬜ | Rate-limit retry with backoff | Hammer fast messages | "Rate limited, retrying in Xs…" system msg; eventually succeeds |

## I. Slash commands

| # | Coverage | Scenario | Method | Expected |
|---|---|---|---|---|
| I1 | 🟢 | `/new` | WS `session:clear` | Old session saved; new conversation empty; old in sidebar |
| I2 | ⬜ | `/new` during sub-agent | `/new` while child running | Sub-agent continues background; new conversation independent |
| I3 | 🟢 | `/compact` | WS `command:compact` | Summary generated; older messages compressed |
| I4 | ⬜ | `/context` | UI command | Shows tokens, model, agent's available tools, system prompt |
| I5 | ⬜ | `/list` (full access) | UI command on web channel (admin-equivalent) | All workspace sessions visible with tags |
| I6 | ⬜ | `/list` (readonly/workspace user) | wechat/tg readonly user `/list` | **Only own-prefix sessions** (regression for cross-user privacy) |
| I7 | ⬜ | `/switch` matches `/list` indices | After I6, `/switch 1` for readonly user | Switches to user's first own session |
| I8 | ⬜ | `/switch` to non-own blocked | readonly tries `/switch` to a global admin session via crafted index | Returns `switch.readonly` rejection (defense-in-depth even though list filtered) |
| I9 | ⬜ | All builtin `/help`/`/agents`/`/agent`/`/ws`/`/stop` reachable from each channel | Run each through web/tg/wx | Same response shape |
| I10 | ⬜ | Server startup descriptor↔dispatch sanity check | Restart server | Throws if a builtin server descriptor is missing a dispatch case |

## J. Session viewer & Debug

| # | Coverage | Scenario | Input | Expected |
|---|---|---|---|---|
| J1 | ⬜ | Debug rendering | Multi-tool conversation | Debug: exchange layout, tool_call cards, usage badges |
| J2 | ⬜ | Non-Debug filter | Same conversation | Only assistant text + inline tool cards |
| J3 | ⬜ | Usage fields | After multi-tool | in / out / ctx / cache% / ttft / e2e / model shown |
| J4 | ⬜ | System prompt view | Click Prompt button | Full system prompt rendered |
| J5 | ⬜ | Parent/child prompts | Inspect parent then child sub-session | Both have Prompt buttons; each shows its own |

## K. Sidebar & cleanup

| # | Coverage | Scenario | Expected |
|---|---|---|---|
| K1 | ⬜ | Session tree render | Users' sessions with children show hierarchy |
| K2 | ⬜ | Depth indentation | After G2: 3-level indentation correct |
| K3 | ⬜ | Cascade delete | Delete main session → all sub-sessions + SQLite + files cleaned |
| K4 | ⬜ | Sub-session preview | Click sub-session → full agent conversation |
| K5 | ⬜ | Stopped badge | After D4: stopped session shows StopCircle |
| K6 | ⬜ | Refresh button shows spinning animation | Click refresh on agent-sessions sidebar | RefreshCw rotates ≥350ms even on fast responses |
| K7 | ⬜ | No spinner flash on bus-driven refresh | Delete session, observe refresh | Other consumers reconcile silently, no extra spinner stutter |

## L. Settings UI (post-2026-05 schema refactor)

| # | Coverage | Scenario | Expected |
|---|---|---|---|
| L1 | ⬜ | Sections grouped by declarer | Open Settings | "System" / "Model Providers" / "Agents" / "Skills" / "Orphans" navigation |
| L2 | ⬜ | Provider yaml drives section | Add a new `models/myprov.yaml` with `secrets:` | Section appears for it after server restart |
| L3 | ⬜ | Skill yaml drives section | Add `skills/X/config.yaml` with `params:` | Section visible |
| L4 | ⬜ | Agent yaml drives section | Add `agents/X/agent-config.yaml` with `params:` | Section visible |
| L5 | ⬜ | Field type renders right control | Schema int/float/boolean/enum/string fields | Number / toggle / dropdown / text inputs |
| L6 | ⬜ | YAML scalar preserved on save | Save `compress_at: 0.8` then read settings.yaml | `compress_at: 0.8` (unquoted, real number) |
| L7 | ⬜ | Mtime-cached config picks up edits live | Edit settings.yaml externally, send a chat | Server picks new value on next call without restart |
| L8 | ⬜ | Secret masking on transport | Settings page secret field with real value | API returns `xx****yy`; env-var refs `<<KEY>>` not masked |
| L9 | ⬜ | Source badges | Workspace scope, value comes from global | Badge "inherited from global" |
| L10 | ⬜ | Orphan listing + remove | Insert junk namespace into settings.yaml | Appears in Orphans tab; Remove deletes it |
| L11 | ⬜ | Schema default vs config.ts callsite consistency | Boot server | No `[config] default mismatch for "..."` warnings in log |
| L12 | ⬜ | Missing env var keeps `<<NAME>>` literal | Set `kimi.secrets.api_key: <<UNSET_VAR>>`, chat with kimi | API call returns 401 with literal `<<UNSET_VAR>>` (regression for "no silent env fallback") |

## M. Channel — wechat/telegram/web (multi-user)

| # | Coverage | Scenario | Method | Expected |
|---|---|---|---|---|
| M1 | ⬜ | Inbound text | Send chat from each channel | Routes to its own prefix session |
| M2 | ⬜ | Inbound image (telegram) | Send photo | Saved under `assets/telegram/inbound/`; agent describes |
| M3 | ⬜ | Inbound image (wechat) | Send image via wechat-bot | Same: saved + described |
| M4 | ⬜ | Inbound voice/audio (web) | Paste audio file | Saved under `assets/web/inbound/`; `[语音已保存]` marker |
| M5 | ⬜ | `inferImageMime` magic byte detection | Various jpg/png/webp/gif | All correct after the dedupe to shared/media-store |
| M6 | ⬜ | `resolveAccountWorkspace` after dedupe | Disable a workspace path on disk, send msg | All channels return early, no broken sm calls |
| M7 | ⬜ | Two wechat users in same workspace, isolation | User A `/list` doesn't show user B's session titles | Confirms post-fix `/list` filtering |
| M8 | ⬜ | Compact-during-tg-message drain | Trigger compact while tg user sends a message | Message processed right after compact ends (regression for endCompact) |
| M9 | ⬜ | tg compaction status feedback | Send message during compact | "compacting" reply (parity with web/wechat) |

## N. CLI / TUI

The CLI ships an embedded agent loop and **bypasses the WS server** by design (lifestyle separation: CLI/TUI for offline scripts, WS for browser/admin). Tests here live separately.

**Setup**:
```bash
# Build CLI (if not done)
pnpm --filter @turmind/halo-cli build

# Smoke
node packages/cli/bin/halo.js --help
```

| # | Coverage | Scenario | Method | Expected |
|---|---|---|---|---|
| N1 | ⬜ | CLI prints version | `halo --version` | Matches package.json |
| N2 | ⬜ | TUI launch | `halo tui` | Starts, shows agent picker, accepts input |
| N3 | ⬜ | TUI single turn | `halo tui` → say "what is 2+2" | Reply rendered with usage badge `think medium` (or model default) |
| N4 | ⬜ | TUI session id has `cli_` prefix | After N3 | `~/.halo/sessions/default/cli_<...>.json` exists |
| N5 | ⬜ | TUI `/agents` | Inside tui, `/agents` | List with global + workspace agents |
| N6 | ⬜ | TUI `/agent <id>` | `/agent sleeper` | Switches; next prompt goes to sleeper |
| N7 | ⬜ | TUI `/new` | After N6: `/new` | New session, sleeper-scoped |
| N8 | ⬜ | TUI `/stop` | "sleep 30 then say hi" → Ctrl-C or `/stop` | Clean abort |
| N9 | ⬜ | TUI `/compact` | Build up 8+ messages → `/compact` | Compact runs; ctx tokens drop in next prompt |
| N10 | ⬜ | TUI tool call rendering | Ask file_read | Tool card renders inline in tui |
| N11 | ⬜ | TUI thinking display (manual mode) | Switch to Haiku 4.5 agent | Usage badge shows `think 8192` (or whatever budget_tokens), not `think medium` |
| N12 | ⬜ | TUI session resume across restart | N3 then exit + restart `halo tui --resume` (or whatever the resume cmd is) | History visible |
| N13 | ⬜ | TUI graceful interrupt on new message | "sleep 10 then say hi" → press Esc + new message | New message handled after current tool, no abort error |
| N14 | ⬜ | CLI `halo server start` single-instance lock | Start two instances | Second exits with "another instance running" |
| N15 | ⬜ | CLI `halo setup` rewrites config.yaml | Run with `--password new-pw` | `~/.halo/secrets/config.yaml` has new scrypt hash + new jwt_secret |
| N16 | ⬜ | TUI sandbox enforced | `tui --access-level readonly` (if flag exists) → try `file_write` | Tool refused / sandbox blocks |
| N17 | ⬜ | TUI uses **same** SessionManager.persistSessionFile path | Run a session in TUI, then start the WS server pointing at same workspace | UI shows the TUI session in sidebar (single source of truth) |

> **Note on TUI commands**: I've listed commands by name above (`/agents`, `/agent`, `/new`, etc.). If your TUI uses different keybindings instead, swap the trigger column accordingly — the **expected behavior** is what we're checking.

---

## Detailed steps & verification (selected cases)

### D1 — Basic delegation

**Steps:**
1. Send: "Ask sleeper to sleep 10s then tell its height"
2. Default agent calls `start_session` (agent: sleeper)
3. Sleeper completes; `[Message from ...]` auto-delivered
4. Default agent activates, reports

**Verify:**
- [ ] No unnecessary polling (no extra `session_list` / `get_session_output`)
- [ ] Single final reply with sleeper's height
- [ ] Sidebar: user session shows 1 sub-session

**Data:**
- [ ] SQLite `agent_sessions`: child row has `parent_id = user's session id`
- [ ] `.halo/sessions/sleeper/`: JSON file exists
- [ ] JSON: `parentSessionId` = user's id; `rawMessages` non-empty

### D10 — Skill namespace whitelist (regression)

**Steps:**
1. Configure `tavily-web-search` skill with a real `api_key` in Settings.
2. Edit `test-agent/agent.yaml` to include `skills: [tavily-web-search]` — do NOT include it.
3. Have the agent run: `shell_exec('curl -H "Authorization: Bearer {{tavily-web-search.params.api_key}}" https://api.tavily.com/search')`

**Expected:**
- Server log: `[workspace-tools] {{tavily-web-search.params.api_key}} rejected — namespace not in allowed list`
- The literal `{{tavily-web-search.params.api_key}}` is sent to Tavily → 401.
- Re-add `tavily-web-search` to `skills:` list, retry → real key resolves → 200.

### E7 — REST DELETE goes through SessionManager

**Steps:**
1. Open a session in the browser, send a couple of messages.
2. Without closing the browser tab, run from another shell:
   `curl -b cookie.txt -X DELETE "http://localhost:9527/api/sessions/logs/<sid>?projectId=/path/to/test-workspace"`
3. Send another message in the browser.

**Expected:**
- Server log: `[SessionManager] Deleted N sessions from SQLite (root: <sid>)`
- The next `chat:complete`-driven save in WS handler is dropped (tombstone hit).
- File on disk stays gone (don't see the file size grow back).

### H6 — Message during compact

**Steps:**
1. Build a session with 9+ messages.
2. Trigger `/compact`.
3. While `compact:progress` event is in flight, send a new message.
4. Observe the order of events.

**Expected:**
- WS receives `chat:queued` (message stashed in `pendingUserMessages`).
- `session:compacted` arrives.
- **Within 1–2 seconds**, the queued message starts running automatically (no need to send anything else).
- This is the regression test for the recent `endCompact` drain fix — before the fix, the queued message would sit indefinitely.

---

## Automated regression script

Path: `packages/server/tests/test-session-system.mjs`

What it covers (🟢 cells in the tables above): A1–A6 (tool calls), B1, C4, D1, D7, E6, E7, I1, I3.

Run:
```bash
HALO_TEST_PASSWORD=$HALO_PASSWORD \
HALO_TEST_PROJECT=/path/to/test-workspace \
node packages/server/tests/test-session-system.mjs
```

Exits 0 on all-green. The script does **not** start/stop a server — bring your own. It logs in via REST, opens a WS, runs the suite, prints a final pass/fail count.

**What's NOT in the regression script** — handled by the manual table above:
- B2–B7 (UI-driven flows: stop+resume, refresh during tool, agent dropdown lock)
- C5–C12 (caching variants, thinking effort tiers, image filtering)
- D2–D6, D8–D10 (continued conversations, parallel delegation, namespace whitelist)
- E8–E10 (resurrection guard, settings reset visuals)
- F, G, H (background, depth chains, full compact flow)
- L (settings UI rendering)
- M (channel inbound)
- N (CLI/TUI)

If you change session lifecycle code, **at minimum**: re-run the regression script + walk D, E, F, H by hand.

---

## Quick data-verification pipeline

After any test case that should produce / mutate session state:

```bash
PROJECT=/path/to/test-workspace

# SQLite — agent_sessions index
sqlite3 $PROJECT/.halo/halo.db \
  "SELECT id, parent_id, agent_id, stopped_at IS NOT NULL AS stopped, archived_at IS NOT NULL AS archived
   FROM agent_sessions ORDER BY created_at DESC LIMIT 10;"

# Session files (all agents)
for dir in $PROJECT/.halo/sessions/*/; do
  echo "=== $(basename $dir) ==="
  ls -lt "$dir" 2>/dev/null | head -5
done

# parentSessionId integrity check
for f in $PROJECT/.halo/sessions/*/*.json; do
  python3 -c "
import json
d = json.load(open('$f'))
parent = d.get('parentSessionId', 'NONE')
print(f\"{d['agentId']}/{d['id']}  parent={parent}\")
" 2>/dev/null
done

# Settings schema sanity
curl -sb /tmp/halo-cookie.txt http://localhost:9527/api/settings/schema | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(f'sections={len(r[\"sections\"])} orphans={len(r[\"orphans\"])}')"
```

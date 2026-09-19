# Relay — cross-workspace dispatch with auto-report

> Tool reference: [dev/tools.md → Relay tools](../dev/tools.md#relay-tools). Code: `packages/server/src/agents/relay.ts`, wired in `session-manager.ts` (`createRelayTools`, the `deliverRelayReport` finally hook), `session-agent-builder.ts` (opt-in gate), `index.ts` (`setRelayRegistry`).

## Problem

Halo runs many workspaces on one server — one per team / project / credential boundary — and each is a self-contained agent runtime. A "secretary" pattern falls out naturally: one workspace whose agent only knows *which department knows what* and forwards the user's question there. Before relay the only cross-workspace path was the ACP adapter (HTTP + SSE + web-channel tokens, and an `ask-<label>` binding per remote), which is the right tool for a *different server* but heavy for two sqlite files on the same box. Relay is the in-process version: no HTTP, no tokens, no polling — and the result comes back on its own.

## Mechanism

Relay mirrors goal mode's shape exactly, because goal mode had already solved "deliver a session's wrap-up to some *other* session when it's genuinely done":

| | Goal mode | Relay |
|---|---|---|
| Back-pointer column | `agent_sessions.goal_session_id` on W | `agent_sessions.reply_to` on the target (JSON `{ workspace, sessionId }`) |
| Delivery hook | `deliverGoalRound` in `runSession`'s finally | `deliverRelayReport`, same finally, right after it |
| Quiet gate | root + no active children + empty queue | identical |
| Tool set | `buildGoalTools` (G only) | `buildRelayTools` (opt-in, full access): send / interrupt / stop / read / list |
| Reach | same workspace | any workspace via `SessionManagerRegistry` |

**Dispatch** (`relay_send` / `relay_interrupt` share one `dispatch(params, hard)`): resolve the target workspace (`realpathSync`, must contain `.halo/`) → `registry.getOrCreate(wsPath)` gives the foreign `SessionManager` → create the session if missing (`relay_interrupt` refuses instead: nothing to interrupt) → `writeReplyTo(target db, session_id, { workspace: caller ws, sessionId: caller session })` → `appendUserMessage` (UI transcript, raw text) + `sendUserMessage` (model-facing, prefixed `[channel: relay | from: <caller ws>]`). The prefix reuses the channel-tag convention the system prompt already teaches ("don't echo the tag"), so the target agent knows the message is agent-sourced without a new prompt rule.

**Hard interrupt** adds one step: if `sendUserMessage` returned `queued` (target was busy), call `target.interruptSession(session_id)`. Order is enqueue-then-abort, same as `querySession(interrupt=true)` — the aborted turn's finally sees a non-empty queue, so it drains into the message instead of firing a relay report for the half-done turn.

**Delivery** (`deliverRelayReport(host, session)`, runs at *every* root turn end in every workspace): cheap `reply_to` column read first (no-op for the 99.9 % of sessions without one) → subtree-quiet gate → body = `finalOutput || output`, `[RELAY TARGET ABORTED …]` prefix when `turnError` is set (before the cap, so the marker survives) → cap at `limits.autoReportMax` with a `relay_read(...)` pointer → `clearReplyTo` → `registry.getOrCreate(reply_to.workspace)` → `appendUserMessage` + `sendUserMessage` on the caller. Append-then-send is the same pair the run-ledger nudge uses: `sendUserMessage` alone never writes the UI transcript, so the secretary's admin view would show a reply to nothing.

## Invariants and why

- **One dispatch, one report.** `reply_to` is cleared *before* the send. A delivery failure (caller workspace unreachable) can't re-fire on the next turn end, and — more importantly — a user who later chats directly in the department workspace never pings the secretary. The secretary can always re-`relay_send` if a report went missing.
- **Nested trees report once.** The quiet gate is the same one `tryReportToParent` uses, so a target that fans out three sub-agents delivers exactly one relay report, after the last child bubbles up — not one per child turn end.
- **Full access only.** `session-agent-builder` injects the set only when `nameSet.has('relay_send') && accessLevel === null`. A sandboxed (`workspace` / `readonly`) session can't be given a tool that opens other workspaces' sqlite and session trees; listing the name in such an agent's yaml is silently ignored.
- **Name-gated bundle.** Only `relay_send` is recognised in `tools:`; the other four (`relay_interrupt` / `relay_stop` / `relay_read` / `relay_list`) ride along. Prevents a half-configured agent that can send but never read back / stop. The admin picker mirrors this with one chip (`GET /agent-configs/tools` builds it from `buildRelayTools` against a dummy target and rewrites the description to name the full set).
- **Server only.** `setRelayRegistry` is called once in `index.ts`; the CLI / TUI never call it, so `getRelayRegistry()` is `null` there — every tool returns `{"code": 1, "error": "relay is unavailable in this runtime (server only)"}` and `deliverRelayReport` logs a warning and returns. No CLI code path knows relay exists.
- **Target-side transcript is normal.** The department workspace's session looks like any other root session in its Sessions tab (user message, agent reply); the only trace of relay is the `reply_to` row while a dispatch is pending. Nothing in the target's system prompt changes.
- **Same workspace is allowed.** `workspace` is only checked for existence + `.halo/`; passing the caller's own path makes `getOrCreate` return the caller's own `SessionManager`, and everything else is unchanged. In effect relay is a `query_session` without the own-tree scoping — it reaches any **root** session in any workspace, including new ones. Not a hole: the tool is full-access only, and a full-access agent could already `shell_exec` its way into any session file.
- **Reports come back from roots only.** `deliverRelayReport` fires for `parentId === null`; a sub-session's turn end goes to `tryReportToParent` instead. Dispatching to a `parent>child` id delivers the message but never a report — target roots when you want to hear back. Dispatching to yourself works and terminates (one self-report, `reply_to` cleared) but is pointless.

## Soft vs hard interrupt

`relay_send` to a busy target = queued + soft interrupt (the current tool call finishes, then the message drains as part of one merged turn). That covers follow-ups and corrections — the secretary's default. `relay_interrupt` is for "stop what you're doing *now*": it aborts the in-flight turn (propagates to `shell_exec`, SIGTERMs the process group), then the queued message runs. Idle target → `relay_interrupt` degrades to a plain send (`interrupted: false`). The distinction is the same as `query_session` vs `interrupt_session` inside one workspace; relay just carries it across.

## What it deliberately doesn't do

- **No cross-server reach.** Same `SessionManagerRegistry`, same process. Different server → ACP adapter (`/acp add`).
- **No session discovery beyond a flat root list.** `relay_list` returns a workspace's root sessions (id / agent / title / status, newest 100) so the secretary can reuse an existing conversation; it doesn't walk trees or search transcripts — that's the admin's job.
- **No broadcast / fan-out helper.** The secretary calls `relay_send` once per department; the reports come back individually with the workspace + session id in the header, so it can tell them apart without extra bookkeeping.
- **No ACL beyond full access.** A full-access secretary can reach every workspace on the box — that's the deployment's trust boundary already (it can `shell_exec` into them anyway).
- **No admin UI for the link.** The pending `reply_to` isn't surfaced anywhere; the secretary's own transcript (dispatch tool call → `[Relay report …]` message) is the audit trail.

## Test

`packages/server/test/relay.test.ts` — stub `RelayTarget` + registry, 11 cases: `deliverRelayReport` no-op without `reply_to`, waits while a child is active, delivers exactly one append + one send with the header then clears, `ABORTED` prefix on `turnError`, ignores sub-sessions; `relay_send` creates + stamps `reply_to` + channel-prefixes the model text, rejects a nonexistent workspace; `relay_interrupt` busy → enqueue then abort + re-stamp, idle → no abort and never creates; `relay_list` roots only with title fallback, and defaults to the caller's own workspace.

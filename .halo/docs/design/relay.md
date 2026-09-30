# Relay — cross-workspace dispatch with auto-report

> Tool reference: [dev/tools.md → Relay tools](../dev/tools.md#relay-tools). Code: `packages/server/src/agents/relay.ts`, wired in `session-manager.ts` (`createRelayTools`, the `deliverRelayReport` finally hook, the `sendInterimReport` kick-point hook), `session-agent-builder.ts` (opt-in gate), `index.ts` (`setRelayRegistry`).

## Problem

Halo runs many workspaces on one server — one per team / project / credential boundary — and each is a self-contained agent runtime. A "secretary" pattern falls out naturally: one workspace whose agent only knows *which department knows what* and forwards the user's question there. Before relay the only cross-workspace path was the ACP adapter (HTTP + SSE + web-channel tokens, and an `ask-<label>` binding per remote), which is the right tool for a *different server* but heavy for two sqlite files on the same box. Relay is the in-process version: no HTTP, no tokens, no polling — and the result comes back on its own.

## Mechanism

Relay rides the same "deliver a session's wrap-up to some *other* session when it's genuinely done" seam that sub-agent auto-reports use — `runSession`'s finally:

| | Relay |
|---|---|
| Back-pointer column | `agent_sessions.reply_to` on the target (JSON `{ workspace, sessionId }`) |
| Delivery hook | `deliverRelayReport`, in `runSession`'s finally right after `tryReportToParent` |
| Quiet gate | root + no active children + empty queue (identical to `tryReportToParent`) |
| Tool set | `buildRelayTools` (opt-in, full access): send / interrupt / stop / read / list |
| Reach | any workspace via `SessionManagerRegistry` |

**Dispatch** (`relay_send` / `relay_interrupt` share one `dispatch(params, hard)`): resolve the target workspace (`realpathSync`, must contain `.halo/`) → `registry.getOrCreate(wsPath)` gives the foreign `SessionManager` → create the session if missing (`relay_interrupt` refuses instead: nothing to interrupt) → `writeReplyTo(target db, session_id, { workspace: caller ws, sessionId: caller session })` → `appendUserMessage` (UI transcript, raw text) + `sendUserMessage` (model-facing, prefixed `[channel: relay | from: <caller ws>]`). The prefix reuses the channel-tag convention the system prompt already teaches ("don't echo the tag"), so the target agent knows the message is agent-sourced without a new prompt rule.

**Hard interrupt** adds one step: if `sendUserMessage` returned `queued` (target was busy), call `target.interruptSession(session_id)`. Order is enqueue-then-abort, same as `querySession(interrupt=true)` — the aborted turn's finally sees a non-empty queue, so it drains into the message instead of firing a relay report for the half-done turn.

**Delivery** (`deliverRelayReport(host, session)`, runs at *every* root turn end in every workspace): cheap `reply_to` column read first (no-op for the 99.9 % of sessions without one) → subtree-quiet gate → body = `finalOutput || output`, `[RELAY TARGET ABORTED …]` prefix when `turnError` is set (before the cap, so the marker survives) → cap at `limits.autoReportMax` with a `relay_read(...)` pointer → header `[Relay report · workspace <ws> · session <id> · status: completed]` (`status: aborted` when `turnError` is set) → `clearReplyTo` → `registry.getOrCreate(reply_to.workspace)` → `appendUserMessage` + `sendUserMessage` on the caller. Append-then-send is the same pair the run-ledger nudge uses: `sendUserMessage` alone never writes the UI transcript, so the secretary's admin view would show a reply to nothing.

## Invariants and why

- **One dispatch, one *final* report — interims may precede it.** `reply_to` is cleared *before* the send. A delivery failure (caller workspace unreachable) can't re-fire on the next turn end, and — more importantly — a user who later chats directly in the department workspace never pings the secretary. The secretary can always re-`relay_send` if a report went missing. The only other messages are **interim reports** (below), one per answered turn that another turn follows — they never clear `reply_to`, so they don't consume the final one. The header's `status:` field tells them apart (`still running` vs `completed` / `aborted`).
- **Nested trees report once.** The quiet gate is the same one `tryReportToParent` uses, so a target that fans out three sub-agents delivers exactly one relay report, after the last child bubbles up — not one per child turn end.
- **Full access only.** `session-agent-builder` injects the set only when `nameSet.has('relay_send') && accessLevel === null`. A sandboxed (`workspace` / `readonly`) session can't be given a tool that opens other workspaces' sqlite and session trees; listing the name in such an agent's yaml is silently ignored.
- **Name-gated bundle.** Only `relay_send` is recognised in `tools:`; the other four (`relay_interrupt` / `relay_stop` / `relay_read` / `relay_list`) ride along. Prevents a half-configured agent that can send but never read back / stop. The admin picker mirrors this with one chip (`GET /agent-configs/tools` builds it from `buildRelayTools` against a dummy target and rewrites the description to name the full set).
- **Server only.** `setRelayRegistry` is called once in `index.ts`; the CLI / TUI never call it, so `getRelayRegistry()` is `null` there — every tool returns `{"code": 1, "error": RELAY_UNAVAILABLE}` (`relay.ts`: "relay is not available in the CLI / TUI — it only runs inside halo server", permanent for this runtime, do not retry; send from the admin UI / an IM or Web channel, or open the target with `halo tui -w <workspace path>`) and `deliverRelayReport` logs a warning and returns. No CLI code path knows relay exists. Note the builder does **not** check the registry before injecting, so a CLI / TUI session (and every cron run, which is a `halo cli` child) still *sees* the relay tools when its agent lists `relay_send` — the error is permanent there, not a transient outage; route cross-workspace dispatch through a server-side channel (admin / Web / IM / `halo acp`) instead.
- **Target-side transcript is normal.** The department workspace's session looks like any other root session in its Sessions tab (user message, agent reply); the only trace of relay is the `reply_to` row while a dispatch is pending. Nothing in the target's system prompt changes.
- **Same workspace is allowed.** `workspace` is only checked for existence + `.halo/`; passing the caller's own path makes `getOrCreate` return the caller's own `SessionManager`, and everything else is unchanged. In effect relay is a `query_session` without the own-tree scoping — it reaches any **root** session in any workspace, including new ones. Not a hole: the tool is full-access only, and a full-access agent could already `shell_exec` its way into any session file.
- **Reports come back from roots only.** `deliverRelayReport` fires for `parentId === null`; a sub-session's turn end goes to `tryReportToParent` instead. Dispatching to a `parent>child` id delivers the message but never a report — target roots when you want to hear back. Dispatching to yourself works and terminates (one self-report, `reply_to` cleared) but is pointless.

## Interim report (continue_task)

A busy target that gets a follow-up `relay_send` answers it in a drained turn and, when its original task isn't done, calls `continue_task` — `drainQueue` then runs a resume turn in the **same** `runSession`. Every turn resets `output` / `finalOutput` (`runAgentTurn`'s per-turn reset — `get_session_output`, the session file and the report cap all depend on it), so the final report only carries the LAST turn's wrap-up and any earlier answer is lost. The same loss happens without a kick: two follow-ups in quick succession (the first answered with a plain `end_turn` while the second already sits in the queue), or a follow-up that lands while the **opening** turn is still running.

Fix, at **turn end** in `drainQueue` (after `runAgentTurn` returns, before the kick block — not in `runSession`'s finally): when *another turn follows* (`selfKick && !interruptRequested`, or `messageQueue` non-empty) *and the turn was an answer* (`selfKick` set, or `finalOutput !== ''` — a natural `end_turn`), `SessionManager.sendInterimReport` checks who the batch came from and — **only if the batch just answered contains a relay message** (`text` contains `RELAY_CHANNEL_PREFIX`, no `sourceSessionId`) — calls `deliverRelayInterim(host, sessionId, body)`: read `reply_to` (no-op without one) → append + send into the caller

```
[Relay interim report · workspace <ws> · session <id> · status: still running] This is an interim reply — the session is still working; its final [Relay report] follows when done. Do not treat this as the result.

<answer, capped at limits.autoReportMax>
```

The body is the turn's **whole** text (`session.output`, not `finalOutput`): the response that carries the `continue_task` tool_use has `stopReason === 'tool_use'`, so agent-loop marks its text `final: false` and it never reaches `finalOutput` — reading `finalOutput` would ship only whatever trailing line came after the tool call (or nothing). The tool description asks the model to write its reply *before* calling `continue_task`, but correctness doesn't depend on it.

**Opening turn** (`runSession`'s `hasFirst` turn, `sendOpeningInterim`): same condition (`messageQueue` non-empty at turn end, `finalOutput` set, no `turnError`), but there is no batch to read the door from — the opening message *is* the dispatch — so the owed party is whoever the session reports to at the end: a root with a `reply_to` row → `deliverRelayInterim`; a sub-agent → its parent.

No quiet gate (the session is by definition not done) and **`reply_to` is kept**, so `deliverRelayReport` still fires exactly once when the task ends. Skipped when: no next turn (plain answer with an empty queue → the final report already carries it; esc after `continue_task` → no kick, the run ends, same), the interrupting message was local chat (typed into the department directly — nothing owed to the secretary), the turn errored, or the text is empty. An aborted turn that leaves the queue non-empty produces no interim either (`turnError`); the next turn's end decides. The same hook covers sub-agents (interim to the parent via `querySession`, see [session.md → continue_task](session.md#message-queue-and-drain)).

## Soft vs hard interrupt

`relay_send` to a busy target = queued + soft interrupt (the current tool call finishes, then the message drains as part of one merged turn). That covers follow-ups and corrections — the secretary's default. `relay_interrupt` is for "stop what you're doing *now*": it aborts the in-flight turn (propagates to `shell_exec`, SIGTERMs the process group), then the queued message runs. Idle target → `relay_interrupt` degrades to a plain send (`interrupted: false`). The distinction is the same as `query_session` vs `interrupt_session` inside one workspace; relay just carries it across.

## What it deliberately doesn't do

- **No cross-server reach.** Same `SessionManagerRegistry`, same process. Different server → ACP adapter (`/acp add`).
- **No session discovery beyond a flat root list.** `relay_list` returns a workspace's root sessions (id / agent / title / status, newest 100) so the secretary can reuse an existing conversation; it doesn't walk trees or search transcripts — that's the admin's job.
- **No broadcast / fan-out helper.** The secretary calls `relay_send` once per department; the reports come back individually with the workspace + session id in the header, so it can tell them apart without extra bookkeeping.
- **No ACL beyond full access.** A full-access secretary can reach every workspace on the box — that's the deployment's trust boundary already (it can `shell_exec` into them anyway).
- **No admin UI for the link.** The pending `reply_to` isn't surfaced anywhere; the secretary's own transcript (dispatch tool call → `[Relay report …]` message) is the audit trail.

## Test

`packages/server/test/relay.test.ts` — stub `RelayTarget` + registry, 13 cases: `deliverRelayReport` no-op without `reply_to`, waits while a child is active, delivers exactly one append + one send with the header then clears, `ABORTED` prefix on `turnError`, ignores sub-sessions; `relay_send` creates + stamps `reply_to` + channel-prefixes the model text, rejects a nonexistent workspace; `relay_interrupt` busy → enqueue then abort + re-stamp, idle → no abort and never creates; `relay_list` roots only with title fallback, and defaults to the caller's own workspace. `deliverRelayInterim`: no-op without `reply_to`; delivers the interim header and keeps `reply_to`, the later final report still fires once. End-to-end through `drainQueue` (relay interim → final, no kick → no interim, local message → no interim) lives in `test/continue-task.test.ts`.

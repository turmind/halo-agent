# A2A — cross-server dispatch (A2A v1.0, JSON-RPC)

> Tool reference: [dev/tools.md → A2A tools](../dev/tools.md#a2a-tools). HTTP surface: [dev/api.md → A2A](../dev/api.md#a2a-agent-to-agent). Code: `packages/server/src/a2a/` — `routes.ts` (inbound JSON-RPC handler), `exposure.ts` (path → workspace, token auth, agent card), `tasks.ts` (task store + state machine), `push.ts` (webhook outbox sender), `url-policy.ts` + `http.ts` (egress), `outbound.ts` (remotes, tools, push receiver, reconcile), `files.ts` (image parts), `wire.ts` (wire shapes); `db/a2a-db.ts`; the turn-end / stop hooks live in `agents/relay.ts` and `session-manager.ts`, the opt-in gate in `session-agent-builder.ts`, the mount in `index.ts`.

## Problem

[Relay](relay.md) hands work to another workspace **on the same server**, in-process. Halo↔Halo across servers needs a wire protocol, and A2A v1.0 is the open one: an agent card for discovery, JSON-RPC methods for messages and tasks, webhook push for results. Halo speaks both directions:

- **Inbound** — a workspace that contains `.halo/agent-card.json` is exposed as an A2A agent at `/a2a/<path relative to the base dir>`. A remote caller authenticates with a web-channel token bound to that workspace.
- **Outbound** — an agent that lists `a2a_send` in `tools:` can dispatch to the remotes named in the server-wide `~/.halo/secrets/a2a-remotes.yaml`, and gets the result pushed back as an `[A2A report · …]` message. The same one-dispatch-one-report shape as relay.

**A2A v1.0 only, JSON-RPC binding only.** The spec and the reference SDK treat a request **without** `A2A-Version` as 0.3, so it gets `-32009 VersionNotSupported`. Every 0.3-era client fails, AWS's AgentCore samples (`message/send`, `kind:"text"`) included.

## Concepts and id mapping

| A2A | Halo |
|---|---|
| exposed agent | a workspace dir under the base dir that contains `.halo/agent-card.json` |
| `contextId` | a root session `a2a_<accountId>_<rand>` in that workspace (`ChannelKind 'a2a'`), created by the server; clients never mint one |
| `taskId` | one dispatch = one **`reply_to` cycle** on that session. A follow-up while the task is live folds into it; a message after a terminal task starts a new task in the same session |
| caller identity | a web-channel account (token) bound to that workspace |
| result | Artifact `result` = `finalOutput \|\| output` of the run that closes the cycle |

**`reply_to` is shared with relay.** The column means "this session owes a report to X". Relay stores `{ workspace, sessionId }`; an inbound A2A task stores `{ a2a: taskId }` (`ReplyTo` union in `relay.ts`). Reusing it means the per-turn-end `readReplyTo` already in `deliverRelayReport` covers A2A with no extra read, and relay's quiet gate and interim doors (opening, drain-path, deferred) work unchanged. Last writer wins, as with two relay callers on one session.

## Inbound

### Exposure and URLs

**Base dir:** env `HALO_A2A_ROOT`, else the user's home (`config.a2a.root`), realpath'd once and cached. Workspaces outside it can't be exposed. **Opt-in:** only dirs containing `.halo/agent-card.json` are served — no slug, no registry, no collisions.

The URL is the workspace path relative to the base. `/home/u/A/B` becomes:
- `POST /a2a/A/B` (a trailing `/` is accepted) — JSON-RPC;
- `GET /a2a/A/B/.well-known/agent-card.json` — the card.

**Resolution** (`resolveExposedWorkspace`, runs only after the token is valid, so anonymous probes never touch the filesystem): split the rel path on `/`, percent-decode each segment, refuse an empty / `.` / `..` segment or one carrying `/`, `\` or NUL → `realpath(join(base, rel))` must stay `base + sep + …` (a symlink that leaves the base is "not found") → `.halo/agent-card.json` must be a file → the result must equal `realpath(token.workspacePath)` (win32: case-insensitive, `\` normalized). Every failure is the **same 404**. Cost: two realpaths and one stat per request, uncached — fine at A2A rates.

**The card.** The user writes `name`, `description`, `skills[]` and optionally `version`; `buildCard` fills in the rest:
- `supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]`. The url ends with `/` (the SDK's `new URL('.well-known/…', base)` drops the last segment otherwise).
- `capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: false }`.
- `securitySchemes` `bearer` (`httpAuthSecurityScheme` Bearer) + `xToken` (`apiKeySecurityScheme`, header `x-token`), one `securityRequirements` entry each. Omitted when the mount authenticates upstream (AgentCore).
- `defaultInputModes` / `defaultOutputModes`: `text/plain` + the four image types.
- `version`: the user's, else `HALO_VERSION`.

Served with `Cache-Control: private, max-age=300` and an ETag (304 on match). An invalid or incomplete card file → 500 to the authenticated caller and `[A2A] invalid agent-card.json …` in the log.

**Interface URL:** `general.a2a.public_url` (env `HALO_A2A_PUBLIC_URL` overrides) + `/a2a/<rel>/`. Unset → derived from the request (`Host`, plus `X-Forwarded-Proto` when `general.server.trust_proxy` is on).

### Auth

A web-channel token from `Authorization: Bearer <t>` or `x-token: <t>` — **headers only**; `?token=` counts as missing, since a token in a URL lands in proxy logs. It runs through `resolveTokenAuth(c, db, { headerOnly: true })`, so it shares the `web-token` brute-force bucket with the Web channel, `/api/show/*` and `/api/metrics`.

RPC and card use identical rules: missing token → **401** (before any path resolution, so it reveals nothing); invalid token, unknown / refused path, or a token bound to a different workspace → **404**, indistinguishable; lockout → **429**. The card is deliberately not public: the spec doesn't require it, the peer already holds the token, and a public card would leak the home layout and which dirs are exposed. The cost is that anonymous third-party A2A directories can't discover it; halo's client and the SDK client (`DefaultAgentCardResolver({ fetchImpl })`) both send auth on the card fetch.

**A token is never cross-workspace on A2A** — unlike the Web channel's `workspace` override for full tokens. Its access level applies to the session through `sessionAccess()`: full → full, workspace → workspace, readonly / observer → readonly. One token per caller server is the recommended setup.

**Scoping.** Tasks belong to the account: Get / Cancel / List / push-config calls on another account's task → `-32001 TaskNotFound`; a **full** token sees every A2A task of its own workspace (mirrors the Web channel's `canAddressSession`). A `contextId` must be an existing `a2a_<sameAccount>_*` session, else `-32602` — A2A can never inject into an admin or other-channel session.

### Read-only profile

An inbound A2A session (`a2a_` id) whose stored access level is `readonly` (a readonly **or** observer token) runs a fixed, side-effect-free profile — even when an OS sandbox exists. A readonly session from another channel keeps the bwrap / Seatbelt-contained `shell_exec`; a remote caller does not.

- **Workspace tools:** `file_read`, `view_image` (vision models), `file_list`, `grep`, `glob`. No write / edit, no `shell_exec`, no `web_fetch`.
- **Session tools:** `continue_task` only. No delegation tools and no team roster in the prompt — one predicate (`sessionMayDelegate`) gates both. No goal tools.
- **Kept:** `activate_skill` (only reads SKILL.md).
- **No relay and no a2a tools**, whatever `agent.yaml` lists: a remote's readonly token must not make this server call third parties.
- Reads follow the non-full hidden-path rules unchanged (`~/.halo/secrets`, `~/.ssh`, `~/.aws`, the workspace's `.halo/sessions` and db, …).

Derived from the persistent session id plus the db access level (`isA2AReadOnlySession` in `session-agent-builder.ts`), so it survives restarts and agent rebuilds with no in-memory flag. Full and workspace A2A sessions, and every non-A2A readonly session, keep their normal tool sets.

### Handler

Halo's own thin JSON-RPC handler, not the SDK's `DefaultRequestHandler`. The SDK owns task state through an executor, event bus and TaskStore; halo's is **derived from the session** (run lifecycle, quiet gate, `turnError`, `reply_to`). A spike against the SDK hit pitfalls that all come from that mismatch: a follow-up settles the shared bus and the task sticks at WORKING, a stale snapshot resurrects terminal tasks, CancelTask blocks on the executor, CANCELED is pushed twice, every event is pushed, pushes are never retried. No new dependency.

`createA2ARoutes({ registry, strategies?, ownsRuntimes })` mounts at any prefix; the strategies (`authenticate`, `interfaceUrl`, `tokenAuth`) default to `homeStrategies` (`/a2a` + home-relative paths + web token). `index.ts` mounts it at `/a2a` outside `/api/*` — so the admin cookie middleware never sees it — and before `serveStatic` / the SPA fallback. Not mounted in the CLI / TUI.

Request handling: body ≤ 16 MB (10 MB of images as base64 plus text), else `-32600`; batch arrays → `-32600`; missing or non-`1.0` `A2A-Version` → `-32009`. Responses are HTTP 200 with a JSON-RPC body (`application/json`).

| Method | Behaviour |
|---|---|
| `SendMessage` | Routing below. Text and image parts; any other part → `-32005`. Deduped on `messageId`. Blocks unless `configuration.returnImmediately: true` |
| `SendStreamingMessage` | Same routing, answered as an SSE stream |
| `GetTask` | Row → Task (status, artifacts). `historyLength` is accepted and ignored: no history is tracked |
| `ListTasks` | The account's tasks in this workspace (all of the workspace's for a full token). Filters `contextId`, `status`, `statusTimestampAfter`; `pageSize` default 50, max 100; keyset `pageToken` (base64url `updated_at:id`), `nextPageToken` `""` on the last page; `totalSize`; sorted `updated_at DESC`. Artifacts only with `includeArtifacts: true`, and never with file bytes (see Image parts) |
| `CancelTask` | Idempotent: an already CANCELED task is returned as is; COMPLETED / FAILED → `-32002` |
| `SubscribeToTask` | SSE on a live task; a terminal task → `-32004` |
| `Create/Get/List/DeleteTaskPushNotificationConfig` | Rows in `a2a_push_configs`. Create runs the URL policy and is refused on a terminal task (`-32004`). Delete is idempotent and drops that config's undelivered pushes |
| `GetExtendedAgentCard` | `-32004` |
| anything else | `-32601` |

### Task lifecycle

**SendMessage routing** (`dispatchMessage`). The order makes a refusal impossible once a task row exists:

1. Validate `message` (`role` must be `ROLE_USER` if set), parse parts synchronously (shapes, types, `raw` decode + limits), validate the push config against the URL policy.
2. **messageId dedupe**: a retried send with a known `messageId` returns its task — before any `url` image is fetched.
3. `contextId` must be `a2a_<sameAccount>_*` and exist, else `-32602`.
4. Fetch `url` images, save every image (see Image parts). A fetch or limit failure refuses the send with nothing created.
5. **Dedupe again** — the awaits re-opened the window; from here to `createTask` the code is synchronous, so two concurrent sends with one `messageId` land in one task (the `UNIQUE(workspace, account_id, message_id)` index is the backstop).
6. Pick the task:
   - **`taskId` given** — must be visible and belong to `contextId` (else `-32602`), and live (terminal → `-32004`: send on the context without `taskId` to start a new one). Client-minted ids for new tasks don't exist: an unknown id is `-32001`.
   - **`contextId` with a live task** (`reply_to = { a2a: T }`, T WORKING) — the message folds into T; `updated_at` is bumped.
   - **`contextId` without one** — new task T2 in the same session. A follow-up a few ms after COMPLETED just starts T2; no race.
   - **no `contextId`** — new session `a2a_<accountId>_<base36 time><6 hex>` with the workspace's default agent (`resolveDefaultAgentId`) at the token's access level, description `A2A: <label>`; new task.
7. New task → `writeReplyTo({ a2a: taskId })`; push config stored (one with a URL already on the task is not added twice, so a retried send can't double the pushes). Then `appendUserMessage(text)` + `sendUserMessage('[channel: a2a | account: <id>]\n\n' + text, images)`. A busy session queues it with a soft interrupt; `metadata['halo/interrupt'] === true` on a queued follow-up also calls `interruptSession` (enqueue-then-abort, relay's order, so the finally never fires a spurious completion).
8. If creating the session or sending throws after a **new** task row exists, the task goes FAILED ("Dispatch failed on the remote: … Send again with a new messageId.") and `reply_to` is released, so a `messageId` retry reads FAILED instead of a task stuck at WORKING.

**States.** Every terminal change goes through `transition(taskId, state, fields)`: one guarded `UPDATE … WHERE state = 'working'` (first writer wins) plus the push enqueue in **one** `a2a.db` transaction, then the in-process event hub after commit. Push, GetTask, a blocking waiter and an SSE stream can never disagree.

| State | When |
|---|---|
| `WORKING` | on create; no push for it |
| `COMPLETED` | `runSession`'s finally → `deliverRelayReport`, under its quiet gate (root, no active children, empty queue), `turnError` null |
| `FAILED` | the same hook with `turnError` set: `status.message` = "The last turn was terminated by an unrecoverable error, NOT completed. Error: … ", plus `metadata['halo/errorKind']: 'account'` and a "re-sending will fail the same way" hint for account errors. Also the dispatch-failure and restart cases |
| `CANCELED` | CancelTask, or a local stop / delete / archive of the session |

**Completion hook.** `deliverRelayReport` branches on `{ a2a }` right after the quiet gate: `completeTask` (terminal row + push) first, then `clearReplyTo`. A crash between the two re-fires at the next turn end, where the guarded UPDATE is a no-op. A `reply_to` naming a task that isn't in **this** server's `a2a.db` is left alone (dev and prod share workspace sqlite but not `a2a.db` — clearing would strand the owner's task at WORKING).

**Cancel is explicit.** `stopSession` aborts, awaits, then stamps `stoppedAt` — its turn end sees `turnError` null and would report COMPLETED. So:
- CancelTask writes CANCELED ("Canceled by the caller."), releases `reply_to`, then calls `stopSession` **fire-and-forget** — Cancel never blocks on the turn unwinding.
- `stopSession`, `stopUserSession` (admin Stop), `deleteSession` and `archiveSession` start with `cancelA2AForSession(id, reason)`: if `reply_to` holds an `{ a2a }` task this server owns → CANCELED ("Stopped / Session deleted / Session archived on the remote side.") and cleared. An interrupt (esc) never cancels — the turn end completes the task.

**Interims.** `interimDoor` also opens on `A2A_CHANNEL_PREFIX` (`[channel: a2a | `). `deliverRelayInterim` branches on `{ a2a }` → `interim(taskId, body)`: a WORKING status with the answer as its message, pushed once per answer (event key `interim:<n>`, `interim_seq` counter), `reply_to` kept. One interim per answered follow-up, exactly one terminal state.

**Restart.**
- A server that owns workspace runtimes (prod): the [run-ledger](session.md#run-ledger--restart-nudge-for-interrupted-roots-haloglobalrunsdb) nudge resumes interrupted roots; `reply_to` survived, so the resumed run's finally completes the task.
- A non-owner (dev, `HALO_BADGE=DEV`) gets no nudge, so every task read (GetTask, ListTasks, SendMessage, SubscribeToTask, CancelTask) applies a **lazy rule** (`reconcileStale`): WORKING, untouched since this process booted, session idle (not running, not compacting, empty queue, no active children) → FAILED "Interrupted by a server restart on the remote. Send again on the same context to resume." The caller's boot reconcile triggers exactly this read.

**Artifacts.** COMPLETED: `result` = the full `finalOutput || output`, uncapped (the caller caps). FAILED / CANCELED: whatever output exists, as `partial`.

### Blocking and streaming

**Blocking** (SendMessage without `returnImmediately: true`): after dispatch, wait on an in-process waiter resolved by the hub's terminal event, bounded at **10 min** (`BLOCKING_WAIT_MS`). On timeout the current Task (WORKING) is returned — a deliberate deviation from "MUST block"; the client continues with GetTask / SubscribeToTask. A client disconnect drops only the waiter; the run continues, since state lives in the session and `a2a.db`.

**SSE** (SendStreamingMessage, SubscribeToTask; `streamTask`, `hono/streaming`):
1. `{ task }` snapshot first (a task already terminal closes here);
2. `statusUpdate` events for interims;
3. `artifactUpdate` chunks of a **`progress`** artifact (`append: true` after the first, `lastChunk: false`) carrying the root session's live `stream_delta` text — not persisted, and not the result: deltas cover every turn of the run, while `result` is the last turn's final text;
4. the terminal `{ task }` (= GetTask, with the `result` / `partial` artifact), then close.

A `: keepalive` comment every 15 s. A dropped client only unsubscribes, so the SDK's "stream drop → task stuck WORKING" can't happen. On the receiving side halo's `a2a_read` / reports ignore a `progress` artifact.

## Push delivery and URL policy

**Outbox** (`a2a_push_outbox`): rows `UNIQUE(task_id, config_id, event_key)` with event key `state:<terminal>` or `interim:<n>`, written in the same transaction as the state change — pushes go out on transitions only, deduped. Payload: `{ task: <snapshot without file bytes> }` for terminal (file parts counted in `halo/omittedFiles`, see [Image parts](#image-parts)), `{ statusUpdate }` for interim. Headers: `Content-Type: application/a2a+json`, `A2A-Version: 1.0`, `Authorization: <scheme> <credentials>` when the config has `authentication`, `X-A2A-Notification-Token: <token>` when it has `token`.

**Sender** (`push.ts`, process-local, event-driven): one `setTimeout` armed for `MIN(next_at)`, re-armed on every enqueue and at boot — no interval. Concurrency 4, timeout 15 s. A row is leased (`next_at` pushed out) before its request so the timer can't spin on an in-flight row; a crash lets the lease expire and the row retries after restart. 2xx deletes the row; 4xx other than 408 / 429, or a URL-policy refusal at send time, marks it `dead` at once; anything else retries at `5 s · 2^(n-1)` capped at 10 min, ±20 % jitter, until 10 attempts or 24 h (1 h in AgentCore mode), then `dead`. Dead rows are kept 7 days. Runs on every server, dev included — each server has its own `a2a.db`. `hasPendingPushes()` feeds the AgentCore busy signal.

**URL policy** (`url-policy.ts`) — applied to push URLs at create **and** at send, to inbound `url` image parts, and to every outbound card / RPC URL:
- `http` / `https` only, no userinfo.
- `http.ts` sends through `node:http(s).request({ lookup: guardedLookup })`: every resolved IP is checked **inside** the lookup, so the checked address is the connected one (no DNS-rebinding gap). An IP literal is checked up front. Redirects are not followed.
- **Always refused**, even when listed: link-local (`169.254.0.0/16` incl. the metadata IP, `fe80::/10`), multicast, unspecified.
- Each IP must be public **or** inside a listed CIDR; private, loopback and CGNAT ranges are refused unless listed.
- https is fine anywhere allowed; plain http only when the host matches a listed host pattern or every IP is inside a listed CIDR.
- `general.a2a.url_allowlist` (global-only), comma-separated CIDRs / bare IPs / host patterns (`*.ts.net` = any subdomain). Default `100.64.0.0/10,*.ts.net` — tailnet only. **Loopback is not in the default**: a push URL is caller-supplied, and a loopback entry would let any token holder aim webhooks (and outbound fetches) at services on the server's own host. Same-host traffic goes through relay. `127.0.0.0/8` opens v4 only; `::1` needs `::1/128`.
- A refused push URL → `-32602 "push url not allowed: <reason>"` at create, a `dead` row at send.

## Outbound

### Remotes

`~/.halo/secrets/a2a-remotes.yaml` — one list for the whole server (`remotesFile()` in `outbound.ts`), read on every call, so an edit takes effect without a restart. Edit it from a full session or the terminal; there is no admin UI, and the admin file explorer's absolute-path routes hide `~/.halo/secrets` too. There is no per-workspace file: a `<ws>/.halo/a2a-remotes.yaml` is not read.

```yaml
remotes:
  halo-test:
    card: http://myhost.tailnet.ts.net:9527/a2a/halo-test/.well-known/agent-card.json
    auth: bearer            # bearer (default) | sigv4 (an AgentCore runtime)
    # push_base: http://172.31.7.121:9527   # optional; overrides general.a2a.public_url for this remote's webhooks
```

The bearer token is the settings secret `a2a.secrets.<remote>` (`getServerSecret('a2a', name, ws)`: the workspace `settings.yaml` overrides the global one; `<<ENV>>` placeholders work), resolved at call time so it never enters a prompt. **When non-full sessions use the tools, keep it in the global `~/.halo/secrets/settings.yaml`**: a workspace / readonly session can read `<ws>/.halo/settings.yaml` (it is readable workspace knowledge), but `~/.halo/secrets` is hidden from it. `auth: sigv4` signs instead — see [AgentCore](#agentcore).

**The list is full-only.** A remote's `card:` decides where its token is sent, on the card fetch and on every RPC. A session that could edit the list could point a remote at a host it controls (public https passes the URL policy) and collect the token from the next `a2a_send`, made by any session. So the list lives under `~/.halo/secrets`, which is in the built-in hidden dirs: bwrap, seatbelt and `assertPathAllowed` mask it from workspace / readonly sessions, whether the file exists or not. Those sessions use the remotes only through the tools. Every workspace's `a2a_list` shows the same list.

**Client.** The card is fetched with auth and cached in-process for 5 min; it must offer a `JSONRPC` + `1.0` interface, whose url is used for RPC. Requests carry `A2A-Version: 1.0` and the auth header, re-signed per attempt, with a 30 s timeout each. JSON-RPC errors are read **on any HTTP status** (AgentCore answers with real status codes). `send()` retries two answers, each on its own schedule:
- AgentCore `-32054` RetryableConflict ("… please retry"; the microVM is being provisioned or torn down) after 0.5 / 1 / 2 / 4 / 8 s. The plain ConflictException shares the code and is not retried.
- **Lease busy** — `-32603` whose message starts with "workspace is in use by another runtime session" (a halo AgentCore container whose workspace lease another microVM still holds) after 5 / 10 / 15 / 20 s — 50 s in all, past the 45 s after which an idle-exited holder's lease goes stale. The prefix must match `LEASE_BUSY` in `agentcore.ts`.

Each schedule exhausted → the last answer is returned. The tool call's cancel signal ends the wait at once — on the card fetch as well as the RPC — so a stopped turn never sits out the backoff. A plain `-32603` is not retried.

### Tools

Opt-in by the single name `a2a_send` in `agent.yaml` `tools:`; it brings `a2a_stop`, `a2a_read` and `a2a_list` with it (`buildA2ATools`). **Available at every access level** — full, workspace and readonly sessions of any channel — **except the A2A read-only profile** above. Relay, which reaches into other workspaces' sqlite, stays full-only. The admin tool picker shows one `a2a_send` chip naming the set.

- `a2a_send { remote, message, context_id?, interrupt?, files? }` → SendMessage with `returnImmediately: true` and a push config `{ url: <push_base | public_url>/a2a-push/<pushId>, token: <32 random bytes> }`; returns `{ code: 0, remote, context_id, task_id, state, follow_up }` at once. A follow-up on a `context_id` with a pending dispatch reuses its push id and token, so the remote dedupes the config by URL and the report comes once. No `general.a2a.public_url` and no `push_base` → a tool error (the remote needs somewhere to push).
- **`files` is sandboxed by the caller's access level**, like a channel's `MEDIA:` send (`refusedPath`): absolute; for a non-full session, under the workspace or the OS temp dir — the path **and** its realpath, so a symlink inside the workspace pointing outside is refused. Then the image rules: a vision type by extension and by sniffed bytes, ≤5 MB each, ≤10 MB total. Any violation is a tool error and nothing is sent. Each file becomes a `{ raw, mediaType, filename }` part after the text.
- `a2a_stop { remote, task_id }` → CancelTask; the canceled report still arrives.
- `a2a_read { remote, task_id }` → GetTask: `{ state, status, result }` with the full, uncapped result text (images saved again on each read). **It is the way to check on a task**: the tool description tells the agent to call it once when the user asks how a dispatched task is going or a report seems overdue — never in a loop.
- `a2a_list {}` → the configured remotes (card name, description, skills) plus this workspace's pending dispatches (newest 50).

**Server only.** `index.ts` sets the a2a db and the outbound registry; the CLI / TUI (and every cron run, a `halo cli` child) don't, so every call there returns the permanent `A2A_UNAVAILABLE` error ("… only runs inside `halo server`, which receives the remote agent's push reports … do not retry"). As with relay, the builder doesn't check this before injecting: the tools are still listed there.

### Webhook receiver

`POST /a2a-push/:pushId` — outside `/a2a`, so it can't collide with a workspace path; no admin cookie, no web token. Look up the dispatch rows by push id; compare the presented token (`X-A2A-Notification-Token`, or `Authorization: Bearer`) with `timingSafeEqual` — unknown id or mismatch → 404. The payload's task id (`task.id` or `statusUpdate.taskId`) must be one of the push id's dispatches (spec MUST) → else 404.

**A push is only a doorbell.** Past that gate, the push body is ignored: its state, status text and artifacts are never read. The content delivered comes from our own authed `GetTask` (bearer or SigV4, per remote), so a leaked push token can make us run a harmless GetTask, never inject text.

- **Already reported.** If the dispatch row is no longer `working`, answer `{ ok: true }` without a fetch.
- **Fetch before acking.** Run GetTask with an overall 10 s deadline (`DOORBELL_DEADLINE_MS`), which is under the push sender's 15 s timeout. The abort signal ends any retry wait; a request still in flight past the deadline is abandoned.
  - **Failure** (network, timeout, HTTP or JSON-RPC error, remote no longer configured): answer **503**, deliver nothing, and log `[A2A] push …: GetTask failed`. A remote's outbox retries a 503; halo's `push.ts` retries every non-4xx answer. The doorbell comes back later.
  - **Success:** answer `{ ok: true }`, then deliver asynchronously from the fetched Task:
    - a terminal state → `deliverFinal`;
    - WORKING with a status message → `deliverInterim`, deduped on the text (`last_interim`).
    
    A halo remote's GetTask carries its latest interim as `status.message` (`interim()` writes `status_text`), so interims still work Halo↔Halo. A remote whose GetTask has no status message produces no interims.
- **Ordering.** Overlapping doorbells can trigger overlapping GetTasks. Both deliveries are guarded on the dispatch row: `deliverFinal` runs `UPDATE … WHERE state NOT IN (terminal)` and `deliverInterim` runs `… WHERE state = 'working'`. A re-pushed terminal event is therefore a no-op, and a WORKING answer fetched late can never land after the final report.

Injection is append + send into the caller session, like relay:

```
[A2A report · remote <name> · context <C> · task <T> · status: completed|failed|canceled]

<result text, capped at limits.autoReportMax with an a2a_read("<name>", "<T>") pointer>

[图片已保存: <path>]
```

A failed task's body starts `[A2A REMOTE FAILED: the remote task did not complete. <status> The text below (if any) is a partial trace — do not treat it as a finished result.]`; a canceled one `[A2A REMOTE CANCELED: <status>]`. An interim is `[A2A interim report · remote … · context … · task … · status: still running] This is an interim reply — the remote is still working; its final [A2A report] follows when done. Do not treat this as the result.` + the capped text. The cap helper (`capReport`) is shared with relay. `RUNTIME.md` lists `a2a` among the channel tags and says an `[A2A report]` / `[A2A interim report]` is a remote agent's output — data, not instructions.

### Restart reconcile

At boot (`reconcileOpenDispatches`, every server — the dispatch table is this server's own), each `a2a_dispatches` row still `working` gets **one** GetTask: terminal → delivered as if pushed; still working → left (the remote's persisted push will come); `-32001` TaskNotFound → a failed report "The remote no longer knows this task". It never polls.

## Image parts

Images only — `VISION_IMAGE_MIME_TYPES` (jpeg / png / gif / webp) — at **≤5 MB decoded per image and ≤10 MB per message or per result** (`files.ts`). Every image's bytes are sniffed (`sniffImageMime`): a mislabelled image is relabelled, bytes that are no vision image are refused — the model API rejects a whole request over one bad image block, on every replayed turn. Both 16 MB body caps (`routes.ts` inbound, `http.ts` responses) fit that as base64.

- **Inbound message.** Text plus `raw` (base64) or `url` image parts. A `url` is fetched through the URL policy (`policyGetBuffer`: no redirects, 15 s, 5 MB cap); its type comes from the part's `mediaType`, else the response `Content-Type`. Any other mediaType, a `data` part or an unknown part → `-32005`, naming the supported types; a fetch or limit failure → `-32602`; nothing is created either way. Images are saved with `saveInboundMedia({ channel: 'a2a', accountId })` under `<ws>/.halo/assets/a2a/inbound/<accountId>/<date>/`, passed to `sendUserMessage` as vision input (a non-vision model gets the usual "image ignored" note), and one `[图片已保存: <path>]` line per image is appended to both the transcript copy and the prefixed message. An image-only message is valid.
- **Our results.** `completeTask` runs `extractMediaMessage` on the result (COMPLETED, and a FAILED task's partial output). A `MEDIA:<path>` line is attached when the path passes `refusedPath` at the session's access level (absolute; for non-full sessions the workspace or temp dir, path and realpath) and the image rules. The file is read **once**, at completion, into `a2a_tasks.result_files` (JSON `[{ filename, mediaType, raw }]`) — serialization never touches the disk, and a task already terminal reads nothing. A refused path leaves a `[file not attached: <name> — <reason>]` line; marker lines are stripped from the stored `result`. GetTask, the blocking response and the final SSE Task carry the files. **The push payload and ListTasks never inline file bytes**: the terminal push is enqueued with `taskJson(row, true, false)`, so a ~13 MB result isn't copied into every `a2a_push_outbox` row (one per config per event), and ListTasks' SELECT skips the column. In both, the text and status stay, the file parts are dropped and counted in `metadata['halo/omittedFiles']`, and a receiver that wants the images calls GetTask. Halo's own receiver GetTasks on every push anyway (a push is a doorbell). The `send-file` skill's `a2a.md` tells the agent this.
- **A remote's result** (report and `a2a_read`): each `raw` image part is saved under the caller workspace's `.halo/assets/a2a/inbound/<remote name>/…` and listed as `[图片已保存: <path>]`; a `url` part is listed as `[图片: <url>]` and never downloaded; a non-image or oversized part gets `[file not saved: <name> — <reason>]`. These lines go **after** the cap, so a truncated report never hides a saved path. The report stays text only — the agent can `view_image` the path.

```jsonc
// inbound message part
{ "raw": "<base64>", "mediaType": "image/png", "filename": "chart.png" }   // or { "url": "https://…/chart.png", "mediaType"?: … }
// result artifact
{ "artifactId": "result", "name": "result", "parts": [
  { "text": "Here it is." },
  { "raw": "<base64>", "mediaType": "image/png", "filename": "chart.png" } ] }
// the same artifact in ListTasks (includeArtifacts: true)
{ "artifactId": "result", "name": "result", "parts": [{ "text": "Here it is." }], "metadata": { "halo/omittedFiles": 1 } }
```

## Storage — `~/.halo/global/a2a.db`

Global rather than per-workspace `halo.db`: the boot jobs (outbox resume, outbound reconcile) scan across workspaces, like `evo.db` / `cron.db` / `runs.db`. Raw better-sqlite3 statements (every write is a guarded UPDATE or an `INSERT OR IGNORE`), WAL, migrations in `A2A_MIGRATIONS` (v1 added `result_files`; `CREATE_SQL` has the full shape, so the slot is a no-op on a fresh db). It holds peers' push tokens, so `a2a.db` + `-wal` / `-shm` are in the built-in sandbox hidden files. The terminal write and `clearReplyTo` are two databases and not atomic; they're ordered to stay idempotent (Completion hook above).

```sql
a2a_tasks(id PK, workspace, context_id, account_id, message_id, state, status_text, error_kind, result,
          result_files, interim_seq, created_at, updated_at)
          -- idx (workspace, updated_at DESC, id DESC), (workspace, context_id),
          -- unique (workspace, account_id, message_id) where message_id not null
a2a_push_configs(task_id, id, url, token, auth_scheme, auth_credentials, created_at, PK(task_id, id))
a2a_push_outbox(id PK autoincrement, task_id, config_id, event_key, payload, attempts, next_at, last_error, dead,
                created_at, UNIQUE(task_id, config_id, event_key))      -- idx (dead, next_at)
a2a_dispatches(id PK, workspace, session_id, remote, push_id, push_token, rpc_url, remote_task_id,
               remote_context_id, state, last_interim, created_at, updated_at)
               -- idx (push_id), (state), (workspace, remote, remote_context_id)
```

`getA2ADb()` is null outside `halo server` (CLI / TUI / cron child), which every A2A entry point treats as "unavailable here".

## AgentCore

`halo agentcore` runs the same handler as an Amazon Bedrock AgentCore Runtime container: `createA2ARoutes` mounted at `/` on one fixed workspace with "upstream" strategies (AgentCore verifies the caller's SigV4-signed request; caller `agentcore` at `HALO_A2A_ACCESS`, card without `securitySchemes`), `a2a.db` at `<ws>/.halo/a2a.db` on EFS, a heartbeat lease admitting one microVM at a time, push give-up at 1 h, no push receiver and no outbound registry (so `a2a_send` is unavailable inside the container). A halo caller reaches it with a remote of `auth: sigv4` — a fixed runtime session id per (caller workspace, remote) and the `-32054` / lease-busy retries above. Everything else: [design/agentcore.md](agentcore.md).

## Known limitations

- **Nothing wakes a waiting caller.** Delivery is event-driven: a push, or the boot reconcile. If a push never arrives (receiver unreachable past the remote's retries, our doorbell GetTask failing until the remote's sender gives up, remote lost the task without a terminal push), the caller agent just doesn't hear back — there is no timer. `a2a_read` on demand is the check.
- **A push that beats the dispatch row is refused.** `a2a_send` writes its `a2a_dispatches` row only once SendMessage has answered. A push arriving before that — the remote finished (or, on a reused webhook, started and finished a new task) faster than the caller processed the answer — gets 404, which a sender treats as permanent. The window is narrow: the insert runs synchronously right after the answer is parsed, and a terminal SendMessage answer is delivered directly. A push that is lost this way leaves the row `working` until the next boot reconcile GetTasks it; until then, `a2a_read` is the only check.
- **Interims need the remote's GetTask to carry them.** The receiver reads interims only from the fetched `status.message`. A non-halo remote that pushes interims only in `statusUpdate` bodies produces no interim reports; its final report is unaffected.
- **No task history.** GetTask accepts `historyLength` but returns no `history`; the session transcript on the remote is the record.
- **Server only.** The CLI / TUI and cron runs (a `halo cli` child) can't use the tools — no push receiver there; every call returns `A2A_UNAVAILABLE`.
- No non-image file parts and no `data` parts (`-32005`); no client-chosen `contextId`s; no `GetExtendedAgentCard`; no 0.3 compatibility. No admin UI for remotes or their secrets.

## Tests

`packages/server/test/a2a-*.test.ts`:
- `a2a-units.test.ts` — URL-policy matrix (tailnet default, loopback only when listed, link-local always refused, `*.ts.net` subdomains), exposed-workspace resolver (traversal, empty segments, symlink-out, win32 separators / case), card fill-in, push verdict + backoff, the transition guard (first terminal writer wins, one push per config + event), interims, `finalOutput || output`, ListTasks keyset paging.
- `a2a-session.test.ts` — through real session runs: interrupt → answer → `continue_task` (one interim, one COMPLETED), plain turn end, esc never cancels, `stopSession` / admin Stop → CANCELED that the abort's turn end can't overwrite; the lazy-FAILED rule (non-owner fails an idle orphan, owner leaves it); version gate and card 404.
- `a2a-fixes.test.ts` — the push sender doesn't spin on an in-flight row; a throw after `createTask` fails the task; a refused push URL creates nothing; concurrent sends with one `messageId` land in one task; a `reply_to` naming another server's task is left alone.
- `a2a-readonly-profile.test.ts` — the read-only profile's tool set and prompt (no a2a / relay, no roster) and its restart survival; workspace A2A sessions and readonly sessions of every other channel get the a2a set but not relay; hidden-path masking.
- `a2a-files.test.ts` — inbound image parts (raw, url, relabel, dedupe without refetch, limits, `-32005`), result `MEDIA:` attachment (sandbox incl. symlinks, limits, partial, already-terminal), push payload and ListTasks without file bytes (`halo/omittedFiles`) vs GetTask with them, the `result_files` migration, `a2a_send` files (rules, access-level sandbox), report / `a2a_read` image saving, lease-busy retry (schedule, give-up, no retry on a plain `-32603`, conflict schedule independent, cancel), and Stop ending a retried card fetch in `a2a_send` / `a2a_read` / `a2a_stop`.
- `a2a-push-doorbell.test.ts` — the push receiver as a doorbell: fake push content is ignored and the GetTask result is delivered; the gate (token, push id, task id) runs before any GetTask; a failed GetTask (HTTP, JSON-RPC, network) → 503 with nothing delivered; an interim via GetTask, deduped; a late-fetched WORKING never lands after the final; a halo remote's GetTask carries its latest interim.
- `a2a-agentcore.test.ts` — the AgentCore mode (lease, upstream exposure, `/ping`), outbound SigV4 and the `-32054` retry.

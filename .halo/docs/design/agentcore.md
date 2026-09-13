# AgentCore Runtime Mode

Halo server as an **Amazon Bedrock AgentCore Runtime** container — a fourth
way to run halo (server / CLI / desktop / AgentCore). One env var flips it:
`HALO_RUNTIME_MODE=agentcore`. Demo package: `packages/agentcore-demo/`
(Dockerfile, chat frontend, CDK stack, auth Lambdas — its README carries the
operational gotchas; this doc covers how the mode works inside the server).

```
Browser (static frontend, S3 + CloudFront)
   │  /api/login, /api/verify  → CloudFront /api/* behavior → API GW → auth Lambda (DDB users, JWT)
   │  /api/ws-presign          → presign Lambda (SigV4-signs the AgentCore WS URL)
   │  wss (presigned URL, 5-min TTL)
   ▼
AgentCore Runtime (per-session microVM, auth terminated here)
   │  X-Amzn-Bedrock-AgentCore-Runtime-Session-Id = user UUID
   ▼
halo server :8080  (HALO_RUNTIME_MODE=agentcore)
   ├── GET  /ping          Healthy | HealthyBusy (any running agent session)
   ├── POST /invocations   {"input":{"prompt"}} → full assistant message
   └── WS   /ws            streaming frames (primary path)
```

## What the mode changes (packages/server/src/index.ts)

`config.server.runtimeMode === 'agentcore'` (env `HALO_RUNTIME_MODE`) skips:

- **Password/JWT gate** — AgentCore terminates auth upstream (SigV4 presign /
  OAuth); the container is only reachable through the runtime.
- **Single-instance lock** — one microVM per session; many server processes
  coexist by design.
- **Channels, cron, evolution, archive daemon** — meaningless in an ephemeral
  per-session microVM; sessions are driven only through the AgentCore surface.

Everything else (agent loop, tools, skills, sqlite persistence) is the normal
server. The adapter itself is `packages/server/src/routes/agentcore.ts`,
mounted at the root (the AgentCore contract paths live outside `/api`).

## Per-user workspace isolation

`userWorkspace(base, runtimeSessionId)` maps each runtime session id to
`<HALO_WORKSPACE>/users/<sanitized-id>/` — an isolated workspace with its own
`.halo/` (sqlite + session files). The id chain:

DDB `agentcore-demo-users` UUID → login response → frontend uses it as
sessionId → presign Lambda signs it into
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` → adapter routes the workspace.

So **1 user = 1 runtime session id = 1 workspace**: users never see each
other's history; reconnecting with the same id resumes the same conversation.
`HALO_WORKSPACE` points at an EFS mount (`/mnt/efs`) — microVMs are ephemeral,
EFS makes the workspaces survive session termination and image rollouts.
`~/.halo/global/runs.db` (the [run ledger](session.md#run-ledger--restart-nudge-for-interrupted-roots-halo-globalrunsdb)) lives under the container's `HALO_HOME`, which is **not** on EFS — it dies with the microVM, so the restart nudge doesn't apply in agentcore mode (the writes themselves are harmless, just moot).

## WS protocol quirks (why /init exists)

The AgentCore WS proxy only forwards **client frames containing `inputText`**
and cannot push server frames on connect. Hence:

- Frontend sends `{"inputText":"/init"}` after open; the server special-cases
  it (also accepts `{"type":"init"}`) and replies with a `history` frame —
  a full snapshot, which the frontend renders by rebuild-from-scratch (not
  append), keyed by a signature so identical snapshots skip re-rendering.
- Frames without `inputText` are silently ignored server-side — the frontend
  uses `{type:'ping'}` every 30s purely to keep the proxy from cutting the
  socket.
- `/session switch` sends a `{type:'switch'}` frame → frontend clears, then
  the follow-up history frame rebuilds.

Slash commands run through the shared `dispatchCommand` with a module-level
`activeOverrides` map keyed by **`runtimeSessionId`** (one entry per runtime
session, holding "which halo session is this socket's current one"). The entry
lives only as long as the socket: `ws.on('close')` deletes it alongside the event
listener, since a reconnect re-resolves from the session id anyway — without the
delete the map grew one permanent entry per runtime session for the container's
whole lifetime (audit B-L3). Every command is `accessLevel: 'full'` by design:
auth terminated upstream at AgentCore, so whoever reached this socket already
owns the isolated per-user workspace behind it.

## WS image upload protocol (chunking)

The AgentCore WS proxy hard-caps a single frame at **64KB** — send more and
the connection is cut with close code 1009 ("Policy violated: message size
limit of 64 KB for a message frame is exceeded", verified against the Tokyo
prod runtime). An inline base64 image blows past that instantly, so images
ride as chunked `image_chunk` frames, assembled server-side, then referenced
by id from the actual message frame:

```jsonc
// 1..N chunk frames per image (inputText empty string is required — the
// proxy only forwards client frames that carry an inputText key at all)
{"inputText":"", "type":"image_chunk", "uploadId":"u1", "seq":0, "total":8,
 "mimeType":"image/jpeg", "data":"<base64 slice, ≤48KB>"}

// message frame referencing the finished upload(s)
{"inputText":"describe this", "imageRefs":["u1"]}
```

Limits (all enforced in `acceptChunk` / `claimImageRefs`): ≤4 images per
message, ≤8MB of base64 per image, ≤4 concurrent pending uploads per
connection, ≤256 chunks per upload. Assembly state (`Map<uploadId,
PendingUpload>`) is **per-connection, in-memory only** — a dropped socket
discards any partial uploads and the client just re-sends; there is no
cross-reconnect persistence by design. The server doesn't ack individual
chunks (that'd add N round-trips for no benefit since the proxy forwards
mid-stream frames fine) — it only replies with an `error` frame when a chunk
or `imageRefs` fails validation.

On a completed reference, the image is decoded and persisted via
`saveInboundMedia` into the user's workspace — the same storage path
telegram uses — and the message text gets a `[图片已保存: <path>]` marker
appended so history replay can show the image was there without re-sending
the bytes.

## Session lifecycle (the part everyone gets wrong)

- Idle timeout (`idleRuntimeSessionTimeout`) terminates a session whose
  `/ping` reports `Healthy`; `maxLifetime` (8h) force-terminates even busy
  ones; failed health checks kill immediately.
- **An open WebSocket = an in-flight invocation** — the session never counts
  as idle while a socket is open. The 30s frontend keepalive therefore keeps
  the whole session warm; effective idle timeout ≈ "after the tab closes".
- `/ping` returns `HealthyBusy` whenever any agent session is running
  (`registry.list().some(sm => sm.hasRunningSessions())`) — the official
  keep-alive for long tool chains with no open connection.
- Termination is cheap: data is on EFS, next connect cold-starts (~3s) and
  history reloads. `stop-runtime-session` kills one session on demand; there
  is **no list/get-runtime-sessions API** (observe via CloudWatch `Sessions`
  metric + runtime log filtering).

## Ops crib sheet

- CloudWatch logs capture container **stdout**; halo's logger drops
  sub-threshold lines before stdout — set `HALO_LOG_LEVEL=info` or the log
  group stays near-empty.
- `update-agent-runtime` **replaces the whole config** — omit
  `--filesystem-configurations` and the EFS mount silently disappears.
  Fetch-modify-send, and strip `requireServiceS3Endpoint` (rejected on
  newer runtimes).
- VPC mode has no public IP: private subnets need `0.0.0.0/0 → NAT` or all
  egress (Bedrock included) hangs → opaque 502s.
- Full operational detail + deploy walkthrough:
  `packages/agentcore-demo/README.md`.

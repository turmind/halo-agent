# API Routes

All REST endpoints are served by Hono on port 9527 at `/api/`.

Auth: every `/api/*` route (except `/api/auth/*`) requires a valid JWT cookie (`halo_token`).

## Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check — returns `{status, timestamp, uptime, engine}` |

## Authentication

File: `packages/server/src/middleware/auth.ts`

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Password login, returns a JWT cookie |
| POST | `/api/auth/logout` | Clears the auth cookie |
| GET | `/api/auth/check` | Validates the current token; refreshes stale tokens |

## Files

File: `packages/server/src/routes/files.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/files/tree?projectId=[&path=]` | List one level (lazy). Every directory carries `hasChildren`. No `path` = project root. |
| GET | `/api/files/search?projectId=&q=[&limit=][&dirsOnly=1]` | Recursive name search. Default limit 200, max 1000. Scans up to 50000 entries then truncates; returns `{matches, truncated}`. `dirsOnly=1` matches directories instead of files (powers the chat `@scope` directory completion). |
| GET | `/api/files?path=&projectId=` | Read file content (max 10 MB) |
| GET | `/api/files/stat?path=&projectId=` | Lightweight mtime + size |
| GET | `/api/files/diff?path=&projectId=` | Git diff |
| GET | `/api/files/download?path=&projectId=&inline=` | Download or inline-preview — streams the file (no full read into memory), supports `Range` (206 Partial Content) so `<video>`/`<audio>` can seek + partial-load; aborts the read if the client disconnects |
| PUT | `/api/files` | Save file (body: `{path, content, projectId}`) |
| POST | `/api/files/new` | Create empty file |
| POST | `/api/files/mkdir` | Create directory |
| POST | `/api/files/rename` | Rename / move |
| POST | `/api/files/upload` | Multipart upload |
| DELETE | `/api/files?path=&projectId=` | Delete file or directory (recursive) |

All file operations validate the path stays inside the project root (prevents path traversal). One exception: `GET /api/files/download` also accepts absolute paths under `/tmp/` so that agent-produced working files (e.g. Playwright screenshots) can be inline-previewed from chat media chips.

### Filesystem browse (not project-scoped — for the workspace picker)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/fs/home` | Returns server `homedir()` — fallback when the frontend has no `?folder=` URL param. Returns `{ home }`. |
| GET | `/api/fs/exists?path=/abs` | Validates an absolute path exists and whether it's a directory. Returns `{exists, isDirectory?}`. |
| GET | `/api/fs/browse?path=/abs` | Lists immediate directory children (hidden ones dropped). Returns `{path, parent, entries: [{name, path}]}`. |

Absolute paths only. Purpose: Explorer's workspace picker and switching validation. Reading/writing files still goes through `/api/files/*` and remains project-sandboxed.

## Session Logs (unified)

File: `packages/server/src/routes/sessions.ts`

Unified session log API — list + read session files across all agents.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions/logs?projectId=` | List session metadata, keyset-paginated. Default returns each top-level row + all descendants (sidebar tree); `rootOnly=1` returns roots only (chat-header dropdown) |
| GET | `/api/sessions/logs/:id?projectId=` | Full session log (scans across agent dirs) |
| DELETE | `/api/sessions/logs/:id?projectId=` | Delete the session log |

The list endpoint returns flat metadata (id / agentId / agentName / title / timestamps / messageCount / parentSessionId / stoppedAt / contextTokens / totalOutputTokens). The frontend builds the tree from `parentSessionId`.

The get endpoint returns the full session file. If only `rawMessages` is present (no event-log `messages`), `convertRawMessages()` transforms it into display format on the fly.

### Legacy DB sessions

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions?projectId=` | List sessions (DB, legacy) |
| GET | `/api/sessions/:id` | Full session (DB, legacy) |
| DELETE | `/api/sessions/:id` | Delete session (DB, legacy) |

## Weixin Channel

File: `packages/server/src/routes/weixin.ts`

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/weixin/login/start` | Start the QR login flow, returns `{qrcodeUrl, sessionKey}` |
| POST | `/api/weixin/login/wait` | Poll QR status. body: `{sessionKey, workspacePath, label?, language?}`; on success the account is inserted and long-polling starts |
| GET | `/api/weixin/accounts` | List every bot account |
| PATCH | `/api/weixin/accounts/:id` | Change label / workspacePath / enabled / accessLevel / language |
| DELETE | `/api/weixin/accounts/:id` | Stop long-polling and delete the DB row |

See [design/wechat.md](../design/wechat.md).

## Web Channel

File: `packages/server/src/routes/web.ts`

### Admin endpoints (cookie auth)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/web/accounts` | List all web accounts |
| POST | `/api/web/accounts` | Create account (body: `{workspacePath, label?, accessLevel?, language?}`) → `{accountId, token, workspacePath}` |
| PATCH | `/api/web/accounts/:id` | Update account fields (label, workspacePath, enabled, accessLevel, language) |
| DELETE | `/api/web/accounts/:id` | Delete account |

### Public endpoints (token auth via `x-token` header or `?token=` query)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/web/chat` | Send message, receive SSE stream. Body: `{message, images?}` |
| POST | `/api/web/stop` | Stop running task → `{stopped: boolean}` |
| GET | `/api/web/history` | Active session history → `{sessionId, messages[], running}` |
| GET | `/api/web/subscribe` | Reconnect SSE to running session |

See [design/web.md](../design/web.md).

## Show (world snapshot)

File: `packages/server/src/routes/show.ts`. Token auth (same `x-token` as the
Web channel; shares its brute-force lockout bucket). Read-only, cross-workspace
snapshot powering the `halo-city` pixel visualizer — one call returns the whole
runtime so the frontend can render rooms (workspaces) + characters (sessions).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/show/state` | Full-access token → every known workspace; otherwise the account's own. Returns `{ serverTime, uptime, accessLevel, skills[], workspaces[] }` |

Each `workspace` = `{ path, key, label, counts{running,idle,stopped}, totalSessions, skills[], sessions[] }`; each `session` = `{ id, parentId, depth, agentName, description, status, lastTool, activeSkill, contextTokens, outputTokens, updatedAt }`. `lastTool` / `activeSkill` come from the live in-memory UI log (empty when the session isn't loaded). Sessions per room are capped (`totalSessions` reports the true total). Frontend: `halo-city/` at repo root.

## Agent Configs

File: `packages/server/src/routes/agent-configs.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agent-configs?projectId=` | List agents (global + workspace merged) |
| GET | `/api/agent-configs/tools` | Available workspace tools |
| GET | `/api/agent-configs/models` | Available model providers and models |
| POST | `/api/agent-configs` | Create a new agent |
| GET | `/api/agent-configs/:id/yaml?scope=&projectId=` | Read agent.yaml |
| PUT | `/api/agent-configs/:id/yaml?scope=&projectId=` | Write agent.yaml |
| DELETE | `/api/agent-configs/:id?scope=&projectId=` | Delete agent (global has "last one" protection) |
| PATCH | `/api/agent-configs/:id/toggle?scope=&projectId=` | Toggle disabled in workspace DB. `projectId` required. Returns `{ ok, disabled }`. |
| GET | `/api/agent-configs/:id/md/:fileType` | Read an MD file (AGENT.md / INSTRUCTIONS.md / INDEX.md) |
| PUT | `/api/agent-configs/:id/md/:fileType` | Write an MD file (AGENT.md / INSTRUCTIONS.md) |
| GET | `/api/agent-configs/:id/md-all` | Read every MD at once |
| GET | `/api/agent-configs/:id/sessions?projectId=` | List the agent's session files |
| GET | `/api/agent-configs/:id/sessions/:sessionId` | Read a session |
| POST | `/api/agent-configs/:id/sessions` | Save / update a session |
| DELETE | `/api/agent-configs/:id/sessions/:sessionId` | Delete a session |
| DELETE | `/api/agent-configs/:id/sessions?all=1` | Delete every session for the agent |

## Skills

File: `packages/server/src/routes/skills.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/skills?projectId=` | List skills (global + workspace unmerged — two distinct entries). Global entries shadowed by a same-id workspace skill are marked `overridden: true`. Runtime override happens in `agent-loader.ts`, not in this route. |
| POST | `/api/skills` | Create a skill directory + SKILL.md |
| DELETE | `/api/skills/:id?scope=&projectId=` | Delete skill directory + settings entry |
| PATCH | `/api/skills/:id/toggle?scope=&projectId=` | Toggle disabled in workspace DB. `projectId` required. Returns `{ ok, disabled }`. |

## Commands

File: `packages/server/src/routes/commands.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/commands?projectId=[&sessionId=][&agentId=]` | List registered commands (built-in + skill; excludes hidden) |

Returns `{ commands: CommandDescriptor[] }`. Skill commands are only included with session/agent context: `sessionId+projectId` (or pre-session `agentId+projectId`) filters them by the agent's skill whitelist + access level. Without that context the response is **builtins only** — listing skills unfiltered leaked full-access commands into readonly palettes. See [design/command.md](../design/command.md).

## Settings

File: `packages/server/src/routes/settings.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/settings/schema?projectId=` | Schema (provider/skill declarations) + resolved values + orphans — drives the new Settings page |
| GET | `/api/settings?projectId=` | Raw merged settings (legacy, kept for older tooling) |
| PUT | `/api/settings` | Replace a scope's full settings |
| PATCH | `/api/settings` | Update a single key |
| DELETE | `/api/settings` | Delete a key |

## Self-Evolution

File: `packages/server/src/routes/evolution.ts`. Surfaces the global `evolution_runs` / `evolution_applies` queues to the admin UI's Evolution tab; see [plans/self-evolution.md](../plans/self-evolution.md) for the full design.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/evolution/runs` | List all evolution runs across workspaces. Carries the latest `apply_id`/`apply_status` per run. (Score isn't surfaced in the list — it's read from `score.json` on the detail fetch only.) |
| GET | `/api/evolution/runs/:id` | Detail: db row + `patch.md` + `score.json` + `system-suggestions.md` (optional, evo writes when it has platform-level feedback) + `.skip.md` (when `status='skipped'`) + a snapshot summary (first user message + first assistant reply + message count). |
| POST | `/api/evolution/runs/:id/approve` `{reviewerHint?}` | Move run from `awaiting_review` → `approved`, insert a pending `evolution_applies` row that the ticker will pick up. |
| POST | `/api/evolution/runs/:id/reject` | Move run from `awaiting_review` → `rejected`. |
| POST | `/api/evolution/runs/:id/hint` `{hint}` | Append text to `user_hint` — memo only, doesn't change status. |
| DELETE | `/api/evolution/runs/:id` | Delete a finished run: its on-disk artifacts (run dir + archive zip) **and** the DB row. Rejected with 409 for in-flight states (`pending` / `running` / `approved`) so a live wrapper / queued apply isn't pulled out from under. Broadcasts `evolution:run_changed` with `kind:'deleted'`. |
| GET | `/api/evolution/applies` | List apply rows (used for status badges). |

---

## Request / Response schemas

Bodies and response shapes for the endpoints agents most commonly help users call. Source lines cited — verify against the route file if in doubt.

### POST `/api/auth/login`

Source: [packages/server/src/middleware/auth.ts:123-134](../../../packages/server/src/middleware/auth.ts#L123-L134)

```json
// Request
{ "password": "..." }

// 200 OK — sets halo_token cookie
{ "ok": true }

// 401 Invalid password
{ "error": "Invalid password" }
```

### GET `/api/auth/check`

```json
// 200 authenticated
{ "authenticated": true }

// 401 not authenticated
{ "authenticated": false }
```

### GET `/api/files/tree?projectId=<absPath>&path=<relPath>`

Source: [packages/server/src/routes/files.ts](../../../packages/server/src/routes/files.ts). One directory level, lazy.

```json
// 200
{
  "tree": [
    { "name": "packages", "path": "packages", "type": "directory", "hasChildren": true },
    { "name": "README.md", "path": "README.md", "type": "file" }
  ]
}
```

Skipped entries: dotfiles (except `.halo`), `node_modules`, `__pycache__`.

### GET `/api/files?path=<rel>&projectId=<abs>`

Reads file content. Max 10 MB.

```json
// 200
{ "content": "..." }

// 404 if path doesn't exist
{ "error": "File not found" }
```

### POST `/api/agent-configs`

Source: [packages/server/src/routes/agent-configs.ts:199-255](../../../packages/server/src/routes/agent-configs.ts#L199-L255)

```json
// Request
{
  "name": "Coder",
  "description": "Full-stack coder",
  "scope": "workspace",           // "global" | "workspace"
  "projectId": "/abs/path/to/ws"  // required when scope=workspace
}

// 201 Created — agent + possible cross-scope conflict flag
{
  "agent": {
    "id": "coder",
    "name": "Coder",
    "description": "Full-stack coder",
    "model": "global.anthropic.claude-sonnet-4-6",
    "path": "/abs/path/to/ws/.halo/agents/coder",
    "scope": "workspace",
    "priority": 0
  },
  "conflictScope": null            // or "global" / "workspace" to warn of override
}

// 409 already exists
{ "error": "Agent already exists" }
```

Files created:
- `<agentDir>/agent.yaml` — scaffold with `SCAFFOLD_MODEL`, empty tools/skills
- `<agentDir>/AGENT.md` — `# <name>\n\n<description>\n`

### PUT `/api/agent-configs/:id/yaml?scope=&projectId=`

```json
// Request
{ "yaml": "name: Coder\nmodel:\n  provider: aws-bedrock-claude-invoke\n...", "scope": "workspace", "projectId": "/abs/ws" }

// 200 OK — returns re-parsed metadata
{ "agent": { "id": "coder", "name": "Coder", "description": "...", "model": "...", "path": "...", "scope": "workspace" } }

// 400 invalid YAML
{ "error": "Invalid YAML: <parser message>" }

// 404
{ "error": "Agent not found" }
```

### POST `/api/skills`

Source: [packages/server/src/routes/skills.ts](../../../packages/server/src/routes/skills.ts)

```json
// Request
{
  "name": "Code Review",
  "description": "Review code for correctness and style",
  "scope": "workspace",
  "projectId": "/abs/ws",
  "command": "/review"            // optional — registers as slash command
}

// 201
{
  "skill": {
    "id": "code-review",
    "name": "Code Review",
    "description": "Review code for correctness and style",
    "path": "/abs/ws/.halo/skills/code-review/SKILL.md",
    "scope": "workspace"
  }
}
```

### GET `/api/sessions/logs?projectId=<abs>&rootOnly=0|1&includeArchived=0|1&cursor=<ms>&limit=<n>`

Source: [packages/server/src/routes/sessions.ts:189-258](../../../packages/server/src/routes/sessions.ts#L189-L258)

Keyset-paginated over `updatedAt` (descending). `limit` defaults to 50; the
response's `nextCursor` (epoch ms of the last row's `updatedAt`, or `null` on
the last page) is passed back as `cursor` to fetch the next page.

Two shapes, selected by `rootOnly`:

- **Default (`rootOnly` omitted)** — returns each top-level row (`parent_id IS
  NULL`) *plus all of its descendants*, flattened. The admin **Sessions
  sidebar** consumes this and rebuilds the tree from `parentSessionId` in one
  shot, no per-expand round-trips. `limit` bounds the top-level rows; their
  descendants are appended on top.
- **`rootOnly=1`** — returns root sessions only, no descendants. The
  **chat-header dropdown** uses this for a flat "recent sessions" list. `limit`
  bounds the roots directly, so the page count is exact.

```json
// 200 — rootOnly=1: roots only. Default shape is the same rows + descendants.
{
  "sessions": [
    {
      "id": "sid_abc",
      "agentId": "default",
      "agentName": "Default",
      "title": "First user message...",
      "source": "explorer",
      "createdAt": "2026-04-30T08:00:00Z",
      "updatedAt": "2026-04-30T08:05:00Z",
      "messageCount": 12,
      "parentSessionId": null,
      "contextTokens": 5975,
      "totalOutputTokens": 6058,
      "stoppedAt": null,
      "archivedAt": null
    }
  ],
  "nextCursor": 1779890684254
}
```

Archived sessions are excluded by default; pass `?includeArchived=1` to include them.

### GET `/api/sessions/logs/:id?projectId=<abs>`

Returns the full session file. If only `rawMessages` is present (sub-agent sessions from SessionManager), `convertRawMessages()` transforms them into the display `messages` array on the fly.

```json
// 200 — same shape as the on-disk JSON
{
  "version": 1,
  "id": "sid_abc",
  "agentId": "default",
  "agentName": "Default",
  "title": "...",
  "source": "explorer",
  "createdAt": "...", "updatedAt": "...",
  "messageCount": 12,
  "contextTokens": 5975,
  "totalOutputTokens": 6058,
  "messages": [ /* SessionMessage[] — see design/storage.md */ ],
  "rawMessages": [ /* optional */ ]
}
```

### GET `/api/settings/schema?projectId=<abs>`

Resolves declared schema (from `models/<id>.yaml` `secrets:` and `skills/<id>/config.yaml`) against current settings, returning per-field source/state and a list of orphan keys. Drives the Settings page.

```json
// 200
{
  "scope": "global",                              // or "workspace" when projectId set
  "sections": [
    {
      "namespaceId": "aws-bedrock-claude-invoke", // 'general' | provider id | skill id
      "source": "provider",                        // 'general' | 'provider' | 'skill'
      "displayName": "AWS Bedrock Claude (Invoke API)",
      "displayName_zh": "AWS Bedrock Claude（Invoke API）",
      "description": "...",
      "description_zh": "...",
      "fields": [
        {
          "key": "access_key_id",
          "kind": "secret",                        // 'param' | 'secret'
          "description": "...",
          "description_zh": "...",
          "default": null,                         // schema-default placeholder
          "secret": true,                          // UI masks input + value
          "value": "AK****ST",                     // already masked when secret:true; null = unset
          "hasValue": true,                        // any layer has a non-empty value
          "source": "global",                      // 'workspace' | 'global' | 'unset'
          "inheritedFromGlobal": false             // true when scope=workspace + value came from global
        }
      ]
    }
  ],
  "orphans": [
    { "namespaceId": "tavily-old", "kind": "param", "key": "api_key" }
  ]
}
```

`<<ENV_NAME>>` references in stored values are returned **as literals** (the browser never sees the resolved env var). Secret values are masked (`AK****ST`); env-var refs pass through unmasked since they're not real secrets.

### GET `/api/settings?projectId=<abs>` (legacy)

```json
// 200
{
  "settings": { /* merged: defaults + global + workspace */ },
  "layers": {
    "defaults": { /* hard-coded defaults (now empty after schema migration) */ },
    "global": { /* ~/.halo/secrets/settings.yaml */ },
    "workspace": { /* <ws>/.halo/settings.yaml */ }
  }
}
```

Kept for older tooling. Env `<<…>>` placeholders are not substituted here.

### PATCH `/api/settings`

```json
// Request — dotted-path key, single value (no `.value` suffix; values are flat now)
{
  "scope": "workspace",                  // 'global' | 'workspace'
  "projectId": "/abs/ws",                // required when scope=workspace
  "key": "tavily-web-search.params.api_key",
  "value": "<<TAVILY_API_KEY>>"
}

// 200
{ "ok": true }
```

PUT replaces the full scope; DELETE takes `{scope, projectId, key}` and removes the key. The Settings page uses DELETE for both Reset (current scope removed → falls back to lower scope / unset) and orphan Remove.

### POST `/api/weixin/login/start`

Source: [packages/server/src/routes/weixin.ts:42-46](../../../packages/server/src/routes/weixin.ts#L42-L46)

```json
// Request
{ "sessionKey": "optional-resume-key", "force": false }

// 200
{ "qrcodeUrl": "https://...", "sessionKey": "abc123" }
```

### POST `/api/weixin/login/wait`

```json
// Request
{
  "sessionKey": "abc123",
  "workspacePath": "/abs/path",     // required, must be absolute
  "label": "My Bot",                // optional
  "accessLevel": "readonly",        // "full" | "readonly", default readonly
  "language": "en",                 // "en" | "zh", default "en" — controls system message language
  "timeoutMs": 120000               // optional, how long to wait for scan
}

// 200 waiting for scan (retry polling)
{ "connected": false, "message": "..." }

// 200 connected — account inserted + long-poll started
{ "connected": true, "accountId": "abc-im-bot" }

// 400 bad input
{ "error": "workspacePath required" }
```

---

## WebSocket message envelopes

Full WS protocol in [design/ws.md](../design/ws.md). The four high-traffic client messages:

### `chat` (C→S)

```json
{
  "type": "chat",
  "sessionId": "sid_abc",
  "projectId": "/abs/ws",
  "message": "hello",
  "agentId": "default",                                    // optional override
  "images": [ { "data": "<base64>", "mimeType": "image/png" } ]  // optional
}
```

Server behaviour ([handler.ts `handleChat`](../../../packages/server/src/ws/handler.ts#L263-L344)):
- Creates / reuses a session with the specified agent
- Persists pasted images to `<ws>/.halo/web/inbound/<date>/`
- If the model does not support image input (`capabilities.image: false`), images are filtered out and a text notice is appended instead of sending to the API
- Queues if busy/compacting; otherwise runs the agent turn
- Streams events back via `message`, `tool_call`, `usage`, etc.

### `subscribe` (C→S)

Attach this connection to a session's event stream. Sent on initial connect and whenever the active session changes.

```json
{
  "type": "subscribe",
  "sessionId": "sid_abc",
  "projectId": "/abs/ws"
}
```

### `session:clear` (C→S)

Detach from the current session (for `/session new`). Server unsubscribes the event listener without deleting the session.

```json
{ "type": "session:clear", "sessionId": "sid_abc" }
```

### `session:delete` (C→S)

Archive (soft-delete) a session.

```json
{ "type": "session:delete", "sessionId": "sid_abc", "projectId": "/abs/ws" }
```

Hard delete (JSON + SQLite rows, cascades to descendants) goes through the REST route `DELETE /api/sessions/logs/:id`, not this WS message.

### Server-sent events (S→C, selected)

| Type | Fields | Purpose |
|---|---|---|
| `message` | `content`, `role`, `taskId?` | Text chunk from the agent |
| `tool_call` | `toolName`, `toolInput`, `taskId?` | Tool invocation card |
| `tool_result` | `toolName`, `toolOutput`, `durationMs`, `taskId?` | Tool result |
| `usage` | `usage`, `modelId`, `turnId`, `taskId?` | Token accounting per turn |
| `complete` | `stopReason`, `taskId?` | Turn finished |
| `error` | `error` | Error message |
| `chat:queued` | `reason`, `message` | Message queued (compact/busy) |

Events with `taskId` set belong to sub-agent turns (nested sessions); events without are the root agent's. Full list in [design/ws.md](../design/ws.md).

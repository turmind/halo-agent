# API Routes

All REST endpoints are served by Hono on port 9527 at `/api/`.

Auth: most `/api/*` routes require a valid JWT cookie (`halo_token`). Exceptions in `PUBLIC_PATHS` (`middleware/auth.ts`) bypass the cookie: `/api/auth/login|check|logout` (but **not** `/api/auth/change-password`), the web-channel routes (`/api/web/chat|sessions|stop|history|subscribe|file`), `/api/show/state|session`, and `/api/metrics` — these are unauthenticated or use a web-channel `x-token` instead.

**Trust model.** The admin cookie is a single-tenant, all-or-nothing credential: there is one password (`~/.halo/secrets/config.yaml`), one JWT secret, and no roles. A valid `halo_token` equals full control of the server process — every workspace's files (`/api/files/*` project-scoped, `/api/fs/browse` unrestricted), shell via the WS terminal, channel credentials, git credentials, cron jobs, and the ability to mint web-channel tokens at any access level. Routes under the cookie therefore don't re-check "who" beyond the cookie itself; per-user isolation is the job of channel accounts (`x-token` with `readonly` / `workspace` / `full`), not of the admin. Consequences worth knowing when adding routes: (1) never put a cookie-gated route in `PUBLIC_PATHS` to "make it easier for a client" — that's the entire boundary; (2) a route that accepts a path or id from the client still needs traversal / shape checks (`isSafeIdSegment`, `assertPathAllowed`), because the *web-channel* surface reuses the same helpers and is multi-user; (3) if multi-user admin ever lands, the first change is a role claim in the JWT plus per-route checks, and this paragraph becomes the checklist.

Compression: every response negotiates gzip/deflate via `hono/compress` (`threshold: 1024` — bodies under 1 KiB pass through uncompressed), mounted after CORS so it covers both `/api/*` JSON and the served admin static assets. `text/event-stream` (SSE) is excluded, so `/api/web/chat`'s streamed reply is unaffected; WS upgrades never enter the Hono fetch pipeline either.

## Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check — returns `{status, timestamp, uptime, engine, version, gitSha}` (`gitSha`: short sha on source builds, `-dirty` suffix if tree modified, `null` on published bundles) |

## Authentication

File: `packages/server/src/middleware/auth.ts`

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Password login, returns a JWT cookie |
| POST | `/api/auth/logout` | Clears the auth cookie (Set-Cookie `Max-Age=0`). In `PUBLIC_PATHS`. No server-side token blacklist — a copied JWT stays valid until natural expiry |
| GET | `/api/auth/check` | Validates the current token; refreshes stale tokens. Also returns `badge` (the `HALO_BADGE` env, `null` when unset) on both the 200 and the 401 so the login page can brand its favicon/title too |
| POST | `/api/auth/change-password` | Change the admin password. **Not** in `PUBLIC_PATHS` — requires a valid JWT cookie. Persists the new scrypt hash to `~/.halo/secrets/config.yaml`; takes effect immediately (no restart), does **not** rotate `jwt_secret` so existing sessions stay signed in |

## Files

File: `packages/server/src/routes/files.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/files/tree?projectId=[&path=]` | List one level (lazy). Every directory carries `hasChildren`. No `path` = project root. |
| GET | `/api/files/search?projectId=&q=[&limit=][&dirsOnly=1]` | Recursive name search. Default limit 200, max 1000. Scans up to 50000 entries then truncates; returns `{matches, truncated}`. `dirsOnly=1` matches directories instead of files (powers the chat `@scope` directory completion). |
| GET | `/api/files?path=&projectId=` | Read file content (max 10 MB) |
| GET | `/api/files/stat?path=&projectId=` | Lightweight mtime + size |
| GET | `/api/files/download?path=&projectId=&inline=` | Download or inline-preview — streams the file (no full read into memory), supports `Range` (206 Partial Content) so `<video>`/`<audio>` can seek + partial-load; aborts the read if the client disconnects |
| PUT | `/api/files` | Save file (body: `{path, content, projectId}`) |
| POST | `/api/files/new` | Create empty file |
| POST | `/api/files/mkdir` | Create directory |
| POST | `/api/files/rename` | Rename / move |
| POST | `/api/files/upload` | Multipart upload |
| DELETE | `/api/files?path=&projectId=` | Delete file or directory (recursive) |

**Inline Content-Type** for images comes from core's shared extension→MIME table (`imageMimeFromExt`, `packages/core/src/media/mime.ts`) on both `/api/files/download?inline=1` and `/api/web/file`; each route keeps only its own non-image entries (pdf / html / video / audio) and falls back to `application/octet-stream`. That table is why `.bmp` now serves as `image/bmp` on both — the two routes used to carry their own copies and `/api/web/file` returned `application/octet-stream` for it. `.svg` / `.ico` / `.avif` get a real image Content-Type when served, but are deliberately not "photos" (they're outside `IMAGE_EXTS`) so they never reach a vision model or a channel's sendPhoto.

All file operations validate the path stays inside the project root (prevents path traversal). The check (`validatePath` in `routes/workspace-path.ts`, shared with `data-preview.ts` and `git.ts`) realpaths both sides — longest existing ancestor plus the re-appended tail — so a symlink inside the workspace pointing outside it is rejected too, not just lexical `../`. One exception: `GET /api/files/download` also accepts absolute paths under `/tmp/` so that agent-produced working files (e.g. Playwright screenshots) can be inline-previewed from chat media chips.

### Filesystem browse (not project-scoped — for the workspace picker)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/fs/home` | Returns server `homedir()` — fallback when the frontend has no `?folder=` URL param. Returns `{ home }`. |
| GET | `/api/fs/exists?path=/abs` | Validates an absolute path exists and whether it's a directory. Returns `{exists, isDirectory?}`. |
| GET | `/api/fs/browse?path=/abs` | Lists immediate directory children (hidden ones dropped). Returns `{path, parent, entries: [{name, path}]}`. |
| POST | `/api/fs/workspace/resolve` | Resolve `{path}` to an absolute path and run `ensureWorkspaceHalo()`. Returns `{id, path}`. Used by the workspace-picker on switch. 404 `path not found` when it doesn't exist; 400 `not a directory` for a file; 400 `filesystem root cannot be a workspace` for `/` (or a drive root) — `ensureWorkspaceHalo()` writes a whole `.halo/` scaffold, so those two shapes are refused before the write. Deeper system trees (`/usr`, `/etc`) are deliberately **not** banned. |

Absolute paths only. Purpose: Explorer's workspace picker and switching validation. `/api/fs/browse` is intentionally unrestricted (it's a read-only picker over the server's filesystem — same trust boundary as the admin cookie). Reading/writing files still goes through `/api/files/*` and remains project-sandboxed.

## Data Preview

File: `packages/server/src/routes/data-preview.ts`

Tabular file previews (Parquet / SQLite / CSV / TSV) for the Canvas editor — parsed server-side, returned as schema + one page of JSON-safe rows so large files never travel to the browser.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/data-preview/sqlite/tables?path=&projectId=` | List tables. Returns `{ tables: [{name, rowCount}] }` |
| GET | `/api/data-preview/sqlite/rows?path=&projectId=&table=&offset=&limit=` | One page of rows. Returns `{ table, columns, rows, totalRows, offset, limit }` |
| GET | `/api/data-preview/parquet?path=&projectId=&offset=&limit=` | Schema + one page of rows. Returns `{ columns, rows, totalRows, offset, limit }` |
| GET | `/api/data-preview/csv?path=&projectId=&offset=&limit=` | Header + one page of data rows. Returns `{ columns, rows, totalRows, hasMore, offset, limit }` |

Pagination: `limit` defaults to 100, capped at 1000. Same `(path, projectId)` resolution + traversal guard as `files.ts` (400/403/404 with a readable `{error}` body, never a 500 stack trace).

- **sqlite/tables**, **sqlite/rows** — opens the db `readonly` + `fileMustExist`, closed per request (no lingering lock on a live WAL db). Table names can't be parameterized, so they're gated on `sqlite_master` membership before being quoted into the query.
- **parquet** — reads only the footer + the row groups covering the requested page (hyparquet), never the whole file.
- **csv** — streaming RFC 4180 tokenizer, memory O(page). Delimiter is sniffed from the header line (`,` / `;` / tab, comma wins ties); `.tsv` forces tab. `totalRows` is a lazy lower bound while `hasMore` is true (exact once the scan reaches EOF, to avoid re-reading the whole file on every page turn). A single row over 1MB is rejected with 400 (delimiter-flood / non-CSV guard).
- All four fold cells to JSON scalars: bigints beyond ±2^53 become exact strings, BLOB/binary becomes a `<blob N bytes>` placeholder, `Date` becomes ISO text.

## Session Logs (unified)

File: `packages/server/src/routes/sessions.ts`

Unified session log API — list + read session files across all agents.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions/logs?projectId=` | List session metadata, keyset-paginated. Default returns each top-level row + all descendants (sidebar tree); `rootOnly=1` returns roots only (chat-header dropdown) |
| GET | `/api/sessions/logs/:id?projectId=` | Full session log (scans across agent dirs) — the **active** file only; archived history is a separate call |
| GET | `/api/sessions/logs/:id/archive/:n?projectId=` | One archived UI-log segment — see [detail](#get-apisessionslogsidarchivenprojectidabs) |
| DELETE | `/api/sessions/logs/:id?projectId=` | Delete the session log (and all of its archive segments) |
| PATCH | `/api/sessions/logs/:id?projectId=` | Rename a session (admin-only) — updates the log file's title and the mirrored `agent_sessions.title`. Accepts any session id (root or sub-agent); the sidebar exposes the rename affordance on every row |
| GET | `/api/sessions/goal?projectId=` | Latest goal binding for the workspace (goal-mode banner / input-lock seed) — see [detail](#get-apisessionsgoalprojectidabs) |

The list endpoint returns flat metadata (id / agentId / agentName / title / timestamps / exchangeCount / parentSessionId / stoppedAt / contextTokens / totalOutputTokens / goalSessionId), served from the mirrored `agent_sessions` columns rather than by parsing each session file (rows predating the columns are backfilled from the file on first read). The frontend builds the tree from `parentSessionId`; `goalSessionId` (non-null on a goal-bound worker row) drives the 🎯 badge.

The get endpoint returns the full session file. If only `rawMessages` is present (no event-log `messages`), `convertRawMessages()` transforms it into display format on the fly.

## Channel accounts — shared field validation

`workspacePath` and `accessLevel` are validated at the REST boundary on both
POST and PATCH across all five channels (web / wechat / telegram / slack /
feishu) — one shared pair of checks in `channels/shared/accounts.ts`, so the
five can't drift (they did: four PATCHes never checked `isAbsolute`, and only
wechat's PATCH rejected an unknown `accessLevel`):

| Field | Rule | 400 body |
|---|---|---|
| `accessLevel` | Must be one of the channel's legal levels when present; absent = leave unchanged. **web** allows `full` / `workspace` / `readonly` / `observer` (halo-city / metrics tokens are minted here); the **four chat channels** allow only `full` / `workspace` / `readonly` — `observer` is a dashboard role, not a chat identity | `{error: "accessLevel must be one of: …"}` |
| `workspacePath` | Absolute and existing. Empty string / relative path → 400; PATCH treats *absence* as "leave the binding alone" but validates any value supplied. On success `ensureWorkspaceHalo()` scaffolds `.halo/` | `{error: "workspacePath must be absolute"}` / `{error: "workspace path not found"}` |

POST additionally rejects a missing `workspacePath` with `{error: "workspacePath required"}`. Stored levels are still normalized to `readonly` on read, but the db no longer holds a value no code path agrees with.

## WeChat Channel

File: `packages/server/src/routes/wechat.ts`

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/wechat/login/start` | Start the QR login flow, returns `{qrcodeUrl, sessionKey}` |
| POST | `/api/wechat/login/wait` | Poll QR status. body: `{sessionKey, workspacePath, label?, accessLevel?, language?}`; on success the account is inserted and long-polling starts. `workspacePath` must be absolute — checked **before** the blocking QR wait so a typo is rejected without asking the user to scan; existence + `.halo/` scaffolding are only checked after the scan lands, so an abandoned login never scaffolds a directory |
| GET | `/api/wechat/accounts` | List every bot account |
| PATCH | `/api/wechat/accounts/:id` | Change label / workspacePath / enabled / accessLevel / language |
| DELETE | `/api/wechat/accounts/:id` | Stop long-polling and delete the DB row |

See [design/wechat.md](../design/wechat.md).

## Telegram Channel

File: `packages/server/src/routes/telegram.ts`. Admin cookie auth. Mounted under `/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/telegram/accounts` | List bot accounts. Each row carries `accountId`, `botUsername`, `workspacePath`, `workspaceMissing`, `label`, `enabled`, `accessLevel`, `allowedUsers`, `language`, timestamps |
| POST | `/api/telegram/accounts` | Create / upsert. Body: `{botToken, workspacePath, label?, accessLevel?, allowedUsers?, language?}`. Validates the token via `getMe`; `accountId = botUsername.toLowerCase()`. (Re)starts long-poll. Returns `{accountId, botUsername, workspacePath}` |
| PATCH | `/api/telegram/accounts/:id` | Update `label` / `workspacePath` / `enabled` / `accessLevel` / `allowedUsers` / `language`. Stops then restarts the bot if still enabled |
| DELETE | `/api/telegram/accounts/:id` | Stop long-poll and delete the row |

`workspacePath` / `accessLevel` follow the [shared validation rules](#channel-accounts--shared-field-validation).

## Slack Channel

File: `packages/server/src/routes/slack.ts`. Admin cookie auth. Inbound events use Socket Mode (no webhook).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/slack/accounts` | List accounts. Row: `accountId`, `botUserId`, `teamId`, `workspacePath`, `workspaceMissing`, `label`, `enabled`, `accessLevel`, `language`, timestamps |
| POST | `/api/slack/accounts` | Create / upsert. Body: `{botToken, appToken, workspacePath, label?, accessLevel?, language?}`. `appToken` must start with `xapp-`. Resolves identity via `auth.test`; `accountId = team_id.toLowerCase()`. Returns `{accountId, botUserId, teamId}` |
| PATCH | `/api/slack/accounts/:id` | Update `label` / `workspacePath` / `enabled` / `accessLevel` / `language` / `appToken` |
| DELETE | `/api/slack/accounts/:id` | Stop Socket Mode connection and delete the row |
| GET | `/api/slack/accounts/:id/search?q=` | Search users / channels visible to this bot's token (used by the cron form). Returns `{hits}` (max 20) |

## Feishu Channel

File: `packages/server/src/routes/feishu.ts`. Admin cookie auth. Inbound uses long-connect wss (no webhook).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/feishu/accounts` | List accounts. Row: `accountId`, `appId`, `botOpenId`, `hasEncryptKey`, `workspacePath`, `workspaceMissing`, `label`, `enabled`, `accessLevel`, `language`, timestamps |
| POST | `/api/feishu/accounts` | Create / upsert. Body: `{appId, appSecret, verificationToken?, encryptKey?, workspacePath, label?, accessLevel?, language?}`. Resolves `botOpenId` via `/bot/v3/info`; `accountId = appId.toLowerCase()`. Returns `{accountId, appId, botOpenId}` |
| PATCH | `/api/feishu/accounts/:id` | Update `label` / `workspacePath` / `enabled` / `accessLevel` / `language` / `verificationToken` / `encryptKey`. `botOpenId` is **not** patchable — re-POST to re-resolve |
| DELETE | `/api/feishu/accounts/:id` | Stop the wss stream and delete the row |
| GET | `/api/feishu/accounts/:id/search?q=` | Search chats the bot is a member of (used by the cron form). Returns `{hits}` (max 20) |

## Cron

File: `packages/server/src/routes/cron.ts`. Admin cookie auth. REST CRUD over `cron_jobs` + read-only `cron_runs`. Mutations call `reloadAll()` / `scheduleJob()` / `unscheduleJob()` so in-memory croner stays in sync with the db. Each mutation also broadcasts `cron:job_changed`.

### Jobs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cron/jobs?limit=&before=` | Cursor-paginated newest-first by `createdAt`. Default `limit` 20, max 100; `before` is a `createdAt` cursor. Returns `{jobs, hasMore, nextCursor}`. Each job has `targets` decoded and a live `nextRunAt` (computed from schedule/runAt) |
| POST | `/api/cron/jobs` | Create a job. Body: `{label?, workspacePath, agentId, userPrompt, schedule, runAt?, timezone?, timeoutSec?, targets?, enabled?}`. Exactly one of `schedule` (5-field cron) or `runAt` (epoch ms, future) is required; mutually exclusive. `timeoutSec` must be an integer 60–21600 (else 400); unset = runner default 3600. Returns `{ok, id}` |
| PUT | `/api/cron/jobs/:id` | Partial update over the same fields. Re-validates `schedule` / `runAt` and enforces trigger-mode exclusivity on the **merged** row: both in one body → 400 `schedule and runAt are mutually exclusive`; supplying one side is a mode switch that implicitly clears the other; a body that clears the active side without supplying a replacement → 400 `schedule or runAt required`. `runAt` must be a finite future epoch-ms number or `null`. `timeoutSec` follows the same partial-body contract: omitted = unchanged, `null` = clear back to the default, a number is range-validated (60–21600) same as create. Flips schedule/unschedule on `enabled`. Returns `{ok}` |
| DELETE | `/api/cron/jobs/:id` | Unschedule, delete every `cron_runs` row for the job, then delete the job. Returns `{ok}` |
| POST | `/api/cron/jobs/:id/run-now` | Fire the job immediately (fire-and-forget). Returns `{ok}` |
| POST | `/api/cron/reload` | Re-read every job from db and rebuild schedules. Returns `{ok}` |

`targets` is `Array<{channelType, accountId, chatId?}>`. New job ids look like `cron-<base36-ts>-<rand>`.

### Runs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cron/jobs/:id/runs?limit=&before=` | Cursor-paginated newest-first by `cron_runs.id` (ISO-prefixed; sorts as text). Default `limit` 20, max 100. Returns `{runs, hasMore, nextCursor}`; each row has `dispatchResults` JSON-decoded |
| GET | `/api/cron/runs/:runId/log` | Read the raw log file for one run. Returns `{log}` (string or null when the file is missing / past retention) |

### Reference data (for the create form)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cron/channel-targets` | List channel accounts available as targets, aggregated from the cron-dispatcher registry. Returns `{targets}` |
| GET | `/api/cron/meta` | Server-side metadata. Returns `{hostTimezone}` — the IANA tz this server resolves an unset `cron_jobs.timezone` to |

## Source Control (Git)

File: `packages/server/src/routes/git.ts`. Admin cookie auth. Backs the Source Control panel + Explorer git decorations. All project-scoped reads take `projectId=<absPath>`; writes take it in the JSON body. A write (stage/unstage/commit/push/pull/init/remote) broadcasts `file:changed` (path `.git`) so the panel, graph and explorer decorations auto-refresh without polling — the file watcher ignores `.git`, so the route re-broadcasts it itself. The broadcast is **workspace-scoped** (`broadcastToWorkspace`): only clients bound to that workspace get it, so a git write in A no longer makes every tab showing B refetch status + ignored + log. Path params on diff are traversal-checked against the project root.

### Repo state (read)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/git/status?projectId=` | Structured working-tree status. A folder that isn't a git work-tree **root** (no repo, or merely nested inside an ancestor's repo) returns `{isRepo: false}` (200, not 500) so the panel shows its initialize/empty state. Otherwise `{isRepo: true, branch, tracking, ahead, behind, files: [{path, index, workingDir, from?}]}` — `index`/`workingDir` are the two porcelain status chars (X staged / Y working) |
| GET | `/api/git/ignored?projectId=` | `.gitignore`'d paths for graying out in the explorer; ignored directories are collapsed to a single entry (e.g. `node_modules`) rather than expanded. Returns `{ignored: string[]}` (`{isRepo:false, ignored:[]}` when the folder isn't a work-tree root — same guard as `status`, applied to all six read endpoints so a workspace nested inside an ancestor's repo never leaks its state). Runs with `core.quotepath=false` so non-ASCII (e.g. Chinese) paths come back literal, not octal-escaped — the frontend prefix-matches them against tree node paths |
| GET | `/api/git/diff?projectId=&path=[&staged=0\|1][&from=][&commit=]` | Two sides for the Monaco diff editor. With `commit`, shows that commit's own change (parent vs commit); without it, the working-tree (or `staged=1`) diff. `from` carries the old path on a rename. Returns `{path, original, modified, ...}`. 400 if `path` missing, 403 on traversal |
| GET | `/api/git/log?projectId=[&limit=50]` | Recent commits for the graph. `limit` default 50, capped at 2000. Returns `{commits: [{hash, shortHash, message, author, date, refs, pushed}]}` — `pushed: boolean` marks whether the commit is on a remote (graph dims pushed nodes gray, paints local-only ones blue). No-upstream branches compute it via `rev-list HEAD --not --remotes`, not `rev-list HEAD` |
| GET | `/api/git/commit-files?projectId=&hash=` | Files changed by one commit. Returns `{files: [{path, status, from?}]}` (`status` = M/A/D/R/C; `from` set on rename/copy). 400 if `hash` missing |
| GET | `/api/git/remotes?projectId=` | Configured remotes. Returns `{remotes: [{name, url}]}` (`[]` when none) |

### Mutations (write — each broadcasts `file:changed`)

Every write except `/api/git/init` is gated on the project being a git work-tree **root** (`getGitForWrite` → `isRepoRoot()`): a folder that's merely nested inside an ancestor's repo gets **409** `{error: 'Not a git repository root'}` instead of silently mutating the ancestor. Reads keep their 200-with-empty-payload shape for the same state. `/api/git/init` is deliberately ungated — initializing a nested folder's own repo is exactly its purpose.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/git/stage` | Body `{projectId, paths: string[]}`. `git add`. 400 if `paths` empty |
| POST | `/api/git/unstage` | Body `{projectId, paths: string[]}`. 400 if `paths` empty |
| POST | `/api/git/commit` | Body `{projectId, message}`. Returns `{ok, hash}`. 400 if `message` blank |
| POST | `/api/git/push` | Body `{projectId}`. First push of an untracked branch sets upstream (`-u origin <branch>`). Git errors (missing creds, SSH passphrase, rejected) are surfaced verbatim for the panel to display |
| POST | `/api/git/pull` | Body `{projectId}` |
| POST | `/api/git/init` | Body `{projectId}`. `git init` |
| POST | `/api/git/remote` | Body `{projectId, name?, url}`. Adds a remote (`name` defaults to `origin`); drives the "no remote configured" publish flow. 400 if `url` missing |

### Credentials & SSH

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/git/credentials` | List stored HTTPS credentials — `{credentials: [{host, username}]}`. **Never returns the token.** Source of truth is `~/.git-credentials` (one line per host) |
| POST | `/api/git/credentials` | Body `{host, username, token}`. Upserts the `https://user:token@host` line in `~/.git-credentials` (0600). 400 if any field missing |
| DELETE | `/api/git/credentials/:host` | Remove the credential line(s) for one host (idempotent). `:host` is sent `encodeURIComponent`'d; Hono decodes it |
| GET | `/api/git/ssh/keys` | Private keys found in `~/.ssh` + an `encrypted` flag each. Never returns key contents. Returns `{keys: [...]}` |
| GET | `/api/git/ssh/agent` | ssh-agent reachability + loaded key count |
| POST | `/api/git/ssh/unlock` | Body `{keyPath, passphrase}`. Loads a passphrase-protected key into the shared ssh-agent. `keyPath` must resolve to a file **directly inside `~/.ssh`** (rejects traversal / arbitrary paths, 400). Passphrase is fed to `ssh-add` via a throwaway `SSH_ASKPASS` helper (never argv / disk / log); the helper is answer-once so a wrong passphrase returns immediately. Returns `{ok}` on success, `{ok:false, error}` (normalized — never ssh-add's raw stderr) on failure |
| GET | `/api/git/remote/protocol?projectId=` | Current `origin` url + detected protocol. Returns `{url, protocol}` |
| POST | `/api/git/remote/protocol` | Body `{projectId, to: 'https'\|'ssh'}`. Rewrites `origin` between HTTPS and scp-style SSH. Returns `{ok, url}` |

See [requirements/source-control.md](../requirements/source-control.md).

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

Token auth for the whole public surface — these routes, halo-city's
`/api/show/*`, and `/api/metrics` — runs through one shared core,
`resolveTokenAuth` in `middleware/web-token.ts`: header/query token parsing,
account lookup (must exist **and** be enabled), and the per-IP brute-force
bookkeeping in one place (5 strikes / 15 min lockout, one `web-token` bucket
shared by the three surfaces, independent of admin-login lockouts). A missing
token is a plain 401 and **not** a strike; only an invalid one counts.

Statuses are identical everywhere (`locked_out` 429, `missing_token` /
`invalid_token` 401) — only the **body shape** differs, which is why each surface
maps the failure itself: web + `/api/show/*` share the JSON renderer
(`{error: "token required" | "invalid token" | "too many failed attempts, try again later"}`),
`/api/metrics` answers in Prometheus comment lines (`# …`) so a scraper never
gets JSON, and additionally gates on `accessLevel`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/web/chat` | Send message, receive SSE stream. Body: `{message, images?, workspace?, sessionId?, agentId?}` (overrides also accepted as `?workspace=`/`?sessionId=` query or `x-workspace`/`x-session-id` headers; `workspace` only honored when token has `accessLevel: full`). `sessionId` must be owned by the token unless `accessLevel: full` → otherwise 403. |
| POST | `/api/web/sessions` | Mint a root session in the token's own `web_<accountId>_` namespace → `{sessionId}`. Body / query / header: `workspace?` (full tokens only), `agentId?`. Used by the ACP adapter's `session/new`. |
| POST | `/api/web/stop` | Stop running task → `{stopped: boolean}` |
| GET | `/api/web/history` | Active session history → `{sessionId, messages[], running}` |
| GET | `/api/web/subscribe` | Reconnect SSE to running session |
| GET | `/api/web/file?path=` | Inline-serve a workspace-relative file (image / video / pdf etc.). Path-traversal-checked against the token's bound workspace: the lexical check is re-verified against the realpath'd root, so a symlink inside the workspace pointing outside it returns 403; a dangling symlink (target doesn't exist) returns 404. Workspace runtime state (`.halo/sessions`, `.halo/logs`, `.halo/evo`, `halo.db*`) is hidden for every access level → 403 `{error: "path is not accessible"}`, checked on the realpath so symlinks into those dirs are caught too. |

See [design/web.md](../design/web.md).

## Show (world snapshot)

File: `packages/server/src/routes/halo-city.ts`. Token auth (same `x-token` as
the Web channel — same shared `resolveTokenAuth` core, same JSON error shape,
same brute-force lockout bucket). Read-only, cross-workspace
snapshot powering the `halo-city` pixel visualizer — one call returns the whole
runtime so the frontend can render rooms (workspaces) + characters (sessions).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/show/state` | `full` or `observer` token → every known workspace; otherwise the account's own. Returns `{ serverTime, uptime, accessLevel, skills[], workspaces[] }` |
| GET | `/api/show/session?ws=&id=` | Inspector-panel detail for a single session. Trimmed message log (last 40, content/tool I/O capped) plus `contextTokens` / `outputTokens` / `maxContextTokens` / `isRunning`. Non-`full`/`observer` tokens may only read their own workspace, and within it only sessions their own account minted (`web_<accountId>_*`); anything else is 403. |

`observer` is more than an aggregate-counts role: past `/show/state`, it can also call `/show/session` to read **any workspace's** session transcript (last 40 messages, content truncated to 600 chars, tool input to 200 chars). Mint it knowing it grants cross-workspace transcript read access, not just dashboard counters.

Each `workspace` = `{ path, key, label, counts{running,idle,stopped}, totalSessions, skills[], sessions[] }`; each `session` = `{ id, parentId, depth, agentName, description, status, lastTool, activeSkill, contextTokens, outputTokens, messageCount, updatedAt }`. `messageCount` here is the session file's raw UI-log length (an activity signal for the citizen animation) — deliberately **not** the admin list's lifetime `exchangeCount`; it shrinks when a compact archives history. `lastTool` / `activeSkill` come from the live in-memory UI log (empty when the session isn't loaded). Sessions per room are capped (`totalSessions` reports the true total). Frontend: `halo-city/` at repo root.

**Read-only by construction — degraded snapshots.** Both endpoints resolve a workspace's runtime via `registry.peek()` — in-memory lookup only, **never** `getOrCreate`: constructing a SessionManager has write side effects (boot orphan-reconciliation batch-stops live sub-session rows; `.halo/` scaffolding), so a pure visualization poll must not trigger it. When no live SessionManager exists in this process, the handler opens that workspace's `.halo/halo.db` **read-only** (cached connection; missing db/tables silently degrade to an empty room) and projects rows / the persisted session file into the same wire shape. Sessions not in memory therefore return a **persisted snapshot**: `status` / token counts / `messageCount` may lag behind the last persistence point, and the live-only signals (`lastTool` / `activeSkill`) are empty by definition. The degraded `/api/show/session` path reports `maxContextTokens: 0` (the real cap needs a live agent config; the city inspector hides the meter when the cap is unknown).

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

Every `:id` / `:sessionId` route param that becomes a path segment (here and in `DELETE /api/skills/:id`) is validated with `isSafeIdSegment()` (`routes/workspace-path.ts`) before it reaches `path.join` — `.` / `..` rejected outright, everything else must match `/^[\w.:>\u4e00-\u9fff-]+$/` (the union of the real id charsets: slug + CJK agent names, `__internal__`, and session ids embedding `_ - : . >`). Hono decodes `%2F` / `%2e` into params, so a raw `..%2F..%2Fetc` would otherwise arrive as a traversal. A rejected param is **400** (`Invalid agent id` / `Invalid skill id` / `Invalid session id`), distinct from the **404** a well-formed-but-missing session file gets.

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
| PUT | `/api/settings` | Replace a scope's full settings |
| PATCH | `/api/settings` | Update a single key |
| DELETE | `/api/settings` | Delete a key |

PATCH / DELETE walk the dotted key layer by layer, so a segment of `__proto__` / `constructor` / `prototype` is rejected with 400 `Invalid key` — the leaf assignment would otherwise land on `Object.prototype` and pollute every object in the process.

### Observability settings

- `general.observability.endpoint` — OTLP collector base URL (e.g. `http://localhost:4318`); empty = off
- `general.observability.service_name` — OTel resource `service.name`, default `halo`
- `general.observability.headers` — extra OTLP request headers, comma-separated `k=v` (secret)
- `general.observability.capture_content` — put prompt/completion/tool text on spans, default `false`

All four are `globalOnly`, take effect on restart. See [design/observability.md](../design/observability.md).

## Metrics

File: `packages/server/src/routes/metrics.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/metrics` | Prometheus text exposition (gauges) of deployment-wide runtime: `halo_uptime_seconds`, `halo_workspaces`, `halo_sessions{status=}`, `halo_sessions_total`, `halo_context_tokens`, `halo_output_tokens` |

In `PUBLIC_PATHS` (no admin cookie). Auth is a web-channel `x-token` (header or `?token=`) resolved through the shared `resolveTokenAuth` core, but rendered as Prometheus comment lines instead of JSON — and it additionally requires a **global** scope: `full` or `observer` (the read-only role minted for dashboards/scrapes); a workspace-scoped token gets `# global-scope token (full or observer) required` with 403. Session counts come from each workspace's `listSessions`; token sums read the in-memory UIState of sessions this process actively drives.

## Self-Evolution

File: `packages/server/src/routes/evolution.ts`. Surfaces the global `evolution_runs` / `evolution_applies` queues to the admin UI's Evolution tab; see [plans/self-evolution.md](../plans/self-evolution.md) for the full design.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/evolution/runs` | List all evolution runs across workspaces. Carries the latest `apply_id`/`apply_status` per run. (Score isn't surfaced in the list — it's read from `score.json` on the detail fetch only.) |
| GET | `/api/evolution/runs/:id` | Detail: db row + `patch.md` + `score.json` + `.skip.md` (when `status='skipped'`) + wrapper/sub-cli logs + a snapshot summary (first user message + first assistant reply + message count). Row carries `failureReason` (and `applyFailureReason` from the latest apply) — apply-side values include `phase A': apply cli exited <code>`, `phase A': apply agent aborted: <first line of ABORT.md>`, and `phase A': apply agent didn't produce apply.log`. |
| POST | `/api/evolution/runs/:id/approve` `{reviewerHint?}` | Move run from `awaiting_review` → `approved`, insert a pending `evolution_applies` row that the ticker will pick up. |
| POST | `/api/evolution/runs/:id/reject` | Move run from `awaiting_review` → `rejected`. |
| POST | `/api/evolution/runs/:id/retry` `{hint}` | Reset a finished run back to `pending` with the supplied (required) hint so the wrapper picks it up again. Rejected with 409 when the run is already `running` / `pending`. |
| POST | `/api/evolution/runs/:id/hint` `{hint}` | Append text to `user_hint` — memo only, doesn't change status. |
| DELETE | `/api/evolution/runs/:id` | Delete a finished run: its on-disk artifacts (run dir + archive zip) **and** the DB row. Rejected with 409 for in-flight states (`pending` / `running` / `approved`) so a live wrapper / queued apply isn't pulled out from under. Broadcasts `evolution:run_changed` with `kind:'deleted'`. |
| GET | `/api/evolution/applies` | List apply rows (used for status badges). |

## AgentCore adapter (runtime-mode only)

File: `packages/server/src/routes/agentcore.ts`. Mounted **only** when `HALO_RUNTIME_MODE=agentcore` (see [design/agentcore.md](../design/agentcore.md)): `GET /ping` (health, `HealthyBusy` while any agent session runs), `POST /invocations` (prompt in / reply out), and streaming `WS /ws`. Not present in normal server mode.

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
{ "authenticated": true, "badge": "DEV" }

// 401 not authenticated
{ "authenticated": false, "badge": "DEV" }
```

`badge` echoes the `HALO_BADGE` env (trimmed; `null` when unset) on **both**
branches — this is the admin's first request, login page included, so the tab
can brand its favicon + title from the very first paint without a second
endpoint or a poll. Corollary: the value is readable **without authenticating**,
so it must stay a label, not a secret. See [env.md](./env.md).

### POST `/api/auth/change-password`

Source: [packages/server/src/middleware/auth.ts](../../../packages/server/src/middleware/auth.ts). Admin-cookie authed (not in `PUBLIC_PATHS`). Validation order: wrong current password → 401; strength (≥8 chars, at least one letter and one digit) → 400 with the specific reason; new === old → 400. When `HALO_PASSWORD` env is set it overrides the stored hash at login, so a file rewrite would silently not take effect — the endpoint rejects with 400 instead.

```json
// Request
{ "oldPassword": "...", "newPassword": "..." }

// 200 OK — new scrypt hash persisted to ~/.halo/secrets/config.yaml,
// live for the next login without restart; jwt_secret is NOT rotated
// (existing cookies stay valid)
{ "ok": true }

// 401 wrong current password
{ "error": "Incorrect current password" }

// 400 strength / same-as-old / env-managed (message names the reason)
{ "error": "Password must be at least 8 characters" }
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
      "exchangeCount": 12,
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

Rows are served from the mirrored `agent_sessions` metadata columns (`title` / `exchange_count` / `context_tokens` / `total_output_tokens`) — no session file is opened. A row whose `exchangeCount` is `null` predates those columns: the route reads that one file once, mirrors the values back, and never pays the cost again. `exchangeCount` counts **main user turns over the session's lifetime** (kept + archived), so unlike the file's `messageCount` it doesn't shrink when a compact archives history.

### GET `/api/sessions/logs/:id?projectId=<abs>`

Returns the full session file — the **active** log only. Older exchanges that archiving moved out are fetched per-segment via [the archive endpoint](#get-apisessionslogsidarchivenprojectidabs). If only `rawMessages` is present (sub-agent sessions from SessionManager), `convertRawMessages()` transforms them into the display `messages` array on the fly.

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
  "archiveCount": 2,
  "messages": [ /* SessionMessage[] — see design/storage.md */ ],
  "rawMessages": [ /* optional */ ]
}
```

`messageCount` here is the **file's own** field (`messages.length`, shrinks on archive) — not the list endpoint's lifetime `exchangeCount`.

### GET `/api/sessions/logs/:id/archive/:n?projectId=<abs>`

Source: `packages/server/src/routes/session-archive.ts`

One archived UI-log segment, gunzipped server-side. `n` counts up from 1; the client gets its anchor from `archiveCount` on the `state:snapshot` of subscribe/reattach ([ws.md](../design/ws.md)) and walks **down** from it. Segments are immutable once committed, so a client caches what it pulled and never re-requests. Admin-cookie gated (not in `PUBLIC_PATHS`).

```json
// 200
{ "messages": [ /* SessionMessage[] — oldest-first within the segment */ ] }
```

Failure modes, in the order checked:

| Status | Body | When |
|---|---|---|
| 500 | `session manager not initialized` | server not fully booted |
| 400 | `projectId required` | missing query param |
| 400 | `Invalid session id` | `id` fails `isSafeIdSegment` (path-traversal guard) |
| 400 | `Invalid segment number` | `n` not a positive integer |
| 404 | `Session not found` | no such session in this workspace |
| 404 | `Segment not found` | `n > archiveCount` (uncommitted / nonexistent), or the segment file can't be read |

The `n > archiveCount` check is the point, not a formality: `archiveCount` in the active file is the archive write's commit marker, so a segment file beyond it exists only because a crash interrupted the two-step write and must never be served. See [design/session.md](../design/session.md#ui-log-archiving).

### GET `/api/sessions/goal?projectId=<abs>`

Source: `packages/server/src/routes/sessions.ts` (`findLatestGoal` in `agents/goal-mode.ts`)

Latest goal binding for the workspace — goals are serialized per workspace, so "the" goal is unambiguous. Refresh seed for the admin's goal banner / worker input lock: `goal:changed` WS pushes keep a live tab current, this endpoint restores state after a page reload. Returns `{ "goal": null }` when there is no goal or the latest one is `cleared` (a dismissed record, not a displayable state). See [design/goal-mode.md](../design/goal-mode.md).

```json
// 200
{
  "goal": {
    "goalSessionId": "goal_mabc123",
    "workerSessionId": "sid_abc",
    "status": "running",        // intake | running | paused | halted | done
    "round": 3,
    "maxRounds": 50
  }
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

### POST `/api/wechat/login/start`

Source: [packages/server/src/routes/wechat.ts:39-43](../../../packages/server/src/routes/wechat.ts#L39-L43)

```json
// Request
{ "sessionKey": "optional-resume-key", "force": false }

// 200
{ "qrcodeUrl": "https://...", "sessionKey": "abc123" }
```

### POST `/api/wechat/login/wait`

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
  "clientMsgId": "abc123",                                 // optional — ack/resend dedup id
  "images": [ { "data": "<base64>", "mimeType": "image/png" } ]  // optional
}
```

Server behaviour ([handler.ts `handleChat`](../../../packages/server/src/ws/handler.ts#L263-L344)):
- Creates / reuses a session with the specified agent
- Persists pasted images to `<ws>/.halo/web/inbound/<date>/`
- If the model does not support image input (`capabilities.image: false`), images are filtered out and a text notice is appended instead of sending to the API
- Queues if busy/compacting; otherwise runs the agent turn
- When `clientMsgId` is present, replies `{ "type": "chat:ack", "clientMsgId" }` once the message is appended to the session log; resends with an already-acked id are re-acked without re-appending (dedup — see [design/ws.md](../design/ws.md#chat-delivery-ack--resend--dedup))
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

Idempotent per connection: re-subscribing to the same session releases this connection's previous listener and registers exactly one new one — safe to repeat. The client must also re-send it on receiving `listener:released` (see below).

### `listener:released` (S→C)

The server reclaimed this connection's event listener — sent when the connection was silent for >3 min (no inbound frames; e.g. a frozen tab whose network stack still answers protocol pings) or found CLOSED with a listener attached. The socket stays open; only the event stream is detached.

```json
{ "type": "listener:released", "sessionId": "sid_abc" }
```

On receipt the client re-sends `subscribe` to reattach — this frame is the only recovery signal a frozen-and-resumed tab gets, because the server's `__pong__` replies keep the client's own staleness detection from ever firing. Any WS consumer must send `__ping__` periodically (any inbound frame counts) or it will be reclaimed. See [design/ws.md](../design/ws.md#abandoned-listener-reclaim-and-the-__ping__-contract).

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
| `listener:released` | `sessionId` | Event listener reclaimed — re-send `subscribe` (see above) |

Events with `taskId` set belong to sub-agent turns (nested sessions); events without are the root agent's. Full list in [design/ws.md](../design/ws.md).

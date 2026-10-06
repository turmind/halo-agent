# Canvas preview extensions — installable file viewers in sandboxed iframes

> API: [dev/api.md → Canvas Preview Extensions](../dev/api.md#canvas-preview-extensions). WS frame `extension:changed`: [ws.md](ws.md#other-server--client-messages). User-visible behavior: [requirements/editor.md](../requirements/editor.md). Code: `packages/core/src/protocol/extension-{types,frames}.ts`, `packages/server/src/extensions/{registry,watcher,install}.ts` + `routes/extensions.ts` + `middleware/auth.ts` (scoped token), `PUT /files/raw` in `routes/files.ts`, `routes/transcribe-ws.ts` (transcription proxy) + `settings-schema.ts` `extensionSections()`, `packages/admin/src/features/editor/previews/{registry,extension-host,extension-host-logic,extension-token}.ts(x)`, `packages/server/templates/skills/extension/`.

## Problem

The admin editor's preview set was compile-time: eight plugins registered in `previews/plugins/index.ts`, and every new file type (GLB, drawio, …) meant editing admin source, re-bundling and cutting a release — while each viewer's weight (model-viewer + three ≈ 1 MB) landed in every user's bundle. Extensions turn a viewer into **a static directory with an HTML entry** that the admin loads in an iframe and feeds file bytes over `postMessage`. Install = drop the directory into `~/.halo/global/extensions/<id>/`; no server restart, no page reload, no admin release.

## Directory is the install

```
~/.halo/global/extensions/
├── glb/                       # dir name == manifest.id
│   ├── halo-extension.json
│   ├── index.html             # manifest.entry
│   └── …                      # js / wasm / decoders / LICENSE
└── .tmp-unpack-a1b2c3/        # in-flight install (dot-prefixed → scanner skips it)
```

- Valid manifest present = installed; directory gone = uninstalled. No db table, no registry file — the filesystem is the truth (same model as global skills). `init.ts` only `mkdir -p`s the root; no extension is preinstalled.
- **The server scanner is the only validator.** Whoever puts a directory there (admin zip upload, `ext.sh`, manual `cp -r`) gets the same verdict. A directory that fails validation is still **listed** as `{ id, error }` so the admin shows "installed but broken" (red row, removable) rather than "not installed".
- Ids are directory names *and* URL segments: `^[a-z0-9][a-z0-9_-]{0,63}$` (`registry.ts` `ID_RE`, deliberately tighter than the session-id `isSafeIdSegment`; `ext.sh` carries a copy — keep in sync).

### Manifest (`halo-extension.json`)

| Field | Req | Rule |
|---|---|---|
| `id` | ✓ | `ID_RE`; **must equal the directory name** (`id mismatch` otherwise) |
| `name` | ✓ | ≤ 64 chars; shown in the open-with menu and Settings → Extensions |
| `version` | ✓ | semver `x.y.z[-pre]`; compared for **equality only**; part of the asset URL |
| `extensions` | ✓ | non-empty; each `^\.[a-z0-9]+$` (dot, lowercase); matched against the lowercased file ext |
| `entry` | ✓ | relative HTML path, no leading `/`, no `..`; file must exist |
| `priority` | – | `default` (default; opens the file directly) \| `option` (open-with menu only) |
| `capabilities` | – | `"save"` \| `"media"` (iframe gets `allow="microphone; display-capture; clipboard-write"`) \| `"transcribe"` (may open the server's [transcription proxy](#streaming-transcription-proxy)); **unknown value = manifest error** (reject rather than let the host silently drop a declared capability) |
| `bundle` | – | boolean, default `false`; `true` = every suffix names a **directory** (see [Bundle extensions](#bundle-extensions)). Non-boolean, or `true` together with `save` (`bundle extensions cannot declare save`) = manifest error |
| `platforms` | – | non-empty array of `web` \| `desktop-mac` \| `desktop-win` \| `desktop-linux` (deduped); omitted = everywhere. Empty / unknown value = manifest error |
| `settings` | – | `{ params?: [field…], secrets?: [field…] }`, field = `{ key, description?, description_zh?, default?, type?, options? }` (skill `config.yaml` format). Validated **strictly** (a skill's config.yaml is parsed leniently): `key` `^[a-z][a-z0-9_]{0,63}$`, unique across both lists, `type` ∈ string\|int\|float\|boolean\|enum (enum needs `options`), scalar `default` stringified; anything else = manifest error. `ExtensionInfo.settings` carries the declarations, never values. See [Extension settings](#extension-settings) |
| `description` / `homepage` / `license` | – | ≤ 200 chars / http(s) URL / free string, display only |

No `keepAlive` / `readonly` field: both are derived from `capabilities` (see MRU). No `minHaloVersion`: compatibility is the protocol version carried in `init`.

### Atomic install (`install.ts`, mirrored by `ext.sh`)

Every writer follows six steps so the root watcher sees one rename per change: unpack into `.tmp-unpack-<rand>` → strip one wrapper directory (`zip -r glb.zip glb/` shape) → pre-check with the scanner's own `readExtensionDir` → move existing `<id>/` aside to `.old-<id>-<rand>` → rename staging → `<id>/` → remove `.old` (on step-5 failure it is moved back). The unpack refuses entries with absolute paths, `..`, NUL, or symlink mode bits. Same id = upgrade *or downgrade* — there is no version comparison. `expectId` (skill path) must match the manifest id; the admin upload takes whatever the manifest says. A failed pre-check never touches a working install.

## Server

**Registry** (`registry.ts`). `scanExtensions()` runs at boot and when the watcher fires — never per request; routes read the cached `getSnapshot()`. Directories starting with `.` are skipped; a non-dot directory whose name isn't a valid id is listed as an error. `installedAt` = directory mtime, which the final rename refreshes (drives newest-wins). `parseManifest` is pure and takes an `entryExists` callback so it is unit-testable without a disk layout.

**Watcher** (`watcher.ts`). Non-recursive `fs.watch` on the root (same shape and same trade-off as `ws/git-dir-watcher.ts`): every install path ends in a rename *into* or an rm *of* a direct child, so one inode suffices and recursive-watch flakiness is avoided. Event burst → 300 ms debounce → rescan → compare `snapshotKey` (`id@version#installedAt` per extension + error list) → broadcast `extension:changed` (the **full** `ExtensionsSnapshot`, global `broadcast()`, not a diff) only if the key changed, so `.tmp-*` churn is silent. `error` → close, retry after 1 s. `rescanAndBroadcast()` is the single notifier: routes call it after their own writes so the response and the next `GET` are already fresh, but never broadcast themselves. Not started in AgentCore mode (no admin editor there).

Why not a "rescan" endpoint for the skill: an agent's shell has no admin cookie, so it would need a second auth scheme, and the admin-upload and skill paths would diverge. With `fs.watch` both converge on the same code with zero auth surface.

**Routes** (`routes/extensions.ts`, mounted under `/api`)

| Route | Auth | Notes |
|---|---|---|
| `GET /extensions` | cookie | `ExtensionsSnapshot` (valid + errors) |
| `POST /extensions/install` | cookie | multipart `file` = zip, `MAX_ZIP_BYTES` 100 MB (413 by `Content-Length`, then by `file.size`); 400 `{error}` on `ExtensionInstallError`, 500 otherwise |
| `DELETE /extensions/:id` | cookie | `rm -rf`; 404 if not installed |
| `GET /extensions/token` | cookie | `{ token, expiresAt }` — asset token, 24 h |
| `GET /extensions/:id/:version/:token/*` | **token in path** | static asset, below |

### Asset serving and the scoped token

The iframe first shipped as `sandbox="allow-scripts"` **without** `allow-same-origin` — an opaque origin. Measured (Playwright): the document navigation itself still carries the admin cookie, but **every subresource** it loads — classic/module `<script>`, `<img>`, CSS, `fetch`, wasm, dynamic `import()`, `Worker` — is a cross-site request with **no cookie**; module scripts, `fetch` and wasm additionally need `Access-Control-Allow-Origin`. The original design assumed subresources would inherit the cookie; they don't. And a `?token=` query does not survive either: the document resolves `./viewer.js` against its own URL and drops the query. That is why the asset credential lives in the path. (The host has since added `allow-same-origin` — see Host, below — for a reason the token can't solve: a cookie-auth proxy in front of halo. The token stays the asset route's one auth path regardless.)

So the credential travels as a **path segment**, which relative URLs inherit for free:

1. Admin calls `GET /api/extensions/token` (cookie-authed) → `mintScopedToken('ext', 24h)` = jwt `{ scope:'ext', iat, exp }` signed with the same secret as the login cookie.
2. Iframe `src` = `/api/extensions/<id>/<version>/<token>/<entry>`; `./decoders/x.wasm` inside resolves to `…/<token>/decoders/x.wasm`.
3. `authMiddleware` lets `EXTENSION_ASSET_PATH = /^\/api\/extensions\/[^/]+\/[^/]+\/[^/]+\/./` through without a cookie (≥ 4 segments, so it never overlaps list / install / token / `:id`); the route itself calls `verifyScopedToken(token, 'ext')` → else 401.
4. **The token can't be replayed as a login.** `validateToken` — the cookie check, shared with the WS upgrade's `isAuthenticated` — returns null for any payload that has a `scope`. The token appears in URLs and access logs, so it is good for exactly one thing: reading extension static files (any installed extension's, nothing else).

`resolveAsset(id, version, rest)` returns null (→ 404) unless: `id` is valid and installed *without error*; `version` **equals** the installed version; no path segment is empty, `.`, `..`, dot-prefixed or contains `\`; the `realpath` stays inside the extension's real directory (symlink guard; both sides realpath'd because the root may itself sit under a symlink); the target is a regular file. Response headers: `Content-Type` from `assetMime` (core's image table + html/js/mjs/css/json/**wasm**/fonts/bin), `Access-Control-Allow-Origin: *`, `Referrer-Policy: no-referrer` (token stays out of `Referer`), `Cache-Control: public, max-age=31536000, immutable`. The version in the URL *is* the cache key — an upgrade changes it. A stale tab holding the old version gets 404, which is the "reload me" signal. No CSP is set here; an extension can ship its own `<meta>` CSP.

### `PUT /files/raw` (save write-back)

`PUT /files` is utf-8 text only and `POST /files/upload` always writes under `.halo/uploads/`, so binary write-back got its own route in `routes/files.ts`: `?path=&projectId=[&expectMtime=][&create=1][&append=1]`, body = raw bytes, file **must already exist** (404 — save never creates) unless `create=1`, directories refused, path validated like the other file routes. If `expectMtime` is given and `Math.round(stat.mtimeMs) !== Math.round(expectMtime)` → `409 { error:'conflict', mtime, size }`; otherwise write and return `{ ok, path, mtime, size }`. The compare is a rounded float compare, so the baseline must be the `modifiedAt` from `GET /files/stat` (float ms). `create=1` creates a missing file (parents `mkdir -p`); `append=1` uses `appendFile` and ignores `expectMtime` — both exist for bundle `fs` write / append. `root=<dir>` (the bundle host always sends its bundle path) requires `<dir>` to be an existing directory with `path` strictly inside it, else `404 { error:'Bundle root not found' }` and nothing is created — so a bundle deleted / renamed mid-recording is never resurrected at its old path by `create=1`'s `mkdir -p`.

## Admin host

### Subscribable registry and resolution (`previews/registry.ts`)

Two layers behind one lookup: `builtins` (the eight compile-time plugins) and `snapshot` (runtime extensions). Every mutation `bump()`s a version counter; `useRegistryVersion()` is a `useSyncExternalStore` over it, so `FilePreview` and the editor's MRU effect re-resolve on change. The snapshot is fed by `GET /extensions` at workspace open, each `extension:changed` frame, and a re-fetch on WS reconnect (`state-handlers.ts`) — **no polling**. `editor-panel.tsx`'s old module-level `BINARY_EXTENSIONS` snapshot is gone; `isBinaryExtension(ext)` reads the registry live.

**Initial load (`loadExtensions()`).** The page's one `GET /extensions` is a single shared promise: `workspace-layout.tsx` kicks it off in parallel with the workspace resolve, and the editor's one-shot routing awaits the same request. Until it lands, "list not loaded" looks exactly like "nothing installed", and a wrong text verdict opens — and on tab restore persists — the file as text (a reloaded `.glb` tab came back as text this way). So `isBinaryExtension(ext)` (click-open, tab restore after reload, open-to-side) is async: a *preview* verdict (`NON_TEXT_FALLBACKS` or `canPreview(ext)` already true) returns at once, since extensions only add viewers ahead of text and `FilePreview` re-picks the viewer when the list lands; a *text* verdict awaits `loadExtensions()` first, because an extension may claim an extension-only type (`.glb`) or a text suffix (`.json`). The wait is capped at `INITIAL_LOAD_WAIT_MS` (3 s), counted from the first call, so a request hung on a dead connection (sleep / wake) can't block every open; past the cap it routes as if nothing were installed (`.glb` opens as text). The request isn't cancelled — a late list still lands through `setExtensions` and bumps the version. It never rejects and is never re-issued: a failed fetch leaves the layer empty without delaying later opens, and the WS-reconnect re-fetch / `extension:changed` fill it in.

`resolve(ext)` returns every way to open the file, best first:

1. `default` extensions, **newest `installedAt` first**
2. the built-in plugin, if any
3. `option` extensions (same ordering)
4. `text` (Open as Text) — always present, always last

Errored extensions never appear. With nothing installed this is `[builtin, text]` / `[text]` — identical to pre-extension behavior, and the open-with menu (rendered only when `candidates.length > 2`) stays hidden, so **zero installs = zero visible change**. Deliberate difference from VS Code: with several `default` handlers VS Code asks and remembers the answer in `editorAssociations`; we have nowhere to remember it, so newest-install wins deterministically and the user switches via the menu. Ext-less files (`''` can't be in a manifest) always go to the text editor.

**Open with** (`ui/open-with-menu.tsx`, state in `FilePreview.Dispatch`): picking a candidate sets a per-tab `override` — never persisted, forgotten when the tab closes; it is looked up by `resolvedKey` in the live candidates so an upgraded extension renders its fresh `info`. Picking `text` calls the existing `onOpenAsText`. Switching away from a dirty extension asks `confirmAction("… Discard them and switch viewer?")`.

### Iframe host (`extension-host.tsx` + `extension-host-logic.ts`)

The split is deliberate: `extension-host-logic.ts` is a **pure state machine** (`onClientFrame`, `onLoaded`, `onPutResult`, `onConflictChoice`, `onFileChanged`, `onSaveRequest`, `onThemeChange`), each taking `HostState` + one input and returning `{ state, effects[] }`; the React component only executes effects (`post`, `load`, `put`, `set-modified`, `error`, `confirm-conflict`, `warn`). That is what makes the protocol unit-testable frame by frame.

- Mount: `getExtensionToken()` → iframe `src` (`extension-token.ts`: module-level cache, in-flight dedupe, re-mint when < 60 s to expiry; an already-mounted iframe is never refreshed — it has its assets already).
- Attributes: `sandbox="allow-scripts allow-same-origin" allow="" referrerpolicy="no-referrer"` — the same grant as `html-preview.tsx`. `allow-same-origin` was withheld in the first cut (the path token made the cookie unnecessary for *halo*), but a cookie-auth reverse proxy in front of halo — the dev/prod CloudFront + midway Lambda, and equally oauth2-proxy / Cloudflare Access — authenticates **every** request by its own cookie, and an opaque-origin iframe sends none on module scripts / `fetch` / wasm (measured: classic `<script>` / `<img>` / CSS still carried the proxy's `SameSite=None` cookie; `mode: cors` requests carried nothing). The proxy 307'd `model-viewer.min.js` to its login page → the browser reported a CORS error → no `ready` → "extension unresponsive" after 10 s. Nothing halo-side can add a cookie to those requests; only `allow-same-origin` makes them first-party again. Trade-off accepted: the extension now runs in the admin's origin and can reach `parent.document` and the cookie-authed API — same boundary as an HTML preview, trust model "code the user chose to install" (like a skill).
- Sender check is `e.source === iframe.contentWindow` plus the `haloExt: 1` marker on every frame. `e.origin` is the admin's own origin for every extension iframe and can't distinguish two extensions.
- The extension never fetches the file: the host fetches `viewUrl` (streaming, no 10 MB cap) as an `ArrayBuffer` plus `GET /files/stat` for the mtime baseline, and **transfers** the buffer in `load`. `targetOrigin` is `'*'` (kept from the opaque-origin days; the frame only carries the file bytes the extension is about to be shown anyway).
- No `ready` within 10 s → "extension unresponsive" with Retry / Open as Text. `error` frame → banner above the iframe. Files > 100 MB (`EXTENSION_MAX_BYTES`, client memory) show the too-large placeholder instead of mounting.

### postMessage protocol v1

Types in `packages/core/src/protocol/extension-frames.ts` (`EXTENSION_PROTOCOL_VERSION = 1`), shared with hub extensions. All frames `{ haloExt: 1, type, … }`.

| Dir | `type` | Fields | Semantics |
|---|---|---|---|
| ext→host | `ready` | `protocol` | listener installed; host sends nothing before it. v1 host doesn't read `protocol` (field reserved for negotiation) |
| host→ext | `init` | `protocol`, `file{name,path,size,ext}`, `capabilities`, `theme`, `bundle`, `platform`, `lang` | once, right after `ready`; `capabilities` = what the host grants; for a bundle `file` is the directory; `platform` = host platform, `lang` = `zh`\|`en` admin UI language |
| host→ext | `load` | `buffer`, `mtime` | file bytes (transferred); resent when the file changes on disk and the doc isn't dirty → "replace current document". **Never sent to a bundle** |
| ext→host | `dirty` | `dirty` | needs `save` (or `bundle`, where it means "busy"); otherwise ignored + `console.warn` |
| ext→host | `fs` | `id`, `op: read\|write\|append\|list\|stat`, `path`, `buffer?` | bundle only (else `fs-result{denied}` + warn); `path` bundle-relative POSIX, validated before any request |
| host→ext | `fs-result` | `id`, `ok`, `buffer?` \| `entries?` \| `size?`+`mtime?` — or `code: not-found\|invalid-path\|denied\|io`, `error` | exactly one per `fs`, same `id`; `read` buffer transferred |
| host→ext | `save-request` | – | Save button pressed and doc dirty; ext answers `save` |
| ext→host | `save` | `buffer` | no `save` capability → `save-error{denied}`, no network; a save while one is in flight is dropped |
| host→ext | `saved` | `mtime` | PUT succeeded; ext clears dirty, `mtime` is the new baseline |
| host→ext | `save-error` | `reason: conflict\|denied\|io`, `message`, `mtime?` | ext stays dirty; UI is the host's |
| host→ext | `theme` | `theme` | on admin theme switch; may be ignored |
| ext→host | `error` | `message` | can't handle the file; host shows message + Open as Text / Download |

```
host                              extension
 |-- iframe src=…/<token>/entry --->|
 |<--------- ready{protocol:1} -----|
 |-- init{file,capabilities,theme} >|
 |   fetch(viewUrl) + stat          |
 |-- load{buffer,mtime} ----------->|  render
 |<--------- dirty{true} -----------|  markModified(path) → tab dot
 |   user clicks Save               |
 |-- save-request ----------------->|
 |<--------- save{buffer} ----------|
 |   PUT /files/raw?expectMtime=…   |
 |-- saved{mtime} ----------------->|  200        (409 → conflict flow below)
```

### Dirty, save, conflict

- `dirty` mirrors into the editor store (`markModified` / `clearModified`), so the tab dot and the existing close-tab `confirmAction` work unchanged. Unmounting or reloading with a dirty doc clears the dot with it.
- Save trigger is the toolbar **Save** button → `requestSave` → `save-request`; `editor-panel.handleSave` also forwards to the mounted host via `getExtensionHost(projectId, path)` (a module-level registry keyed by panel + path, same shape as `face-bridge.ts`). 5 s without a `save` reply → alert "did not respond".
- `file:changed` for an extension tab is routed by `editor-panel` to `host.fileChanged()` → stat → `onFileChanged`: ignored when `diskMtime <= state.mtime` (our own save's echo) or when dirty; otherwise re-`load`.
- **409**: `onPutResult` emits `confirm-conflict`. `confirmAction` is yes/no, so the three-way choice is two chained questions — *Overwrite the disk version?* yes → re-PUT once with the 409's mtime as `expectMtime` (`retried`; a second 409 → `save-error{conflict}` + banner); no → *Discard your changes and reload?* yes → re-`load`, no → cancel (stay dirty). IO failure → `save-error{io}` + banner, stays dirty.

### MRU, keep-alive, upgrade, uninstall

- `editor-panel` keeps the last 5 preview tabs mounted (`PREVIEW_CACHE_SIZE`); "heavy" previews mount active-only. `isHeavyPreview` is true for an extension **without** `save` and not `bundle`: nothing to lose on unmount, and each viewer may hold a WebGL context (Chrome caps ~16 per page). An extension **with** `save` stays in the MRU because its dirty state lives only in the iframe; a dirty preview is never evicted past the cap. The active heavy preview's wrapper is keyed by path: `FilePreview`'s `Dispatch` is keyed only by file extension and a host posts the file bytes once per mount, so switching between two heavy tabs of the same type (two `.ipynb`) used to keep showing the first file.
- **Upgrade while mounted** (`extension:changed` gives the tab a new `info.version`): not dirty → remount with the new URL; dirty → non-blocking banner "updated to vX" with a Reload link (`reload` asks to discard first).
- **Uninstall while mounted**: not dirty → `resolve()` drops the candidate and the tab falls to the next one (built-in plugin if the ext has one, else the fallback page). Dirty → `Dispatch` keeps rendering the last-shown extension (`uninstalled` banner) so the edits can still be saved; the loaded iframe already holds its assets, though a fresh load would 404. Once saved, the tab falls through the same way.
- **Fallback page** (`UnsupportedPreview`): "This file type has no built-in preview. Extensions for more file types are available at halo-hub ↗" + Open as Text / Download. The link is a constant — no lookup, no per-ext URL, no online recommendation (would need a network call or a bundled index that goes stale).
- **Settings → Extensions** (`features/settings/extensions-view.tsx`): upload zip, list (errors in red), remove with `confirmAction`. It never re-fetches after a mutation — `extension:changed` updates it.

### Bundle extensions

A `bundle: true` extension opens a **directory** whose name ends in one of its suffixes (`Standup.htrans/`) — a package the extension owns, first user `htrans` (meeting recorder). Routing is separate from files: `resolveBundle(ext)` lists bundle extensions only, `resolve(ext)` never does (a *file* `x.htrans` is untouched), and `isBundleName(name)` = a `default` bundle extension that runs here claims the suffix.

- **Explorer**: such a directory gets a package icon; clicking (or Enter on) the row opens it as a preview tab like a file, double-click too; only the chevron expands it, so its contents stay browsable. Context menu adds Open to the Side. "New File" with a bundle suffix runs `mkdir` and opens the new bundle. The tab has no Open as Text / Download. Persisted tabs carry `bundle: true`; on restore the tab reopens only if a bundle extension still claims it, otherwise it is dropped (the directory is never read as text).
- **Access**: no `load`; the extension reads and writes inside its directory with `fs` frames. The host maps them to `GET /files/download?inline=1` (read), `GET /files/tree` (list), `GET /files/stat` (stat) and `PUT /files/raw?create=1&root=<bundle>[&append=1]` (write / append; a vanished bundle → `not-found`), and serializes write / append **per path** (`createKeyedQueue`), so appends land in request order; other ops run concurrently. `file:changed` never reloads a bundle.
- **Busy**: `dirty: true` = "recording, don't drop me" → tab dot, close confirm (also when the same bundle is open in the other split pane — each pane runs its own iframe), MRU pin, page-unload warning: the browser always shows its generic beforeunload prompt; the desktop shell shows a native confirm, which the admin only triggers while a tab is busy or unsaved. Deleting, renaming or drag-moving a busy bundle (or an ancestor directory) asks the same close confirm first, then closes the tab **before** the file operation. Ctrl+S / Save does nothing on a bundle tab. Bundle extensions are never heavy (they stay in the MRU like `save` extensions). fs results that arrive after the iframe was remounted (retry / upgrade) are dropped.

### Platforms

`currentPlatform()` (`registry.ts`, computed once): UA contains `Electron/` → `desktop-mac|win|linux` by OS, else `web`. An extension whose `platforms` excludes it is skipped by every resolve (routes as if not installed; a bundle directory is a plain folder), the fallback page says `"<name>" only runs on: …`, and Settings → Extensions shows a platforms badge plus a gray "not supported here" tag.

### Extension settings

An installed extension with manifest `settings` gets one Settings section (`settings-schema.ts` `extensionSections()`, built from the registry's cached snapshot): `source: 'extension'`, namespace `ext-<id>` (prefixed so an extension id can't collide with a skill / provider namespace), title = manifest `name`, every field `globalOnly`, secrets `secret: true` (masked). Values live in the global `~/.halo/secrets/settings.yaml` at `ext-<id>.params.<key>` / `ext-<id>.secrets.<key>` and go through the ordinary `/settings` routes (workspace scope refused by the global-only backstop). Admin: Settings nav group **Extension settings** under Extensions. Values never reach the manifest, the hub or the `init` frame — only server code reads them (`getServerParam` / `getServerSecret` in `config.ts`, read per use, so no restart).

### Streaming transcription proxy

WS `/api/transcribe/stream?ext=<id>&lang=<auto|xx-XX>` (`routes/transcribe-ws.ts`) relays an extension's live audio to **Amazon Transcribe streaming** so AWS credentials never reach the browser. `index.ts` runs both WS servers in `noServer` mode behind one http `upgrade` dispatcher (`/ws` → admin socket, unchanged incl. AgentCore; `/api/transcribe/stream` → proxy, not mounted in AgentCore mode; any other path → socket destroyed) — a `ws` server attached with `{ server, path }` would 400 every other path's handshake.

- **Handshake**: login cookie (`isAuthenticated`, same as `/ws`) else 401; `ext` must be installed and declare `transcribe` else 403. The extension iframe is same-origin, so its WS carries the cookie.
- **Upstream**: `StartStreamTranscription` (`pcm`, 16 kHz). `lang=auto` (default) → `IdentifyMultipleLanguages` + `LanguageOptions` = `ext-<id>.params.auto_languages` → manifest default → `zh-CN,en-US`; otherwise `LanguageCode` (`^[a-z]{2}-[A-Z]{2}$`, else `error bad-request`). Region `ext-<id>.params.region` → manifest default → `us-east-1`. Credentials: all three of `ext-<id>.secrets.access_key_id` / `secret_access_key` / `session_token` empty → the SDK default chain (`defaultProvider()`); both keys set → static keys (+ `session_token` if set); any other partial set → `error credentials` naming the missing key(s), upstream never called (no silent switch to the machine's identity). All read per connection.
- **Frames**: client binary = PCM s16le mono 16 kHz, text `{"type":"end"}` = flush then server closes 1000. Server text: `ready` (sent on connect — the proxy is taking audio; it can't mean "Transcribe accepted" because the SDK's `send()` only resolves after the first audio event, so a client waiting for that would hit Transcribe's 15 s no-audio timeout; upstream rejections follow as `error`), `partial` / `final` `{start,end,text,lang}` (seconds from this stream's first audio byte), `error {code,message}` then close 1011. Codes: `credentials` (CredentialsProviderError / UnrecognizedClient / InvalidSignature / ExpiredToken / InvalidClientTokenId), `denied` (AccessDenied), `limit` (LimitExceeded), `bad-request` (BadRequest / bad `lang`), `io` (everything else, incl. > 30 s of audio queued unsent).
- **Lifetime**: the client WS closing aborts the upstream request and destroys the client (no orphan streams). Frames are capped at 1 MiB (`maxPayload`); a protocol violation (oversized frame → close 1009, invalid UTF-8 text → 1007) closes only that socket — each connection has an `error` listener, and the upgrade router never throws on a malformed request-target (unknown path → `400 Bad Request`). Reconnect across Transcribe's 4 h cap / ~15 s silence drop is the extension's job. Logs: `[Transcribe] stream open ext=… lang=… region=…` / `stream closed after Ns` / `stream error … code=…` (error name only) — never audio or credentials.

## `extension` skill and halo-hub

Built-in skill `templates/skills/extension/` (in `BUILTIN_SKILL_IDS`; `TEMPLATE_VERSION` bumped to 69 in the same change): object command `/extension install|list|remove|models` (`models` = model provider configs, see the end of this section), `requiresAccess: full`. The built-in `default` agent lists it in `skills:` (since `TEMPLATE_VERSION` 81), so `/extension` shows in the command popup wherever the default agent is the built-in one. The payload reaches the body as `$ARGUMENTS`; when it names a source the agent installs right away without confirming, and it mentions the hub only when asked what exists or when an install fails. Everything goes through `templates/ext.sh` (curl + unzip + node, + git for tag-based hubs; no `gh`). `ext.sh install <id|zip|url>`: a zip path / URL is used as given, an id is fetched from the hub (below); then the same pre-check + six-step atomic replace as the server. It never talks to the server — the watcher picks the rename up within ~300 ms. The `halo` skill has a one-line pointer.

**Hub resolution.** The hub is the skill's `hub_repo` param (`config.yaml` → Settings → Skills → extension, value at `extension.params.hub_repo`), passed to `ext.sh` as `HALO_HUB_REPO`; empty / unset / an unsubstituted `{{…}}` placeholder = `https://github.com/turmind/halo-hub`, `owner/repo` = GitHub. The logic is self-contained `hub_*` functions and `ext.sh` is source-able (sourcing only defines them), so a later skill / workspace installer can reuse it. The platform comes from the host:

- `github.com` → GitHub; a host containing `gitlab` → GitLab (subgroups ok); `codeberg.org` or a host containing `gitea` / `forgejo` → Gitea/Forgejo; any other `https` host is probed (Gitea `/api/v1/repos/…`, then GitLab `/api/v4/projects/…`; a JSON answer identifies it).
- On those platforms an id takes the newest non-draft, non-prerelease (GitLab: non-upcoming) release whose tag matches `^<id>-v\d` (so `glb` never picks a `glb-viewer-v…` tag), and its first `.zip` asset. Optional `GITHUB_TOKEN` (lifts the 60 req/h anonymous limit) / `GITLAB_TOKEN` (`PRIVATE-TOKEN`) / `GITEA_TOKEN` (`Authorization: token`) from the server environment are sent to the release API only.
- An API error or "no release" on an identified platform stops with a hint (set the token, or download the zip from the releases page and `install <path>`). **Never a git fallback**: a git checkout of a build-step extension lacks its build output and would install broken.
- Anything else (ssh, `ssh://`, `file://`, a local path, an https host that answered neither probe) → git mode: the highest `<id>-v<x.y.z>` tag by semver (prereleases skipped), shallow clone, `extensions/<id>/` minus the build inputs `pack.mjs` leaves out of a zip (`node_modules/`, `src/`, `package*.json`). Refused ("needs a build step") when the package has `fetch-deps.sh` / `build.sh` — a presence check, and all four current halo-hub extensions carry one, so a plain-git mirror of halo-hub installs none of them by id today.

The hub repo keeps one directory per extension (`glb` / `ipynb` commit their vendored deps, `fetch-deps.sh` only refreshes them; `drawio` / `excalidraw` gitignore their build output and commit only the inputs), `scripts/pack.mjs extensions/<id>` → `dist/<id>-<version>.zip` with contents at the zip root (maintenance scripts and build inputs excluded), and one release per tag `<id>-v<version>` carrying exactly one zip (a second one would be picked by accident). Skills and workspaces in the same repo are tagged `skill-<id>-v<ver>` / `ws-<id>-v<ver>`; nothing installs them yet. Catalog today (only `glb-v1.0.0` is released so far):

- `glb` 1.1.0 — `.glb .gltf .obj .stl`, `default`, read-only (`<model-viewer>` 4.3.1 offline bundle with Draco/Basis decoders; `.obj` / `.stl` converted in memory to GLB via three.js; `.gltf` must be self-contained — external `.bin` / textures → `error` frame; no `.mtl`).
- `ipynb` 1.0.0 — `.ipynb`, `default`, read-only notebook viewer (markdown, KaTeX math, highlighted code, outputs incl. images / HTML tables; no widgets / JS outputs).
- `drawio` 1.0.0 — `.drawio .dio`, `default`, `['save']`; offline draw.io v32.0.2 (~22 MB zip); release-zip install only (build step).
- `excalidraw` 1.0.0 — `.excalidraw`, `default`, `['save']`; offline Excalidraw 0.18 (~16 MB zip); release-zip install only (build step).

`glb` / `ipynb` are read-only, so active-only mount; `drawio` / `excalidraw` are the real-world references for the save protocol.

**`models` verb — model provider configs (since `TEMPLATE_VERSION` 84).** The same skill carries `/extension models` (and natural language "更新模型列表 / update the model list"): `ext.sh models update [--yes]` takes the hub's newest `models-v*` release (one zip with every provider yaml, `scripts/pack.mjs models` → `dist/models-<YYYY.MM.DD>.zip`), but only from an **https release-API hub** — a local path, plain git, ssh or `http://` hub is refused (extensions keep the rules above), and every curl runs with `--proto =https --proto-redir =https`. After the same zip safety checks (`safe_unzip`: no `..`, no absolute paths, no symlinks) it hands the unpacked directory to `${HALO_CLI:-halo} models install <dir> [--yes]`, which owns all validation and the write into `~/.halo/global/models.d/` (see [storage.md → Model registry format](storage.md#model-registry-format) and [guide/cli.md](../guide/cli.md#model-provider-configs-halo-models)); its exit code passes through — `3` = a new provider or changed endpoints, nothing written, the agent shows the list and re-runs with `--yes` only after the user agrees. `ext.sh models list` = `halo models list`. The server's `models.d` watcher reloads the registry and pushes `models:changed`.

## Extension capability boundary

An extension **can**: receive one file's bytes and metadata; render in its own iframe; load static assets from its own directory via the path token; report `error`; receive `theme`; with `save`, report `dirty` and hand back bytes for the host to write to **that same file**; with `bundle`, read / write / append / list / stat **inside its bundle directory** via `fs`; with `media`, use the microphone and screen capture; with `transcribe`, stream audio to the server's transcription proxy (results only — credentials stay server-side).

An extension **cannot** (sandbox + protocol): open popups, downloads, forms or navigate the top window; use camera / autoplay, or mic / screen capture without `media` (`allow=""`); add admin UI (toolbar, commands, sidebar); talk to other iframes. The **protocol** gives it no way to read or write any workspace file except the open one, or outside its bundle directory. Since the host grants `allow-same-origin` (see Host), the sandbox no longer isolates it from the admin's origin: a hostile extension *could* script `parent.document` or call the cookie-authed `/api/*` (measured: `fetch('/api/extensions')` from inside → 200). That is the accepted trust model — installing an extension is like installing a skill — not a gap to patch per route. **Outbound network is not blocked** — no CSP is injected, so `fetch('https://…')` works where the remote allows CORS; trust model is "code the user chose to install" (same as a skill), and hub policy is offline-capable extensions. A hard block would be one `Content-Security-Policy` header on the asset route, no protocol change.

Adding a capability: (1) extend `ExtensionCapability` + the `CAPABILITIES` whitelist in `registry.ts`; (2) add the frame type in `extension-frames.ts`; (3) gate it in `extension-host-logic.ts` (undeclared → ignore + warn, like `save`); (4) if it needs the server (e.g. reading a sibling file), the **host** calls `/api/files/*` — an extension never touches the API directly. Install, scan, watcher and registry stay untouched.

## Deviations from the original design

1. **Install / delete are not full-access-only.** The admin cookie carries no access level, so list / install / delete / token are all "any logged-in admin". Only the agent-side `extension` skill keeps `requiresAccess: full`.
2. **Ctrl/Cmd+S does nothing on an extension tab** — Monaco isn't mounted, so there's no global shortcut. The toolbar Save button is the only trigger.
3. **No banner for an external change while dirty.** The host keeps the local edits silently and relies on the 409 (with the Overwrite confirm) on the next save.
4. **Conflict UI is chained `confirmAction`s**, not a dedicated overwrite / discard / cancel dialog (see Dirty, save, conflict).
5. **Uninstalling under a dirty tab** keeps the iframe alive with a banner — no confirm. A non-dirty tab shows the fallback page.
6. **Tests are not co-located**: `packages/admin/test/{extension-host-logic,extension-token,preview-registry}.test.ts`, `packages/server/test/{extensions-registry,extensions-install,extensions-routes,files-raw}.test.ts`.
7. **`allow-same-origin` is granted** (design and first cut withheld it). Required for deployments behind a cookie-auth proxy; see Host and the capability boundary.
8. Smaller code-over-design points: the id regex is `ID_RE` (not `isSafeIdSegment`); staging dir is `.tmp-unpack-<rand>` (the id isn't known before unpacking); `snapshotKey` includes `installedAt`, so reinstalling the same version still broadcasts.

## Known limitations

- `file:changed` reaches an extension tab only after the admin sent a WS `subscribe` (it does when a session is selected). Opening a workspace without picking a session attaches no watcher, so an open viewer won't auto-refresh. Pre-existing behavior, not introduced here.
- `PUT /files/raw`'s `expectMtime` must be the float `modifiedAt` from `GET /files/stat` (compared rounded); an integer-seconds × 1000 value 409s. The route is stat-then-write, not atomic.
- Install is `.zip` upload or `ext.sh install` (release zip, or a tag in git mode) only: no marketplace, no online recommendations (the fallback page only links to the configured hub — `hub_repo` read from the settings schema, default turmind/halo-hub; a local-path / ssh hub is shown as plain text), no workspace-level install, no persisted "open with" choice, no backup of unsaved edits (MRU pinning is the only protection).
- Hub tokens go to the release API only; the zip download carries none (asset links redirect to other hosts and `curl -L` would forward the header), so installing by id from a private hub may fail at the download.

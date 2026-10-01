# Canvas preview extensions — installable file viewers in sandboxed iframes

> API: [dev/api.md → Canvas Preview Extensions](../dev/api.md#canvas-preview-extensions). WS frame `extension:changed`: [ws.md](ws.md#other-server--client-messages). User-visible behavior: [requirements/editor.md](../requirements/editor.md). Code: `packages/core/src/protocol/extension-{types,frames}.ts`, `packages/server/src/extensions/{registry,watcher,install}.ts` + `routes/extensions.ts` + `middleware/auth.ts` (scoped token), `PUT /files/raw` in `routes/files.ts`, `packages/admin/src/features/editor/previews/{registry,extension-host,extension-host-logic,extension-token}.ts(x)`, `packages/server/templates/skills/extension/`.

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
| `capabilities` | – | only `"save"` exists; **unknown value = manifest error** (reject rather than let the host silently drop a declared capability) |
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

`PUT /files` is utf-8 text only and `POST /files/upload` always writes under `.halo/uploads/`, so binary write-back got its own route in `routes/files.ts`: `?path=&projectId=[&expectMtime=]`, body = raw bytes, file **must already exist** (404 — save never creates), directories refused, path validated like the other file routes. If `expectMtime` is given and `Math.round(stat.mtimeMs) !== Math.round(expectMtime)` → `409 { error:'conflict', mtime, size }`; otherwise write and return `{ ok, path, mtime, size }`. The compare is a rounded float compare, so the baseline must be the `modifiedAt` from `GET /files/stat` (float ms).

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
| host→ext | `init` | `protocol`, `file{name,path,size,ext}`, `capabilities`, `theme` | once, right after `ready`; `capabilities` = what the host grants |
| host→ext | `load` | `buffer`, `mtime` | file bytes (transferred); resent when the file changes on disk and the doc isn't dirty → "replace current document" |
| ext→host | `dirty` | `dirty` | needs `save`; otherwise ignored + `console.warn` |
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

- `editor-panel` keeps the last 5 preview tabs mounted (`PREVIEW_CACHE_SIZE`); "heavy" previews mount active-only. `isHeavyPreview` is true for an extension **without** `save`: nothing to lose on unmount, and each viewer may hold a WebGL context (Chrome caps ~16 per page). An extension **with** `save` stays in the MRU because its dirty state lives only in the iframe; a dirty preview is never evicted past the cap.
- **Upgrade while mounted** (`extension:changed` gives the tab a new `info.version`): not dirty → remount with the new URL; dirty → non-blocking banner "updated to vX" with a Reload link (`reload` asks to discard first).
- **Uninstall while mounted**: not dirty → `resolve()` drops the candidate and the tab falls to the next one (built-in plugin if the ext has one, else the fallback page). Dirty → `Dispatch` keeps rendering the last-shown extension (`uninstalled` banner) so the edits can still be saved; the loaded iframe already holds its assets, though a fresh load would 404. Once saved, the tab falls through the same way.
- **Fallback page** (`UnsupportedPreview`): "This file type has no built-in preview. Extensions for more file types are available at halo-hub ↗" + Open as Text / Download. The link is a constant — no lookup, no per-ext URL, no online recommendation (would need a network call or a bundled index that goes stale).
- **Settings → Extensions** (`features/settings/extensions-view.tsx`): upload zip, list (errors in red), remove with `confirmAction`. It never re-fetches after a mutation — `extension:changed` updates it.

## `extension` skill and halo-hub

Built-in skill `templates/skills/extension/` (in `BUILTIN_SKILL_IDS`; `TEMPLATE_VERSION` bumped to 69 in the same change): object command `/extension install|list|remove`, `requiresAccess: full`. Everything goes through `templates/ext.sh` (curl + unzip + node; no `gh`; optional `GITHUB_TOKEN` lifts the 60 req/h anonymous limit). `ext.sh install <id|zip|url>`: an id resolves to the newest non-draft, non-prerelease GitHub release of `turmind/halo-hub` whose tag starts with `<id>-v`, and takes its first `.zip` asset; then the same pre-check + six-step atomic replace as the server. It never talks to the server — the watcher picks the rename up within ~300 ms. The `halo` skill has a one-line pointer.

The hub repo keeps one directory per extension that is *identical to the installed directory* (no build step, `cp -r` is a valid install), `scripts/pack.mjs extensions/<id>` → `dist/<id>-<version>.zip` with contents at the zip root, and one release per tag `<id>-v<version>` carrying exactly one zip (a second one would be picked by accident). Today: `glb` (`<model-viewer>` 4.3.1 offline bundle with Draco/Basis decoders, `.glb`, `default`, read-only, so active-only mount) and `echo-save` (`.echo`, `option`, `['save']` — the minimal reference for the save protocol).

## Extension capability boundary

An extension **can**: receive one file's bytes and metadata; render in its own iframe; load static assets from its own directory via the path token; report `error`; receive `theme`; with `save`, report `dirty` and hand back bytes for the host to write to **that same file**.

An extension **cannot** (sandbox + protocol): open popups, downloads, forms or navigate the top window; use camera / mic / autoplay (`allow=""`); add admin UI (toolbar, commands, sidebar); talk to other iframes. The **protocol** gives it no way to read or write any workspace file except the open one (no `readRelative` / `listDir`). Since the host grants `allow-same-origin` (see Host), the sandbox no longer isolates it from the admin's origin: a hostile extension *could* script `parent.document` or call the cookie-authed `/api/*` (measured: `fetch('/api/extensions')` from inside → 200). That is the accepted trust model — installing an extension is like installing a skill — not a gap to patch per route. **Outbound network is not blocked** — no CSP is injected, so `fetch('https://…')` works where the remote allows CORS; trust model is "code the user chose to install" (same as a skill), and hub policy is offline-capable extensions. A hard block would be one `Content-Security-Policy` header on the asset route, no protocol change.

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
- Install is `.zip` upload or `ext.sh install` only: no marketplace, no online recommendations (the fallback page links to halo-hub statically), no workspace-level install, no persisted "open with" choice, no backup of unsaved edits (MRU pinning is the only protection).

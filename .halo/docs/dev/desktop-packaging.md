# Desktop Packaging (Electron / DMG)

How to build the macOS desktop app (`Halo-0.1.0-arm64.dmg`). The desktop
build is a thin Electron shell (`packages/desktop`) that bundles a self-
contained server runtime + a private `node` binary + the admin static export,
then spawns the server as a child process and points a `BrowserWindow` at it.

See [design](../design/) for the server itself; this doc is only about the
packaging pipeline.

## Architecture

```
Halo.app
├── Electron main (packages/desktop/src/main.cjs)
│     • picks a free port, seeds ~/.halo, spawns the server, waits /api/health
│     • on quit: SIGTERM the server, SIGKILL fallback after 1.5s
└── resources/ (electron-builder extraResources)
      ├── server-runtime/   ← pnpm-deployed @turmind/halo-server tree (dist + node_modules + templates)
      ├── admin-out/         ← Next.js static export
      └── node              ← private node v22 binary (server child runs on this, NOT Electron's node)
```

Why a private `node`: the server's native addons (`better-sqlite3`,
`node-pty`) are prebuilt for node 22. Electron's embedded node is a different
ABI, so the server must run on a real node 22 — hence we download and bundle
one.

## One-shot build

```bash
cd packages/halo   # repo root
# 1. build the two upstream artifacts the stage script consumes
cd packages/admin && npx next build --no-lint && cd ../..
cd packages/server && ./node_modules/.bin/tsc && cd ../..

# 2. stage + package (arm64)
cd packages/desktop
CI=true pnpm dist:arm64
```

Output: `packages/desktop/dist/Halo-0.1.0-arm64.dmg` (~143 MB).

`pnpm dist:arm64` runs three steps (see `package.json` scripts):
`gen-icon` → `prepack-dmg` (`scripts/stage-runtime.mjs`) → `electron-builder
--mac --arm64`.

Other targets: `pnpm dist:x64` (Intel mac), `pnpm dist:win` (Windows nsis,
cross-staged from mac).

## Faster rebuilds

The staging pipeline is split so a code-only change doesn't redo the heavy
dependency work. Three levers, in order of how often they help:

1. **Auto-fast (automatic).** A full `pnpm dist:arm64` now fingerprints the
   dependency inputs (`packages/server/package.json`, `core/package.json`, the
   cli bundle's `dist-pub/package.json`, `pnpm-lock.yaml`, + target/node
   version) and records it in `resources/.stage-meta`. On the next run, if a
   prior full stage exists for the same target **and the fingerprint is
   unchanged**, staging auto-takes the fast path: it re-syncs only the compiled
   outputs (server `dist`, admin `out`, cli bundle) and reuses the existing
   `node_modules` + bundled `node`. Measured: full stage ~29 s → fast ~1.5 s.
   So after the first build, "I only changed TS" rebuilds skip the install
   entirely with no flag to remember.
   - Force a clean re-stage (e.g. you suspect a corrupt tree): `HALO_STAGE_FULL=1 pnpm dist:arm64`.
   - Any dependency edit changes the fingerprint → next build does a real stage automatically.

2. **Explicit fast (`--fast`).** `pnpm dist:arm64:fast` / `prepack-dmg:fast`
   force the fast path and hard-fail if no prior full stage exists. Same effect
   as auto-fast but explicit; auto-fast makes this rarely necessary.

3. **`npmRebuild: false`** (electron-builder.yml). The desktop package has no
   native deps of its own — `better-sqlite3` / `node-pty` / `@parcel/watcher`
   all live in the staged `server-runtime` / `cli-runtime` trees, already built
   for the target. Skipping `@electron/rebuild` removes dead time every pack.

**What's left (the ~70 s floor):** electron-builder itself — asar packing, dmg
generation, and Gatekeeper scanning the ~350 MB of `extraResources`. Neither
fast-staging nor `npmRebuild:false` touches that; it runs on every build.
A further win would be de-duplicating `cli-runtime` (~137 MB) against
`server-runtime` (~92 MB) — they share most deps (lark sdk, drizzle,
better-sqlite3, protobufjs) — but that needs the two trees to physically share
files without breaking cli's standalone require paths; deferred.

## Why `CI=true` is mandatory

`stage-runtime.mjs` runs `pnpm deploy --prod`, which under the hood does a
`pnpm install`. In a non-TTY shell (which is how these builds run) pnpm aborts
with `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY]` unless `CI=true` is set.

**Side effect (now auto-handled)**: `pnpm deploy --prod` prunes the *root
workspace*'s `node_modules` to prod-only as a side effect — the devDep symlinks
(`typescript`, `electron-builder`, `sharp`, `png-to-ico`) vanish, which used to
break the next `gen-icon` / `tsc` / build with `command not found` /
`ERR_MODULE_NOT_FOUND`. `stage-runtime.mjs` now runs `pnpm install` right after
the deploy to restore the full workspace, so this no longer bites. If you ever
hit a half-pruned tree manually, recover with:

```bash
CI=true pnpm install --config.verifyDepsBeforeRun=false
```

Still good practice: build server + admin **before** `pnpm dist:arm64`.

## Build steps in detail (`stage-runtime.mjs`)

1. **`pnpm deploy --legacy --prod`** → flattens `@turmind/halo-server` (+ the
   `@turmind/halo-core` workspace dep) into `resources/server-runtime/node_modules`
   with no symlinks, so the app is self-contained.
2. **Copy `templates/`** — `pnpm deploy` doesn't pick these up; copied
   explicitly. This is what carries the built-in skills (incl. `send-file`),
   agents, prompts, models into the dmg.
3. **Cross-arch native fixup** — when target arch/platform ≠ host, re-fetch
   `better-sqlite3` prebuilds via `prebuild-install`.
4. **Trim bloat** — drop non-target `node-pty` prebuilds, `better-sqlite3`'s
   C source, and the server's `src/`/`tests/`.
5. **Copy `admin-out/`** — the Next.js static export.
6. **Download + stage node** — fetch `node-v22.11.0-<platform>-<arch>` from
   nodejs.org, extract the `node` binary into `resources/`.
7. **codesign (ad-hoc)** — `codesign --force --sign -` on the node binary for
   Gatekeeper. **We deliberately do NOT `strip`** — see gotcha below.

## Gotchas (learned the hard way)

- **Never `strip` the bundled node binary.** Recent macOS `strip` (Xcode 26
  toolchain) trims the *dynamic* symbol table, not just debug symbols. The
  result: `dlopen()` of native addons (`better-sqlite3`, `node-pty`) crashes
  with SIGSEGV (server exits `code=null` / 139) before any JS runs. The dmg
  looks fine but won't boot. Keep the full ~114 MB binary; the ~30 MB saved
  isn't worth a dead app. (`stage-runtime.mjs` has the strip step removed.)

- **Desktop port is sequential from 9527 (NOT random), and that's load-bearing
  for persistence.** `main.cjs` `findFreePort()` tries 9527 first, then scans
  upward for the first free one, and passes it to the server child. It used to
  use `listen(0)` (an OS-random ephemeral port) — but the window loads
  `http://127.0.0.1:PORT`, and **localStorage is partitioned by origin**, so a
  changing port gave a brand-new origin every launch and silently wiped *all*
  persisted state (last folder, open session, expanded tree, editor tabs). A
  stable preferred port keeps the origin stable so localStorage survives
  restarts, while still stepping aside if 9527 is genuinely taken. (The
  user-facing `HALO_PORT` still only matters for CLI / web deployments — the
  server reads it from its own env.)

- **macOS GUI PATH is minimal — `spawn('halo')` can't find the launcher.**
  An app launched from Finder/Dock inherits launchd's bare PATH
  (`/usr/bin:/bin:/usr/sbin:/sbin`), which excludes `/usr/local/bin` where the
  "Install 'halo' Command" menu drops the launcher. The server child inherits
  this PATH, so the evo wrapper / cron runner's `spawn('halo', …)`
  (`resolveHaloCli()` returns bare `halo`) hit `spawn halo ENOENT` even
  though the launcher exists. `startServer()` in `main.cjs` therefore prepends
  the standard CLI dirs (`/usr/local/bin`, `/opt/homebrew/bin`, + sbin
  variants — the same set `tools/sandbox.js` assumes) to the child's
  `env.PATH`, **guarded by `process.platform === 'darwin'`** (Windows PATH uses
  `;` and these dirs don't exist there). Note this still requires the user to
  have run the menu action that installs `/usr/local/bin/halo`; a fresh
  install that never did has no `halo` on any PATH.

- **Server child lifecycle.** On `before-quit` the main process sends SIGTERM,
  then force-SIGKILLs after 1.5 s. This is the backstop for a wedged server
  whose main thread is stuck in a syscall and never delivers SIGTERM. Without
  it, a zombie server keeps holding the port / `server.lock`. (The file watcher
  is `@parcel/watcher` — VS Code's engine — using native recursive FSEvents/
  inotify with an ignore list; it replaced chokidar, whose recursive mode
  overflowed the macOS FSEvents queue on large repos and could deadlock on
  close. See `ws/file-watcher.ts`.)

- **Stale `server.lock`.** If a prior server was `kill -9`'d, its PID is left
  in `~/.halo/global/server.lock`. The server now probes whether that PID is
  alive on startup and self-heals (removes the lock + continues) instead of
  exiting 1. See `acquireSingleInstanceLock` in `packages/server/src/index.ts`.

- **Crash diagnostics.** Server stdout/stderr is tee'd to
  `~/.halo/logs/desktop.log`; the last 30 lines also surface in the crash
  dialog. Check that file first when a packaged build won't start.

- **No synchronous `window.confirm` / `window.prompt`.** Electron's renderer
  can't block on a native dialog, so the preload (`packages/desktop/src/preload.cjs`)
  shims both: the sync `window.confirm` shows an overlay but always returns
  `false`, and `window.prompt` returns `null`. Admin code that needs the real
  answer **must** use the async helpers in `packages/admin/src/shared/utils.ts`
  — `confirmAction()` (→ `window.haloConfirm`) and `promptInput()` (→
  `window.haloPrompt`) — and `await` them. Calling `window.confirm()` directly
  silently no-ops in the desktop app (the symptom: clicking OK on a delete
  confirm does nothing, because `if (!confirm(...)) return` always returns). In
  a plain browser the helpers fall back to the native sync dialogs.

## Verifying a build

```bash
# staged skills include send-file (and the other 6 built-ins)
ls packages/desktop/resources/server-runtime/templates/skills/

# compiled init carries the current template version + send-file
grep -o "TEMPLATE_VERSION = [0-9]*" packages/desktop/resources/server-runtime/dist/init.js

# the dmg exists
ls -lh packages/desktop/dist/*.dmg
```

Then mount the dmg, drag to /Applications, launch. First run shows the dark
setup window (password prompt); subsequent runs go straight to the workspace.
On upgrade, the server reseeds `~/.halo/global/skills/` from the bundled
templates because `TEMPLATE_VERSION` bumped — that's how a newly-added built-in
skill like `send-file` reaches existing users without manual steps.

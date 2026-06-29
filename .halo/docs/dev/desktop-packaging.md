# Desktop Packaging (Electron / DMG)

How to build the macOS desktop app (`Halo-0.1.5-arm64.dmg`). The desktop
build is a thin Electron shell (`packages/desktop`) that bundles a self-
contained server runtime + a private `node` binary + the admin static export,
then spawns the server as a child process and points a `BrowserWindow` at it.

See [design](../design/) for the server itself; this doc is only about the
packaging pipeline.

> **Before packaging, check for `desktop-packaging.local.md` in this directory**
> (gitignored, per-host). If present it carries operator/machine-specific setup
> not captured here — e.g. building on a Linux host (wine/32-bit, workspace
> build order, `corepack enable`) and artifact-distribution gotchas. Read it
> first; absence just means none were recorded on this machine.

## Architecture

```
Halo.app
├── Electron main (packages/desktop/src/main.cjs)
│     • picks a free port, seeds ~/.halo, spawns the server, waits /api/health
│     • on quit: SIGTERM the server, SIGKILL fallback after 1.5s
└── resources/ (electron-builder extraResources)
      ├── server-runtime/   ← pnpm-deployed @turmind/halo-server tree (dist + node_modules + templates), node-linker=hoisted (flat, no .pnpm symlink farm)
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
cd packages/admin && npx next build --no-lint && node scripts/copy-monaco.mjs && cd ../..
cd packages/server && ./node_modules/.bin/tsc && cd ../..

# 2. stage + package (arm64)
cd packages/desktop
CI=true pnpm dist:arm64
```

Output: `packages/desktop/dist/Halo-0.1.5-arm64.dmg` (~143 MB).

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
   all live in the staged `server-runtime` / `cli-runtime` trees, fixed up for
   the target *by `stage-runtime.mjs`* (not by electron-builder). Skipping
   `@electron/rebuild` removes dead time every pack. Note the staging fixups are
   what actually make these correct per-target — see the cross-stage gotchas.

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

0. **Stamp the build version** → write `<package.json version>-<short git sha>`
   (`-dirty` suffix if the tree has uncommitted changes) to
   `resources/halo-version`, on every path (full / fast / auto-fast — the sha
   changes per commit even when deps don't). Shipped via `extraResources`;
   `main.cjs` reads it and passes it as `HALO_VERSION` to the spawned server, so
   `GET /api/health` reports it and the admin settings sidebar shows `Halo
   v<version>`. Without it the server falls back to `'dev'`. Same
   `<version>-<sha>` scheme as the CLI bundle (`halo --version`), so all three
   agree. Dev (`electron .`) computes it live from git instead.
1. **`pnpm deploy --legacy --prod --config.node-linker=hoisted`** → flattens
   `@turmind/halo-server` (+ the `@turmind/halo-core` workspace dep) into
   `resources/server-runtime/node_modules` as a flat, real-directory tree (no
   `.pnpm` symlink farm), so the app is self-contained. `hoisted` on **every**
   target — see the dangling-self-symlink gotcha for why macOS can't use the
   default isolated layout.
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

- **`pnpm deploy` (default isolated linker) leaves a dangling self-symlink that
  escapes the .app — use `node-linker=hoisted` on EVERY target.** The default
  isolated layout creates `server-runtime/node_modules/.pnpm/node_modules/@turmind/halo-server
  -> ../../../../../../../server`, a relative climb whose depth only resolves
  *inside the monorepo* (back to `packages/server`). Once copied into
  `Halo.app/Contents/Resources/`, the same relative path points outside the
  bundle (`Halo.app/server`) and dangles. Symptom: a colleague who installs the
  dmg hits `No such file: /Applications/Halo.app/Contents/Resources/server-runtime/node_modules/.pnpm/node_modules/@turmind/halo-server`
  — even though the build machine runs fine, because there the symlink target
  *does* exist. The build also carried ~1100 symlinks (the whole `.pnpm` farm),
  slowing Gatekeeper's first-launch scan. Windows already used `hoisted` (mac-
  created Unix symlinks don't survive the copy into the .exe); we now use it on
  **all** targets — a flat, real-directory `node_modules` has neither the
  escaping self-symlink nor the farm. Verify: `find Halo.app -type l | wc -l`
  should be ~36 (Electron framework links only), and
  `find Halo.app -path '*@turmind/halo-server'` should be empty.
  *Note this is separate from the "is damaged" Gatekeeper prompt — that's the
  ad-hoc signature + download quarantine (`identity: null` in the yml), fixed
  per-machine with `sudo xattr -dr com.apple.quarantine /Applications/Halo.app`,
  or properly with a Developer ID signature + notarization.*

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

- **Build admin with `pnpm --filter @turmind/halo-admin build`, NOT a bare
  `next build` — Monaco won't ship otherwise.** The editor self-hosts Monaco
  (no CDN at runtime): `scripts/copy-monaco.mjs` stages `monaco-editor/min/vs`
  into `admin/out/monaco/vs`, and the admin `build` script chains it
  (`next build && copy-monaco.mjs`). Both downstream consumers (cli
  `build-bundle.mjs`, desktop `stage-runtime.mjs`) copy `admin/out` wholesale,
  so a missing `out/monaco/` propagates into every artifact. Symptom: editor
  opening *any* file throws `Uncaught SyntaxError: Unexpected token '<'` at
  `loader.js` — the server returned the 404 HTML page because Monaco's loader
  isn't there. This is exactly how a monaco-less 0.1.7 shipped: packaging ran a
  bare `npx next build --no-lint` (skipping copy-monaco), and cli's backstop
  copy silently failed because it resolved `monaco-editor` from cli's
  node_modules (it's *admin's* devDependency). Now hard-gated: both
  `build-bundle.mjs` and `stage-runtime.mjs` `process.exit(1)` if
  `admin-out/monaco/vs/loader.js` is absent, and every doc's build command ends
  with `&& node scripts/copy-monaco.mjs`. If you must run `next build`
  directly, append the copy step yourself.

- **Changing anything under `templates/` requires bumping `TEMPLATE_VERSION`
  (`packages/server/src/init.ts`) — otherwise the change never reaches existing
  installs.** Server startup only re-runs `ensureHaloHome` (the template
  reseed) when the on-disk `~/.halo/global/.template-version` is *strictly less
  than* the compiled `TEMPLATE_VERSION` (`index.ts` startup block). Equal → the
  whole reseed is skipped, so a template edit with no version bump is invisible
  to every machine that already has the prior version stamped. This bit the
  `team`-delegation rewrite: `default/AGENT.md` gained the "team whitelist"
  paragraph but `TEMPLATE_VERSION` stayed put, so upgraded users' `default`
  agent kept reading the old AGENT.md and didn't know what `team` was. It's an
  integer, not a hash — it must increase monotonically (a git sha would compare
  nonsensically and can decrease). Fresh `halo setup` always reseeds regardless,
  which is why it's easy to miss in dev. Rule: touch `templates/` → `+1` the
  version in the same commit.

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

- **Cross-staging needs a full restage — auto-fast skips the native fixup.**
  After editing `stage-runtime.mjs`, or any time you cross-stage a target whose
  `node_modules` differs from what's on disk, run with `HALO_STAGE_FULL=1`. The
  fast path only re-syncs compiled outputs and **reuses the existing
  `node_modules`**, so it never re-runs the per-target native fixups
  (`@parcel/watcher` swap, `better-sqlite3` prebuild-install). Symptom of
  forgetting: the win/x64 dmg still carries the host's arm64 binaries.

- **`@parcel/watcher` binary doesn't cross-stage via `npm install`.** Its
  per-platform binary package (`@parcel/watcher-win32-x64` etc.) declares
  `os`/`cpu`, so `npm install` on a mac host **silently skips it** — leaving
  only the host's `watcher-darwin-arm64` (dragged in by `pnpm deploy`), and the
  packaged app crashes with *"no prebuild or local build of @parcel/watcher
  found"*. `stage-runtime.mjs` `installParcelWatcherBinary()` fetches the right
  one with `npm pack` (no os/cpu gate) and extracts it into every `@parcel`
  scope it finds under `node_modules` (`findParcelScopesWithWatcher` walks for
  them — one under the flat `hoisted` layout, several if a tree is ever staged
  the default isolated way), removing the host's. Verify after
  a build: `find …/win-unpacked -path '*watcher-*' -name '*.node' | xargs file`
  should show only PE32 (win) / the target's Mach-O — no foreign arch.
  (`better-sqlite3` and `node-pty` don't hit this — they use `prebuild-install`
  and bundled multi-platform prebuilds respectively.)

- **`ENOTEMPTY` / `directory not empty` mid-stage or in electron-builder.** A
  prior stage's `resources/{cli,server}-runtime/node_modules` (or
  `dist/win-unpacked`) can fail to delete cleanly on macOS (open handles, deep
  nesting). Hard-clean before a full restage:
  `rm -rf resources/{cli-runtime,server-runtime,admin-out,node} dist/{win-unpacked,mac,mac-arm64}`
  then rebuild.

- **A `--x64` / `--win` pack also emits a stray `Halo-0.1.5-arm64.dmg` — it's
  poisoned, discard it.** electron-builder honours the yml's `arm64` mac target
  even when you pass `--x64`, so it re-packages the *current* (x64/win-staged)
  `resources/` as an arm64 dmg. That dmg's native binaries are the wrong arch.
  The real per-target artifacts are `Halo-0.1.5.dmg` (x64) and `Halo Setup
  0.1.5.exe` (win); only trust the arm64 dmg from an actual `dist:arm64` run.

## Verifying a build

```bash
# staged skills include send-file (and the other 6 built-ins)
ls packages/desktop/resources/server-runtime/templates/skills/

# compiled init carries the current template version + send-file
grep -o "TEMPLATE_VERSION = [0-9]*" packages/desktop/resources/server-runtime/dist/init.js

# build version stamp is clean (<version>-<sha>, no -dirty) — surfaces as
# "Halo v<version>" in the settings sidebar via GET /api/health
cat packages/desktop/dist/win-unpacked/resources/halo-version   # or resources/halo-version pre-pack

# the dmg exists
ls -lh packages/desktop/dist/*.dmg
```

Then mount the dmg, drag to /Applications, launch. First run shows the dark
setup window (password prompt); subsequent runs go straight to the workspace.
On upgrade, the server reseeds `~/.halo/global/skills/` from the bundled
templates because `TEMPLATE_VERSION` bumped — that's how a newly-added built-in
skill like `send-file` reaches existing users without manual steps.

# halo-node (Go)

The linked-machine client: a single standalone binary for Linux (amd64 / arm64 / armv7), macOS
(arm64 / amd64, cross-compiled only) and Windows amd64 that speaks the node protocol v1
(`packages/server/src/nodes/protocol.ts`). Design: `.halo/docs/design/node.md`.

Needs Go 1.27 (`go.mod` pins `toolchain go1.27.3`). No cgo.

## Build

```sh
./build.sh                    # dist/ Linux + macOS binaries + halo-node-windows-amd64.exe + SHA256SUMS
VER=2.2.1 ./build.sh          # release build
go build -o dist/halo-node ./cmd/halo-node   # host-only dev build
```

## Test

```sh
go vet ./... && go test ./...
```

`internal/*/testdata/js-truth.json` are expected values captured from Node — regenerate
after a Node upgrade and review the diff:

```sh
node testgen/gen-regex-truth.mjs   # → internal/jsregex/testdata/js-truth.json
node testgen/gen-jsv-truth.mjs     # → internal/jsv/testdata/js-truth.json
```

Regex differential fuzz (CI: 20k patterns, seed = run id; minimized diffs go into
`internal/jsregex/testdata/regex-regress.jsonl` via `--eval`):

```sh
node testgen/regex-fuzz.mjs --n 20000 --seed 1 > /tmp/re.jsonl
JSREGEX_VECTORS=/tmp/re.jsonl go test ./internal/jsregex -run Differential -count=1
```

rm-guard vectors (`internal/rmguard/testdata/vectors.json`) are generated from the server's
`sandbox.ts` `assertRmSafe`; CI fails when the TS no longer produces the committed file:

```sh
node testgen/gen-rmguard-vectors.mjs [--check]
```

## Install script

`install.sh` (POSIX sh) is what users pipe into `sh`: the release job stamps the tag into
`__HALO_VERSION__` and uploads it next to the binaries. It picks the arch, verifies against
`SHA256SUMS`, smoke-runs `--version`, and renames into `/usr/local/bin` (root) or `~/.local/bin`.
Linux and macOS (`uname -s` = Darwin: `arm64` / `x86_64`); CI runs `shellcheck` on it. Windows users download the exe directly.

## Run

```sh
HALO_NODE_TOKEN=hn_… ./dist/halo-node --server https://halo.example.com --root ~/work [--allow-shell] [--proxy http://127.0.0.1:12334]
./dist/halo-node --help
```

On Windows (PowerShell):

```powershell
$env:HALO_NODE_TOKEN = 'hn_…'
.\dist\halo-node-windows-amd64.exe --server https://halo.example.com --root 'C:\work'
```

`--allow-shell` uses cmd.exe with UTF-8 / GBK decoding and a Job Object to stop the entire command tree on cancel / timeout. Folder confinement handles Windows drives, case-insensitive paths and junctions. `~/` uses `USERPROFILE`.

Native `windows-latest` CI runs vet, tests (paths / junctions, mkdir, cmd, tree stop, decoding, errno) and builds / smoke-runs the exe. The rm guard is POSIX-only. macOS has no CI runner: the darwin builds are only cross-compiled, and `internal/jsv`'s errno table is Linux-only, so file errors there read `Unknown system error -<n>`. See `.halo/docs/guide/node.md` for downloads, checksums and a hidden Task Scheduler startup recipe (S4U, no stored password, no 72-hour limit).

## Layout

| Path | What |
|---|---|
| `cmd/halo-node` | flags, `--help`, startup checks |
| `internal/protocol` | wire v1, mirrors `packages/server/src/nodes/protocol.ts` |
| `internal/client` | WS to the hub, reconnect / backoff, close classification, proxy |
| `internal/exec` | the seven ops, ported from the server's `workspace-tools.ts` / `sandbox.ts` |
| `internal/nodepath` | `~/` expansion, folder-mode confinement |
| `internal/rmguard` | POSIX rm guard (`sandbox.ts` `assertRmSafe`) |
| `internal/jsregex` | JS (non-`u`) regex → regexp2 rewrite, plan §2.9 |
| `internal/jsv` | JS value / number / UTF-16 / JSON semantics, plan §2.1 |
| `testgen/` | Node scripts that (re)generate the testdata above |

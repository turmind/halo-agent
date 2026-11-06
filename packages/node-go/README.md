# halo-node (Go)

Single standalone binary for Linux (amd64 / arm64 / armv7) and Windows amd64 that speaks the `halo node` v1 protocol — a drop-in for the
TS `halo node` (same flags, same output text). Design and the accepted differences from
the TS client: `.halo/docs/design/node.md` ("Go client: known differences from the TS client").

Needs Go 1.27 (`go.mod` pins `toolchain go1.27.3`). No cgo.

## Build

```sh
./build.sh                    # dist/ Linux binaries + halo-node-windows-amd64.exe + SHA256SUMS
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
node conformance/gen-regex-truth.mjs   # → internal/jsregex/testdata/js-truth.json
node conformance/gen-jsv-truth.mjs     # → internal/jsv/testdata/js-truth.json
```

Regex differential fuzz (CI: 20k patterns, seed = run id; minimized diffs go into
`internal/jsregex/testdata/regex-regress.jsonl` via `--eval`):

```sh
node conformance/regex-fuzz.mjs --n 20000 --seed 1 > /tmp/re.jsonl
JSREGEX_VECTORS=/tmp/re.jsonl go test ./internal/jsregex -run Differential -count=1
```

## Conformance

`conformance/cases/*.json` (plan §3.3) run against a real hub, the TS `runNode` as the
live oracle and this binary side by side, every result compared. The TS side imports
`@turmind/halo-core` from `dist/`, so build core first:

```sh
pnpm --filter @turmind/halo-core build && ./build.sh
HALO_NODE_GO_BIN=$PWD/dist/halo-node-linux-amd64 \
  pnpm --filter @turmind/halo-server exec vitest run test/node-go-conformance.test.ts
# arm under qemu-user, smoke subset:
#   HALO_NODE_GO_BIN=$PWD/dist/halo-node-linux-arm64 HALO_NODE_GO_EXEC=qemu-aarch64 HALO_NODE_GO_SMOKE=1
```

## Install script

`install.sh` (POSIX sh) is what users pipe into `sh`: the release job stamps the tag into
`__HALO_VERSION__` and uploads it next to the binaries. It picks the arch, verifies against
`SHA256SUMS`, smoke-runs `--version`, and renames into `/usr/local/bin` (root) or `~/.local/bin`.
Linux-only; CI runs `shellcheck` on it. Windows users download the exe directly.

## Run

```sh
HALO_NODE_TOKEN=hn_… ./dist/halo-node --server https://halo.example.com --root ~/work [--allow-shell]
./dist/halo-node --help
```

On Windows (PowerShell):

```powershell
$env:HALO_NODE_TOKEN = 'hn_…'
.\dist\halo-node-windows-amd64.exe --server https://halo.example.com --root 'C:\work'
```

`--allow-shell` uses cmd.exe with UTF-8 / GBK decoding and a Job Object to stop the entire command tree on cancel / timeout. Folder confinement handles Windows drives, case-insensitive paths and junctions. `~/` uses `USERPROFILE`.

Native `windows-latest` CI runs vet, tests (paths / junctions, mkdir, cmd, tree stop, decoding, errno) and builds / smoke-runs the exe. The Linux TS-oracle conformance suite remains unchanged; its POSIX shell / filesystem fixtures are not run on Windows. The rm guard is POSIX-only in both clients. See `.halo/docs/guide/node.md` for downloads, checksums and a hidden Task Scheduler startup recipe (S4U, no stored password, no 72-hour limit).

## Layout

| Path | Mirrors (TS) |
|---|---|
| `cmd/halo-node` | `packages/cli/src/index.ts` `cmdNode` / `HELP_NODE` |
| `internal/protocol` | `packages/server/src/nodes/protocol.ts` |
| `internal/client` | `packages/cli/src/node-client.ts` |
| `internal/exec` | `node-exec.ts` + the `workspace-tools.ts` / `sandbox.ts` subset |
| `internal/nodepath` | `node-path.ts` |
| `internal/jsregex` | JS (non-`u`) regex → regexp2 rewrite, plan §2.9 |
| `internal/jsv` | JS value / number / UTF-16 / JSON semantics, plan §2.1 |

# halo-node (Go)

Single static binary that speaks the `halo node` v1 protocol — a drop-in for the
TS `halo node` (same flags, same output text). Spec: `.halo/docs/plans/node-go.md`.

Needs Go 1.27 (`go.mod` pins `toolchain go1.27.3`). No cgo.

## Build

```sh
./build.sh                    # dist/halo-node-linux-{amd64,arm64,armv7} + SHA256SUMS, VER=dev-<sha>
VER=2.2.0 ./build.sh          # release build
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
#   HALO_NODE_GO_BIN=$PWD/dist/halo-node-linux-arm64 HALO_NODE_GO_EXEC=qemu-aarch64-static HALO_NODE_GO_SMOKE=1
```

## Run

```sh
HALO_NODE_TOKEN=hn_… ./dist/halo-node --server https://halo.example.com --root ~/work [--allow-shell]
./dist/halo-node --help
```

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

# Contributing to Halo

Thanks for taking the time. Halo is young and moves fast; this page is the shortest path from "I have a change" to "it's merged" without tripping over the things that have bitten us before.

## Prerequisites

- **Node.js ≥ 22**
- **pnpm 11.4** — run `corepack enable` once and pnpm picks the pinned version from `packageManager` in the root `package.json`.

## Setup & build

```bash
pnpm install --frozen-lockfile
pnpm build          # core → server → acp-adapter → cli → admin, in that order
```

Packages live under `packages/`:

| Package | What it is |
|---|---|
| `core` | Shared building blocks (workspace / git manager / MIME table) |
| `server` | Hono + WebSocket — API, agent orchestration, serves the admin; port 9527 |
| `admin` | Next.js static export, served directly by the server |
| `cli` | The `halo` binary and the standalone TUI |
| `acp-adapter` | stdio JSON-RPC bridge for ACP clients (Claude Code etc.) |
| `desktop` | Electron shell (macOS dmg / Windows exe) |
| `web-demo`, `agentcore-demo` | Deployment examples |

## Running locally

`pnpm dev` starts every package's dev script in parallel. For manual testing against a real install, the same thing users do works fine:

```bash
npm install -g @turmind/halo && halo setup && halo server start
```

## Tests & lint

Everything is vitest, scoped per package:

```bash
pnpm --filter @turmind/halo-core test
pnpm --filter @turmind/halo-server test
pnpm --filter @turmind/halo-cli test
pnpm --filter @turmind/halo-acp-adapter test
pnpm --filter @turmind/halo-admin test
```

Lint: `pnpm --filter @turmind/halo-server lint` (same for `halo-cli` and `halo-admin`).

CI (`.github/workflows/ci.yml`) runs lint → typecheck build → all five test suites on every push; any red blocks merge. Before opening a PR, run the tests for the package you touched plus its `tsc` — the whole suite is 1100+ tests and takes about a minute per package, so you don't need all of it for a one-package change.

## Coding conventions

- TypeScript strict, ESM only.
- `camelCase` for variables/functions, `PascalCase` for types, `kebab-case` file names.
- React: function components, Tailwind for styling, shadcn/ui preferred.
- Log lines are `[ModuleName] message` with a **PascalCase** module prefix — the prefix is exported as an OpenTelemetry attribute, so casing is a dashboard key.
- Minimal diffs: change only what the issue requires, match the surrounding style, no drive-by refactors or comment rewrites.
- Every workaround gets a 1–2 line comment naming the root cause and where the real fix belongs.

## Two gotchas that have each shipped a regression

> **1. Touched anything under `packages/server/templates/`?** (bundled agents, skills, prompts, canvas)
> Bump `TEMPLATE_VERSION` in `packages/server/src/init.ts` **in the same commit**. The startup reseed only fires when the on-disk version is behind the compiled one — without the bump, existing installs never receive your change.

> **2. Build the admin with `pnpm --filter @turmind/halo-admin build`, never a bare `next build`.**
> The filtered script also runs `scripts/copy-monaco.mjs`; without it the editor ships without Monaco and 404s on `loader.js`.

## Commits & pull requests

- Subject line `type(scope): summary` — e.g. `fix(server): …`, `feat(channels): …`, `docs(cli): …` — and a body that explains the *why*. `git log` has plenty of examples to mirror.
- One concern per PR. Unrelated fixes are easier to review and revert as separate PRs.
- When behaviour changes, update the doc in the same PR. Docs live in `.halo/docs/` (`guide/` for users, `requirements/` for what to build, `design/` for how it works, `dev/` for API / tools / deploy) and are indexed from `.halo/INDEX.md`.
- Link the issue if there is one.

## AI-assisted contributions

Halo is built with Halo. The first month was written with Claude Code; since then the project has been developed by its own agents, with the maintainer reviewing every change. Agent-authored commits carry a `Co-Authored-By: halo <halo@turmind.com>` trailer.

You're welcome to work the same way, with whatever tool you like. The bar is the same either way: you have read and understood the diff you submit, it is tested, and you can answer questions about it in review. Please don't submit output you haven't read.

## Security

Don't open public issues for vulnerabilities — use GitHub's private vulnerability reporting as described in [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.

## License

By contributing you agree that your contributions are licensed under the repository's [MIT license](LICENSE).

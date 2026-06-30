/**
 * Adapter entry point. Parses CLI flags, wires stdin/stdout to a
 * JsonRpcConnection, instantiates the ACP↔halo adapter.
 *
 * This module is the binary's `main` (invoked from `halo acp`). It
 * exits with a non-zero code on argument errors and otherwise runs
 * forever (until the JSON-RPC peer closes stdin).
 */
import { AcpAdapter, type AdapterConfig } from './adapter.js'
import { JsonRpcConnection } from './jsonrpc.js'

interface ParsedArgs {
  host: string
  port: number
  token: string
  workspace: string
  agentId?: string
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: Partial<ParsedArgs> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eat = (name: string): string | undefined => {
      if (arg === `--${name}`) {
        const v = argv[i + 1]
        if (!v || v.startsWith('--')) return undefined
        i++
        return v
      }
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
      return undefined
    }
    const host = eat('host')
    if (host !== undefined) { out.host = host; continue }
    const port = eat('port')
    if (port !== undefined) {
      const n = Number(port)
      if (!Number.isFinite(n) || n <= 0) return { error: `invalid --port: ${port}` }
      out.port = n
      continue
    }
    const token = eat('token')
    if (token !== undefined) { out.token = token; continue }
    const ws = eat('workspace')
    if (ws !== undefined) { out.workspace = ws; continue }
    const ag = eat('agent-id')
    if (ag !== undefined) { out.agentId = ag; continue }
    if (arg === '--help' || arg === '-h') return { error: HELP }
    return { error: `unknown argument: ${arg}` }
  }
  if (!out.host) return { error: '--host is required' }
  if (!out.port) return { error: '--port is required' }
  if (!out.token) return { error: '--token is required' }
  if (!out.workspace) return { error: '--workspace is required' }
  return out as ParsedArgs
}

const HELP = `\
halo acp — bridge a halo server to an ACP client (e.g. Claude Code)

Usage:
  halo acp --host <h> --port <p> --token <t> --workspace <path> [--agent-id <id>]

Flags:
  --host        halo server hostname or IP (e.g. localhost, ec2-...).
  --port        halo server port (e.g. 9527).
  --token       a web-channel token (admin → Channels → Web → copy token).
                For multi-workspace use, the token must be created with
                full access — readonly/workspace tokens cannot override
                the workspace per request.
  --workspace   absolute path of the halo workspace to drive. Each
                adapter process binds to one workspace; run multiple
                adapters with the same token for multiple workspaces.
  --agent-id    optional. Halo agent profile to use when creating new
                sessions. Defaults to 'default'.

Stdio:
  reads ACP JSON-RPC requests on stdin, writes responses + notifications
  on stdout. Stderr is reserved for adapter diagnostics — do not parse.
`

export function main(argv: string[] = process.argv.slice(2)): void {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    process.stderr.write(parsed.error.endsWith('\n') ? parsed.error : parsed.error + '\n')
    process.stderr.write('\nRun with --help for usage.\n')
    process.exit(parsed.error === HELP ? 0 : 2)
  }

  const config: AdapterConfig = {
    baseUrl: `http://${parsed.host}:${parsed.port}`,
    token: parsed.token,
    workspace: parsed.workspace,
    agentId: parsed.agentId,
  }

  const conn = new JsonRpcConnection(process.stdin, process.stdout, (msg) => {
    process.stderr.write(`[acp-adapter] ${msg}\n`)
  })
  const adapter = new AcpAdapter(conn, config)
  void adapter // keep alive

  process.stdin.on('end', () => {
    // Peer closed stdin — exit cleanly.
    process.exit(0)
  })

  // Don't print to stdout — that channel is JSON-RPC only. A short
  // banner on stderr helps users confirm the adapter actually started.
  process.stderr.write(`[acp-adapter] connected to ${config.baseUrl}, workspace=${config.workspace}\n`)
}

// Run only when this file is the process entry point (`node …/acp-adapter/dist/index.js`).
// `halo acp` does NOT rely on this guard — cmdAcp calls `mod.main(subArgs)` explicitly.
//
// The guard is intentionally NOT `import.meta.url === file://${process.argv[1]}`: in the
// desktop bundle esbuild inlines this module into the cli's single-file `dist/index.js`,
// where `import.meta.url` resolves to that cli entry — identical to `process.argv[1]`. That
// made the guard fire on `halo acp`, calling main() with no argv (defaulting to
// process.argv.slice(2) = ['acp']) before cmdAcp ran, so the parser rejected `acp` itself
// with "unknown argument: acp". The path-suffix check can only match a standalone adapter
// file, never the inlined cli entry, so it is safe under bundling.
if (process.argv[1]?.endsWith('/acp-adapter/dist/index.js')) {
  main()
}

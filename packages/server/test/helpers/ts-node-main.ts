/**
 * The TS `halo node` as a standalone process — node-go-conformance.test.ts runs
 * it side by side with the Go binary. Mirrors cmdNode (packages/cli/src/index.ts)
 * minus HELP_NODE: the conformance runner compares only the first stderr line.
 * Run: node --import tsx test/helpers/ts-node-main.ts --server <url> [--root <dir>] [--allow-shell]
 */
import { parseArgs } from 'node:util'
import { runNode } from '../../src/nodes/node-client.js'

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    server: { type: 'string' },
    root: { type: 'string' },
    token: { type: 'string' },
    'allow-shell': { type: 'boolean', default: false },
    header: { type: 'string', multiple: true },
  },
})
const fail = (msg: string): never => {
  process.stderr.write(`halo node: ${msg}\n`)
  process.exit(1)
}
const token = values.token ?? process.env.HALO_NODE_TOKEN
if (!values.server) fail('--server is required')
if (!token) fail('--token (or HALO_NODE_TOKEN) is required')
const headers: Record<string, string> = {}
for (const h of values.header ?? []) {
  const i = h.indexOf(':')
  if (i <= 0) fail(`invalid --header (expected "Name: value"): ${h}`)
  headers[h.slice(0, i).trim()] = h.slice(i + 1).trim()
}
let handle: ReturnType<typeof runNode>
try {
  handle = runNode({ server: values.server!, token: token!, root: values.root, allowShell: values['allow-shell'], headers })
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
const stop = (): void => { void handle.stop() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.exit((await handle!.done).exitCode)

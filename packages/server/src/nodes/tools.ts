/**
 * The node_* tools (agent side of `halo node`). Prompt-cache invariant: names,
 * descriptions and schemas are constants of the code — never read the hub, the
 * db, env or the machine list at build time. Online state reaches the model
 * only through node_list's RESULT. Design: .halo/docs/design/node.md.
 */
import type { ToolDef } from '../agents/agent-loop.js'
import { createWorkspaceTools } from '../tools/workspace-tools.js'
import { getNodeHub } from './hub.js'
import { HEADER_RELAY, type NodeOp } from './protocol.js'

/** Not `halo server` (CLI / TUI, evo sandbox, AgentCore) — or cron's child
 *  without the relay env. Worded as permanent, like RELAY_UNAVAILABLE. */
export const NODES_UNAVAILABLE = 'linked machines are not available in this runtime — only `halo server` accepts `halo node` connections. This is permanent for this runtime, not a temporary outage: do not retry. Tell the user to run this from the admin UI or a channel connected to the server.'

export const NODE_TOOL_NAMES = ['node_list', 'node_read', 'node_write', 'node_edit', 'node_list_dir', 'node_grep', 'node_glob', 'node_run'] as const

/** Relay body op: a NodeOp, or 'nodes' = node_list. */
export type RelayOp = NodeOp | 'nodes'

const LIST_DESCRIPTION = [
  'List the user\'s linked machines (computers running `halo node`, paired with this workspace) and whether each is online.',
  'The other node_* tools act on one machine, named by `node` (a name from this list): node_read / node_write / node_edit / node_list_dir / node_grep / node_glob / node_run work like file_read / file_write / file_edit / file_list / grep / glob / shell_exec — same arguments, same output.',
  'A machine shares one folder (`root`), or everything when `wholeMachine` is true. Relative paths resolve against `root` (or `base`); paths outside `root` are refused.',
  'node_run needs `shell: true`.',
  'Offline machine: don\'t retry — ask the user to start `halo node`. "went offline during the call": the operation may or may not have taken effect — check before redoing it.',
].join('\n')

const NODE_PROP = { type: 'string', description: 'Machine name from node_list.' }
const PATH_DESC = 'Path on the machine — relative to its folder, or absolute (must stay inside `root`).'

/** Per tool: op, the local tool it mirrors, its description. */
const SPEC: Array<{ name: string; op: NodeOp; local: string; description: string }> = [
  { name: 'node_read', op: 'read', local: 'file_read', description: 'file_read on a linked machine (see node_list): `cat -n` output, offset / limit, files over 2 MB need a range.' },
  { name: 'node_write', op: 'write', local: 'file_write', description: 'file_write on a linked machine (see node_list): creates or overwrites the file, parent dirs included.' },
  { name: 'node_edit', op: 'edit', local: 'file_edit', description: 'file_edit on a linked machine (see node_list): exact string replacement; old_string must be unique unless replace_all.' },
  { name: 'node_list_dir', op: 'list', local: 'file_list', description: 'file_list on a linked machine (see node_list). Skips node_modules and .git; recursive stops at 500 entries.' },
  { name: 'node_grep', op: 'grep', local: 'grep', description: 'grep on a linked machine (see node_list): regex search, `file:line:content` results relative to the machine\'s folder.' },
  { name: 'node_glob', op: 'glob', local: 'glob', description: 'glob on a linked machine (see node_list): files matching a pattern, relative to the machine\'s folder.' },
  { name: 'node_run', op: 'run', local: 'shell_exec', description: 'shell_exec on a linked machine (see node_list) — only when it shows `shell: true`. Runs in `cwd` (default: its folder), killed after `shellTimeoutSec` (default 120); output capped at ~8000 chars, so redirect big output to a file and start long jobs with `nohup … &`.' },
]

/** The mirrored local tools' schemas, prefixed with the required `node`. Lazy:
 *  built once per process, from code only. */
let _schemas: Map<string, Record<string, unknown>> | null = null
function schemas(): Map<string, Record<string, unknown>> {
  if (_schemas) return _schemas
  const local = new Map(createWorkspaceTools('/tmp').map((t) => [t.name, t.inputSchema]))
  _schemas = new Map()
  for (const s of SPEC) {
    if (s.op === 'run') {
      _schemas.set(s.name, {
        type: 'object',
        properties: {
          node: NODE_PROP,
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Directory to run in, like `path` (default: the machine\'s folder).' },
        },
        required: ['node', 'command'],
      })
      continue
    }
    const base = local.get(s.local) as { properties: Record<string, unknown>; required?: string[] }
    const properties: Record<string, unknown> = { node: NODE_PROP }
    for (const [k, v] of Object.entries(base.properties)) {
      properties[k] = k === 'path' ? { ...(v as object), description: PATH_DESC } : v
    }
    _schemas.set(s.name, { type: 'object', properties, required: ['node', ...(base.required ?? [])] })
  }
  return _schemas
}

/** POST to the server's loopback relay (cron's `halo cli` child). */
async function relayCall(url: string, secret: string, body: { workspace: string; node?: string; op: RelayOp; args?: Record<string, unknown> }, signal?: AbortSignal): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER_RELAY]: secret },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(`could not reach the server's machine relay (${err instanceof Error ? err.message : String(err)})`)
  }
  const data = await res.json().catch(() => null) as { ok?: boolean; text?: string; error?: string } | null
  if (!res.ok || !data) throw new Error(`machine relay refused the call (HTTP ${res.status}${data?.error ? `: ${data.error}` : ''})`)
  if (!data.ok) throw new Error(data.error ?? 'failed on the machine')
  return data.text ?? ''
}

/** In the server process: the hub. In cron's child: the loopback relay. Else unavailable. */
function dispatch(workspace: string, op: RelayOp, node: string | undefined, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const hub = getNodeHub()
  if (hub) return op === 'nodes' ? Promise.resolve(hub.list(workspace)) : hub.call(workspace, node ?? '', op, args, signal)
  const url = process.env.HALO_NODE_RELAY_URL
  const secret = process.env.HALO_NODE_RELAY_TOKEN
  if (url && secret) return relayCall(url, secret, { workspace, node, op, args }, signal)
  return Promise.reject(new Error(NODES_UNAVAILABLE))
}

/** The fixed 8 tools, in NODE_TOOL_NAMES order. */
export function buildNodeTools(workspaceRoot: string): ToolDef[] {
  const s = schemas()
  const list: ToolDef = {
    name: 'node_list',
    description: LIST_DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, required: [] },
    callback: (_input: unknown, signal?: AbortSignal) => dispatch(workspaceRoot, 'nodes', undefined, {}, signal),
  }
  return [list, ...SPEC.map((spec): ToolDef => ({
    name: spec.name,
    description: spec.description,
    inputSchema: s.get(spec.name)!,
    callback: (input: unknown, signal?: AbortSignal) => {
      const { node, ...args } = (input ?? {}) as Record<string, unknown>
      if (typeof node !== 'string' || !node) return Promise.reject(new Error('`node` is required — a machine name from node_list'))
      return dispatch(workspaceRoot, spec.op, node, args, signal)
    },
  }))]
}

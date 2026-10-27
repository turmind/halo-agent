/**
 * Runs one `halo node` request on the machine by delegating to the local
 * workspace tools (createWorkspaceTools at full access), so output — `cat -n`,
 * `File edited:`, grep's `rel:line:text`, the __TOOL_WARN__ / __TOOL_ERROR__
 * markers — is exactly what the same tool prints on the server.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDef } from '../agents/agent-loop.js'
import { createWorkspaceTools, type WorkspaceToolsOptions } from '../tools/workspace-tools.js'
import { NODE_RESULT_MAX_CHARS, type NodeOp } from './protocol.js'
import { expandHome, resolveInRoot } from './node-path.js'

const OP_TOOL: Record<NodeOp, string> = {
  read: 'file_read', write: 'file_write', edit: 'file_edit', list: 'file_list', grep: 'grep', glob: 'glob', run: 'shell_exec',
}

export const SHELL_DISABLED = 'node_run is disabled on this machine — the user must restart `halo node` with --allow-shell to allow commands'

/** `root` = realpath'd shared folder, null = whole-machine mode. `base` = where
 *  relative paths and node_run's default cwd resolve (= root in folder mode). */
export interface NodeScope {
  root: string | null
  base: string
  allowShell: boolean
}

export type NodeExecutor = (op: NodeOp, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>

/** A request the machine turned down (logged as `refused`), vs. a tool failure. */
class Refusal extends Error {
  constructor(message: string, readonly reason: string) { super(message) }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/** The one-line terminal log of a request: `read src/a.ts`, `run (cwd .): npm test`. */
function labelOf(op: NodeOp, args: Record<string, unknown>): string {
  const str = (v: unknown, d: string) => (typeof v === 'string' && v !== '' ? v : d)
  if (op === 'run') return `run (cwd ${str(args.cwd, '.')}): ${str(args.command, '')}`
  const pattern = op === 'grep' || op === 'glob' ? ` ${JSON.stringify(args.pattern ?? '')}` : ''
  return `${op} ${str(args.path, '.')}${pattern}`
}

export function createNodeExecutor(scope: NodeScope, log: (line: string) => void = (l) => console.log(l)): NodeExecutor {
  // Empty namespace set: `{{x.params.y}}` placeholders in node_run commands are
  // never substituted — the machine's own settings secrets never reach a command.
  const opts: WorkspaceToolsOptions = { accessLevel: 'full', allowedNamespaces: new Set(), supportsVision: false }
  const toolsAt = (dir: string) => new Map(createWorkspaceTools(dir, opts).map((t) => [t.name, t]))
  const local = toolsAt(scope.base)

  /** The path to hand the local tool (resolved against `base`, like the tool
   *  itself does); throws the refusal when it lands outside the root. The
   *  agent's own string is kept when it already means the checked path, so the
   *  output (`File written: <path>`) reads exactly as the local tool's. */
  function place(p: string): string {
    const plain = path.resolve(scope.base, expandHome(p))
    if (scope.root === null) return p
    const full = resolveInRoot(scope.root, p)
    if (full === null) throw new Refusal(`"${p}" is outside this machine's shared folder (${scope.root}) — node tools can only reach paths inside it`, 'outside root')
    return full === plain ? p : full
  }

  /** Validate + rewrite the args into the local tool's input. */
  function prepare(op: NodeOp, args: Record<string, unknown>): { tool: ToolDef; input: Record<string, unknown> } {
    const name = OP_TOOL[op]
    if (!name) throw new Error(`unknown op "${String(op)}"`)
    if (op === 'run') {
      if (!scope.allowShell) throw new Refusal(SHELL_DISABLED, 'shell disabled')
      const command = typeof args.command === 'string' ? args.command : ''
      if (!command.trim()) throw new Error('`command` is required')
      const cwdArg = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : '.'
      const cwd = path.resolve(scope.base, expandHome(place(cwdArg)))
      if (!isDir(cwd)) throw new Error(`cwd "${cwdArg}" is not a directory on this machine`)
      // shell_exec runs in its tools' workspaceRoot; assertRmSafe then guards
      // cwd and every parent of it — the shared root included.
      return { tool: (cwd === scope.base ? local : toolsAt(cwd)).get(name)!, input: { command } }
    }
    if ((op === 'read' || op === 'write' || op === 'edit') && typeof args.path !== 'string') throw new Error('`path` is required')
    const p = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
    return { tool: local.get(name)!, input: { ...args, path: place(p) } }
  }

  return async (op, args, signal) => {
    const label = labelOf(op, args)
    let call: ReturnType<typeof prepare>
    try {
      call = prepare(op, args)
    } catch (err) {
      if (err instanceof Refusal) log(`[Node] refused ${label}: ${err.reason}`)
      throw err
    }
    log(`[Node] ${label}`)
    const raw = await call.tool.callback(call.input, signal)
    const text = typeof raw === 'string' ? raw : raw.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    return text.length > NODE_RESULT_MAX_CHARS
      ? `${text.slice(0, NODE_RESULT_MAX_CHARS)}\n[Content truncated on the machine: ${text.length} chars total]`
      : text
  }
}

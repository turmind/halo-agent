/**
 * `halo node` wire protocol (v1): one WS per linked machine, JSON text frames.
 * Shared by the server hub (hub.ts) and the machine-side client (node-client.ts).
 * Design: .halo/docs/design/node.md.
 */

export const NODE_WS_PATH = '/api/nodes/connect'
/** Loopback relay for cron's `halo cli` child (routes.ts, tools.ts). */
export const NODE_CALL_PATH = '/api/nodes/call'
export const NODE_PROTOCOL = 1
/** ws maxPayload on both ends. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** The machine truncates a result to this many chars before sending it. */
export const NODE_RESULT_MAX_CHARS = 256 * 1024

export type NodeOp = 'read' | 'write' | 'edit' | 'list' | 'grep' | 'glob' | 'run'
export const NODE_OPS: ReadonlySet<string> = new Set<NodeOp>(['read', 'write', 'edit', 'list', 'grep', 'glob', 'run'])

/** Handshake headers (not the query string — keeps the token out of proxy logs). */
export const HEADER_PROTOCOL = 'x-halo-node-protocol'
export const HEADER_INSTANCE = 'x-halo-node-instance'
export const HEADER_INFO = 'x-halo-node-info'
/** Relay secret header on NODE_CALL_PATH. */
export const HEADER_RELAY = 'x-halo-node-relay'

/** Close codes beyond the standard 1000 (normal) / 1001 (server going away). */
export const CLOSE_REVOKED = 4001
export const CLOSE_REPLACED = 4009

/** What the machine announces in `x-halo-node-info`. `root: null` = whole-machine
 *  mode (no folder limit); `base` = its start dir, which relative paths and
 *  node_run's default cwd resolve against (= root in folder mode). */
export interface NodeInfo {
  root: string | null
  base: string
  shell: boolean
  shellTimeoutMs: number
  os: string
  hostname: string
  version: string
}

export type ServerFrame =
  | { t: 'welcome'; name: string; workspace: string }
  | { t: 'req'; id: string; op: NodeOp; args: Record<string, unknown> }
  | { t: 'cancel'; id: string }

export type NodeFrame =
  | { t: 'res'; id: string; ok: true; text: string }
  | { t: 'res'; id: string; ok: false; error: string }

export function encodeNodeInfo(info: NodeInfo): string {
  return Buffer.from(JSON.stringify(info)).toString('base64url')
}

/** null on anything malformed — the header is client input. */
export function decodeNodeInfo(raw: string | undefined): NodeInfo | null {
  if (!raw) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as Record<string, unknown>
    if (v.root !== null && typeof v.root !== 'string') return null
    if (typeof v.base !== 'string' || typeof v.shell !== 'boolean' || typeof v.shellTimeoutMs !== 'number') return null
    return {
      root: v.root as string | null,
      base: v.base,
      shell: v.shell,
      shellTimeoutMs: v.shellTimeoutMs,
      os: String(v.os ?? ''),
      hostname: String(v.hostname ?? ''),
      version: String(v.version ?? ''),
    }
  } catch {
    return null
  }
}

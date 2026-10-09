/**
 * A2A v1.0 wire shapes (JSON-RPC binding) — just the slice halo speaks.
 * Plain JSON, not the SDK's proto-shaped types (see plans/a2a.md §5).
 */

export const A2A_VERSION = '1.0'
export const A2A_CONTENT_TYPE = 'application/a2a+json'
export const CARD_SUFFIX = '.well-known/agent-card.json'

export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  NOT_CANCELABLE: -32002,
  UNSUPPORTED: -32004,
  CONTENT_TYPE: -32005,
  VERSION: -32009,
} as const

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

export type TaskState = 'working' | 'completed' | 'failed' | 'canceled'
export const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'canceled'])

const WIRE_STATE: Record<TaskState, string> = {
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
}
export function wireState(s: string): string { return WIRE_STATE[s as TaskState] ?? 'TASK_STATE_UNSPECIFIED' }
/** Wire → row state ('' for anything halo never stores). */
export function rowState(wire: string): TaskState | '' {
  const hit = (Object.keys(WIRE_STATE) as TaskState[]).find((k) => WIRE_STATE[k] === wire)
  return hit ?? ''
}

/** One `a2a_tasks` row. */
export interface TaskRow {
  id: string
  workspace: string
  context_id: string
  account_id: string
  message_id: string | null
  state: TaskState
  status_text: string | null
  error_kind: string | null
  result: string | null
  interim_seq: number
  created_at: number
  updated_at: number
}

export interface WireMessage {
  messageId: string
  role: string
  parts: Array<{ text: string }>
  taskId?: string
  contextId?: string
}

export function agentMessage(row: Pick<TaskRow, 'id' | 'context_id'>, messageId: string, text: string): WireMessage {
  return { messageId, role: 'ROLE_AGENT', parts: [{ text }], taskId: row.id, contextId: row.context_id }
}

export function statusJson(row: TaskRow): Record<string, unknown> {
  const status: Record<string, unknown> = { state: wireState(row.state), timestamp: new Date(row.updated_at).toISOString() }
  if (row.status_text) status.message = agentMessage(row, `${row.id}-status`, row.status_text)
  return status
}

/** Final text as an Artifact: `result` on COMPLETED, `partial` on FAILED / CANCELED. */
export function resultArtifact(row: TaskRow): Record<string, unknown> | null {
  if (row.result == null) return null
  const name = row.state === 'completed' ? 'result' : 'partial'
  return { artifactId: name, name, parts: [{ text: row.result }] }
}

export function taskJson(row: TaskRow, includeArtifacts = true): Record<string, unknown> {
  const task: Record<string, unknown> = { id: row.id, contextId: row.context_id, status: statusJson(row) }
  if (includeArtifacts) {
    const art = resultArtifact(row)
    task.artifacts = art ? [art] : []
  }
  if (row.error_kind) task.metadata = { 'halo/errorKind': row.error_kind }
  return task
}

export function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result }
}
export function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

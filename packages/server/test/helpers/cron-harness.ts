/**
 * In-process cron test harness: a real SessionManager on a temp workspace
 * whose sessions run a scripted stub agent (no model runtime), wired into the
 * cron runner as its registry. Shared by the cron runner / recovery tests.
 *
 * The agentcore-invocations.test.ts pattern: `createSession` and the
 * disk-restore path (`ensureSession`) are spied to seed the stub instead of
 * building a model runtime. Call `installCronHarness()` inside a test file's
 * `beforeEach` (after the cron db is set) and `teardownCronHarness()` in its
 * `afterEach`.
 */
import { vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SessionManager } from '../../src/agents/session-manager.js'
import { agentSessions } from '../../src/db/schema.js'
import { setCronSessionRegistry, stopCronDaemon, _inflight, _runs, _inflightSessions } from '../../src/cron/runner.js'

/** One scripted turn: what the stub agent yields for one model-bound input. */
export interface StubTurn {
  /** The final reply (`text` event flagged final). Empty = no closing reply. */
  reply?: string
  /** Mid-turn (non-final) text before the reply. */
  stream?: string
  /** Throw this from the stream (an unrecoverable model error → turnError). */
  error?: string
  /** stopReason 'max_tokens' → a root `system` notice (Response truncated). */
  truncated?: boolean
  /** stopReason 'refusal' (an HTTP 200 stop) instead of a reply → turnErrorKind 'refusal'. */
  refusal?: boolean
  /** Hold the turn until this resolves (an abort ends it early). */
  gate?: Promise<void>
}

export interface CronHarness {
  sm: SessionManager
  ws: string
  /** Every model-bound input, in order (prompt + preamble). */
  inputs: string[]
  /** Script for the next turns; a turn with nothing scripted replies `ok: <n>`. */
  turns: StubTurn[]
  /** Calls to createSession: [agentId, description, explicitId, workingDir, accessLevel, title]. */
  created: Array<{ agentId: string; description: string; id: string; workingDir: string | null; accessLevel: 'readonly' | 'workspace' | null; title?: string }>
  /** Insert a session row (+ in-memory stub), as createSession / a restore would leave it. */
  seedSession(id: string, opts?: { agentId?: string; accessLevel?: 'readonly' | 'workspace' | null; workingDir?: string | null; inMemory?: boolean }): void
}

let current: CronHarness | null = null

function stubAgent(h: CronHarness) {
  return {
    messages: [] as unknown[],
    async *run(input: unknown, opts?: { cancelSignal?: AbortSignal }): AsyncGenerator<Record<string, unknown>> {
      const signal = opts?.cancelSignal
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      h.inputs.push(text)
      const turn = h.turns.shift() ?? {}
      await new Promise((r) => setTimeout(r, 5))
      // A non-final text: lands in session.output, not finalOutput.
      if (turn.stream) yield { type: 'text', text: turn.stream }
      if (turn.gate) {
        await Promise.race([
          turn.gate,
          new Promise<void>((resolve) => {
            if (signal?.aborted) resolve()
            signal?.addEventListener('abort', () => resolve())
          }),
        ])
        if (signal?.aborted) return
      }
      if (turn.error) throw new Error(turn.error)
      if (turn.truncated) yield { type: 'stop', stopReason: 'max_tokens' }
      if (turn.refusal) {
        yield { type: 'stop', stopReason: 'refusal', stopDetails: { category: 'harmful', explanation: 'nope' } }
        return
      }
      const reply = turn.reply ?? `ok: ${h.inputs.length}`
      if (reply) yield { type: 'text', text: reply, final: true }
    },
  }
}

function inMemorySession(h: CronHarness, id: string, agentId: string, accessLevel: 'readonly' | 'workspace' | null, workingDir: string | null) {
  return {
    id, parentId: null, agentId, agentName: agentId, agent: stubAgent(h), description: '',
    output: '', lastActivityAt: null, finalOutput: '', turnError: null, turnErrorKind: null, promise: null,
    abortController: null, messageQueue: [],
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, compactedThisTurn: false,
    systemPrompt: '', thinkingEffort: 'off', workingDir, accessLevel,
    supportsImage: false, lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
}

/** A real SessionManager on `ws` (created if missing), registered as the cron
 *  runner's registry. `opts.ledger` builds it as the long-lived server does
 *  (runtime claim + run-ledger boot sweep). */
export function installCronHarness(ws: string, opts: { ledger?: boolean; register?: boolean } = {}): CronHarness {
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  const h: CronHarness = {
    sm: null as unknown as SessionManager,
    ws,
    inputs: [],
    turns: [],
    created: [],
    seedSession(id, o = {}) {
      const agentId = o.agentId ?? 'default'
      const accessLevel = o.accessLevel ?? null
      const workingDir = o.workingDir ?? null
      h.sm.getDb().insert(agentSessions).values({
        id, parentId: null, agentId, agentName: agentId, description: '',
        workingDir, accessLevel, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
      }).run()
      if (o.inMemory !== false) {
        ;(h.sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, inMemorySession(h, id, agentId, accessLevel, workingDir))
      }
    },
  }
  current = h
  // createSession builds a model runtime; the stub stands in (no agents in this HOME).
  vi.spyOn(SessionManager.prototype, 'createSession').mockImplementation(async function (this: SessionManager, agentId, _p, description, _n, explicitId, workingDir, accessLevel, title) {
    const id = explicitId!
    const rel = workingDir ? path.relative(this.workspaceRoot, workingDir) : null
    h.created.push({ agentId, description, id, workingDir: rel, accessLevel: accessLevel ?? null, ...(title ? { title } : {}) })
    h.seedSession(id, { agentId, accessLevel: accessLevel ?? null, workingDir: rel })
    return id
  })
  // A released session restores from disk through buildAgentInstance; re-seed
  // the stub from its row instead.
  const proto = SessionManager.prototype as unknown as { ensureSession: (id: string) => Promise<unknown> }
  const realEnsure = proto.ensureSession
  vi.spyOn(proto, 'ensureSession').mockImplementation(async function (this: SessionManager, id: string) {
    const sessions = (this as unknown as { sessions: Map<string, unknown> }).sessions
    if (!sessions.has(id)) {
      const row = this.getDb().select().from(agentSessions).all().find((r) => r.id === id)
      if (!row) throw new Error(`Session ${id} not found`)
      sessions.set(id, inMemorySession(h, id, row.agentId, (row.accessLevel as 'readonly' | 'workspace' | null) ?? null, row.workingDir ?? null))
    }
    return realEnsure.call(this, id)
  })
  h.sm = new SessionManager(ws, opts.ledger ? { reconcileOrphansOnBoot: true } : undefined)
  if (opts.register !== false) {
    setCronSessionRegistry({ peek: () => h.sm, getOrCreate: () => h.sm })
  }
  return h
}

/** Undo installCronHarness + the runner's process-local state. */
export function teardownCronHarness(): void {
  stopCronDaemon()
  setCronSessionRegistry(null)
  _inflight.clear()
  _inflightSessions.clear()
  _runs.clear()
  vi.restoreAllMocks()
  current = null
}

/** The harness of the running test (for helpers that need the stub). */
export function cronHarness(): CronHarness {
  if (!current) throw new Error('cron harness not installed')
  return current
}

export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

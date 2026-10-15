import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import {
  ARCHIVE_SIZE_THRESHOLD, archiveSplitIndex, countArchiveSegments, writeArchiveSegment,
} from '../src/sessions/session-archive.js'
import { findAndDeleteSessionFile, loadRawMessages } from '../src/sessions/session-store.js'
import { replaceUILog, replaceRawLog, readUILog, uiLogPath, rawLogPath } from '../src/sessions/session-log.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * UI-log archiving (`<seg>.ui.arch.<N>.<h>.jsonl.gz`). The UI log has no
 * compaction and grows without bound (measured: 6.9MB of a 7.4MB 1.x file).
 * These tests pin the five properties the design depends on:
 *
 *  1. the trigger is the active file's SIZE, not its exchange count — under
 *     `ARCHIVE_SIZE_THRESHOLD` an archive call is a pure no-op however long the
 *     log is
 *  2. over the threshold exactly ONE main exchange stays behind, and the split
 *     lands on a main-user-exchange boundary, never mid-turn
 *  3. the active file is rewritten as the kept rows only; the raw log and the
 *     row's lifetime exchange count are untouched
 *  4. the COMMIT is the active-file rewrite: a segment whose first id is still
 *     the active file's first row is uncommitted and unreachable, and
 *     re-running the archive re-derives the same N (idempotent)
 *  5. deletion is directory-listing driven, so uncommitted/orphan segments go too
 *
 * Real disk + real gzip throughout — the size gate, crash-consistency and
 * listing behaviours are exactly the parts a mocked fs would fake away, so
 * fixtures are genuinely inflated past the threshold rather than stubbed.
 */

let ws: string
let sm: SessionManager

function uiMsg(role: 'user' | 'assistant', content: string, over: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `m_${content}_${role}`, role, type: role, content, timestamp: 1000, ...over }
}

/** `n` main exchanges: user + assistant each. Small — stays under the threshold. */
function exchanges(n: number, from = 0): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = from; i < from + n; i++) {
    out.push(uiMsg('user', `u${i}`), uiMsg('assistant', `a${i}`))
  }
  return out
}

/** Bytes of filler per assistant turn needed to push `n` exchanges past the
 *  threshold, with ~20% headroom over it. */
function fatBytes(n: number): number {
  return Math.ceil((ARCHIVE_SIZE_THRESHOLD * 1.2) / n)
}

/**
 * `n` main exchanges whose assistant turns carry a big tool output, so the
 * seeded file lands over ARCHIVE_SIZE_THRESHOLD. Filler is unique per turn
 * (`String.fromCharCode`) — a single repeated char would still be over the
 * threshold on disk, but unique bytes keep the fixture honest about real logs.
 */
function fatExchanges(n: number, from = 0): SessionMessage[] {
  const per = fatBytes(n)
  const out: SessionMessage[] = []
  for (let i = from; i < from + n; i++) {
    const filler = String.fromCharCode(97 + (i % 26)).repeat(per)
    out.push(
      uiMsg('user', `u${i}`),
      uiMsg('assistant', `a${i}`, {
        contentBlocks: [{ type: 'tool_result', toolUseId: `tu_${i}`, content: filler } as never],
      }),
    )
  }
  return out
}

function sessionDir(agentId = 'default'): string {
  return join(ws, '.halo', 'sessions', agentId)
}

function seedRow(id: string, over: Partial<typeof agentSessions.$inferInsert> = {}): void {
  sm.getDb().insert(agentSessions).values({
    id,
    parentId: over.parentId ?? null,
    agentId: over.agentId ?? 'default',
    agentName: over.agentName ?? 'Default',
    description: '',
    workingDir: null,
    accessLevel: null,
    createdAt: 1000,
    updatedAt: 1000,
    stoppedAt: null,
    archivedAt: null,
    title: over.title ?? null,
    exchangeCount: over.exchangeCount ?? null,
  }).run()
}

/** Seed a cold session: UI log `seg.ui.jsonl` + a one-message raw log.
 *  Returns the UI log's path. */
function seedFile(seg: string, messages: SessionMessage[], agentId = 'default'): string {
  const dir = sessionDir(agentId)
  replaceUILog(uiLogPath(dir, seg), messages)
  replaceRawLog(rawLogPath(dir, seg), [{ role: 'user', content: 'raw' }])
  return uiLogPath(dir, seg)
}

function readActive(seg: string, agentId = 'default'): SessionMessage[] {
  return readUILog(uiLogPath(sessionDir(agentId), seg)) ?? []
}

function activeSize(seg: string, agentId = 'default'): number {
  try { return statSync(uiLogPath(sessionDir(agentId), seg)).size } catch { return 0 }
}

function segmentNames(agentId = 'default'): string[] {
  return readdirSync(sessionDir(agentId)).filter((f) => f.includes('.arch.')).sort()
}

/** Segment file names with the content hash elided: `r1.ui.arch.1.jsonl.gz`. */
function segmentShapes(agentId = 'default'): string[] {
  return segmentNames(agentId).map((f) => f.replace(/\.[0-9a-f]{12}\.jsonl\.gz$/, '.jsonl.gz'))
}

function readSegment(seg: string, n: number, agentId = 'default'): SessionMessage[] {
  const name = segmentNames(agentId).find((f) => f.startsWith(`${seg}.ui.arch.${n}.`))!
  return gunzipSync(readFileSync(join(sessionDir(agentId), name))).toString('utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as SessionMessage)
}

/** The store, reached through the manager that owns it (same wiring prod uses). */
function uiStore(): { archiveOldMessages: (id: string) => number } {
  return (sm as unknown as { uiStore: { archiveOldMessages: (id: string) => number } }).uiStore
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-ui-arch-'))
  sm = new SessionManager(ws)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('archiveSplitIndex — where the log is cut', () => {
  it('returns 0 when the log holds at most the keep count', () => {
    expect(archiveSplitIndex(exchanges(1))).toBe(0)
    expect(archiveSplitIndex([])).toBe(0)
  })

  it('keep=1 cuts everything but the newest exchange', () => {
    const log = exchanges(4)
    const cut = archiveSplitIndex(log)
    expect(cut).toBe(6)                 // 3 exchanges × 2 messages move out
    expect(log.slice(cut).map((m) => m.content)).toEqual(['u3', 'a3'])
  })

  it('always cuts at the START of a main user exchange', () => {
    const log = exchanges(5)
    const cut = archiveSplitIndex(log)
    expect(log[cut].role).toBe('user')
    expect(log[cut].taskId).toBeUndefined()
  })

  it('ignores sub-agent (taskId) user messages when counting exchanges', () => {
    // Sub-agent turns are not main exchanges; the cut must not land on a taskId
    // row, and the kept slice must hold exactly one MAIN user turn.
    const log: SessionMessage[] = []
    for (let i = 0; i < 4; i++) {
      log.push(uiMsg('user', `u${i}`))
      log.push(uiMsg('user', `sub${i}`, { taskId: 'root>child' }))
      log.push(uiMsg('assistant', `a${i}`))
    }
    const cut = archiveSplitIndex(log)
    expect(log[cut].taskId).toBeUndefined()
    expect(log.slice(cut).filter((m) => m.role === 'user' && !m.taskId)).toHaveLength(1)
  })

  it('keeps the in-flight turn out of the archive (its user msg is the newest)', () => {
    // A mid-turn compact: last user message has no assistant reply yet. Keeping
    // the newest exchange means the running turn is the one that stays.
    const log = [...exchanges(4), uiMsg('user', 'in-flight')]
    const cut = archiveSplitIndex(log)
    expect(log.slice(cut).map((m) => m.content)).toEqual(['in-flight'])
    expect(log.slice(0, cut).some((m) => m.content === 'in-flight')).toBe(false)
  })
})

describe('the trigger is file size, not exchange count', () => {
  it('no-ops on a long but small log (hundreds of exchanges, well under the threshold)', () => {
    seedRow('r1')
    const path = seedFile('r1', exchanges(300))
    const before = readFileSync(path, 'utf-8')
    expect(activeSize('r1')).toBeLessThan(ARCHIVE_SIZE_THRESHOLD)

    expect(uiStore().archiveOldMessages('r1')).toBe(0)
    expect(segmentNames()).toEqual([])
    // File untouched entirely — not even rewritten.
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })

  it('fires on a short log once it is over the threshold', () => {
    seedRow('r1')
    // Only 4 exchanges — a count-based rule would never trigger here.
    seedFile('r1', fatExchanges(4))
    expect(activeSize('r1')).toBeGreaterThan(ARCHIVE_SIZE_THRESHOLD)

    expect(uiStore().archiveOldMessages('r1')).toBe(6)
    expect(readActive('r1').map((m) => m.content)).toEqual(['u3', 'a3'])
  })

  it('archives 1 and keeps 1 when there are only two exchanges', () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(2))

    expect(uiStore().archiveOldMessages('r1')).toBe(2)
    expect(readSegment('r1', 1).map((m) => m.content)).toEqual(['u0', 'a0'])
    expect(readActive('r1').map((m) => m.content)).toEqual(['u1', 'a1'])
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(1)
  })

  it('no-ops on a single oversized exchange — nothing to move without splitting it', () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(1))
    expect(activeSize('r1')).toBeGreaterThan(ARCHIVE_SIZE_THRESHOLD)

    expect(uiStore().archiveOldMessages('r1')).toBe(0)
    expect(segmentNames()).toEqual([])
  })

  it('no-ops for a session with no file yet', () => {
    seedRow('r1')
    expect(uiStore().archiveOldMessages('r1')).toBe(0)
    expect(existsSync(sessionDir())).toBe(false)
  })
})

describe('archiveOldMessages — segment write + active-file slim down', () => {
  it('moves everything but the newest exchange into segment 1', () => {
    const log = fatExchanges(10)
    seedRow('r1')
    seedFile('r1', log)

    const moved = uiStore().archiveOldMessages('r1')

    expect(moved).toBe(18)                    // 9 archived exchanges × 2
    expect(segmentShapes()).toEqual(['r1.ui.arch.1.jsonl.gz'])
    expect(readSegment('r1', 1).map((m) => m.content)).toEqual(log.slice(0, 18).map((m) => m.content))

    expect(readActive('r1').map((m) => m.content)).toEqual(['u9', 'a9'])
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(1)
  })

  it('shrinks the active file below the threshold it was over', () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(10))
    const before = activeSize('r1')

    uiStore().archiveOldMessages('r1')

    const after = activeSize('r1')
    expect(before).toBeGreaterThan(ARCHIVE_SIZE_THRESHOLD)
    expect(after).toBeLessThan(ARCHIVE_SIZE_THRESHOLD)
    // Roughly one exchange's worth of bytes left behind, not nine.
    expect(after).toBeLessThan(before / 5)
  })

  it('segment + active file together still hold every message, in order', () => {
    const log = fatExchanges(8)
    seedRow('r1')
    seedFile('r1', log)

    uiStore().archiveOldMessages('r1')

    const rejoined = [...readSegment('r1', 1), ...readActive('r1')]
    expect(rejoined.map((m) => m.content)).toEqual(log.map((m) => m.content))
  })

  it('rewrites only the active UI log — raw log and the row\'s exchange count untouched', () => {
    seedRow('r1', { exchangeCount: 4, title: 'seeded' })
    seedFile('r1', fatExchanges(4))
    const rawBefore = readFileSync(rawLogPath(sessionDir(), 'r1'), 'utf-8')

    uiStore().archiveOldMessages('r1')

    // The kept rows, one `add` record each — a plain fresh log.
    const lines = readFileSync(uiLogPath(sessionDir(), 'r1'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { t: string; m: SessionMessage })
    expect(lines.map((r) => [r.t, r.m.content])).toEqual([['add', 'u3'], ['add', 'a3']])
    expect(readFileSync(rawLogPath(sessionDir(), 'r1'), 'utf-8')).toBe(rawBefore)
    expect(loadRawMessages('r1', 'default', ws)).toEqual([{ role: 'user', content: 'raw' }])
    // The lifetime exchange count stays: 3 exchanges left the file, not the session.
    const row = sm.getDb().select().from(agentSessions).all().find((r) => r.id === 'r1')!
    expect(row.exchangeCount).toBe(4)
    expect(row.title).toBe('seeded')
  })

  it('increments N across successive archives, older segment untouched', () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(4))
    uiStore().archiveOldMessages('r1')
    const firstSegment = readSegment('r1', 1)

    // Session keeps chatting until it is over the threshold again, then archives.
    // (The re-grow is what bounds segment count: each one costs a threshold's
    // worth of content.)
    const state = sm.getUIState('r1')!
    state.messageLog = [...state.messageLog, ...fatExchanges(4, 100)]
    sm.appendNotification('r1', 'flush the fattened log to disk')
    const moved = uiStore().archiveOldMessages('r1')

    // Log was [u3,a3] + 4 new exchanges + the notification row; everything up to
    // the last main user turn moves out, so the notification rides along in the
    // kept slice (it is not an exchange boundary).
    expect(moved).toBe(8)
    expect(segmentShapes()).toEqual(['r1.ui.arch.1.jsonl.gz', 'r1.ui.arch.2.jsonl.gz'])
    expect(readSegment('r1', 1)).toEqual(firstSegment)   // read-only forever
    expect(readActive('r1').map((m) => m.content))
      .toEqual(['u103', 'a103', 'flush the fattened log to disk'])
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(2)
  })

  it('skips a tombstoned session (no segment written)', () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(4))
    vi.spyOn(sm, 'isSessionDeleted').mockReturnValue(true)

    expect(uiStore().archiveOldMessages('r1')).toBe(0)
    expect(segmentNames()).toEqual([])
  })
})

describe('the active-file rewrite as commit — crash safety', () => {
  it('an uncommitted segment is invisible and gets overwritten by the retry', () => {
    // Simulate a crash between step 1 (segment written) and step 2 (active
    // file rewritten): segment 1 exists on disk and starts at the active
    // file's first row, which still holds the complete log.
    const log = fatExchanges(5)
    seedRow('r1')
    seedFile('r1', log)
    writeArchiveSegment(sessionDir(), 'r1', 1, [log[0], uiMsg('user', 'stale-orphan')])

    // Nothing committed → readers see count 0, so the orphan is unreachable.
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(0)

    // The retry derives the SAME N=1 and replaces the orphan.
    const moved = uiStore().archiveOldMessages('r1')

    expect(moved).toBe(8)
    expect(segmentShapes()).toEqual(['r1.ui.arch.1.jsonl.gz'])
    expect(readSegment('r1', 1).some((m) => m.content === 'stale-orphan')).toBe(false)
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(1)
    // Zero loss: everything is still reachable across segment + active file.
    expect([...readSegment('r1', 1), ...readActive('r1')].map((m) => m.content))
      .toEqual(log.map((m) => m.content))
  })

  it('rolls the in-memory log back when the commit write does not land', () => {
    const log = fatExchanges(5)
    seedRow('r1')
    seedFile('r1', log)
    // persistUILog swallows IO errors in prod (null = nothing written); emulate
    // a failed commit.
    vi.spyOn(sm, 'persistUILog').mockReturnValue(null)

    const moved = uiStore().archiveOldMessages('r1')

    // Reported as "nothing archived" and memory still holds the full log, so the
    // next ordinary persist can't write a truncated log.
    expect(moved).toBe(0)
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(0)
    expect(sm.getUIState('r1')!.messageLog.map((m) => m.content)).toEqual(log.map((m) => m.content))
  })

  it('ordinary persists keep the segment committed', () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(4))
    uiStore().archiveOldMessages('r1')
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(1)

    // A plain UI write appends; the active file's first row stays the kept
    // tail's, so segment 1 still reads committed.
    sm.appendNotification('r1', 'context compacted')
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(1)
    expect(readActive('r1').map((m) => m.content)).toEqual(['u3', 'a3', 'context compacted'])
  })
})

describe('sub-session logs — archived into the sub\'s own file', () => {
  // A sub's UI log lives in its root's UIState (`subSessionLogs['r1>c1']`) but
  // is written to `sessions/<agent>/c1.ui.jsonl`. Archiving it must slim THAT file
  // and leave the parent's log and file alone. Fake timers: these tests leave
  // debounced sub persists armed, which must neither fire after the tmpdir is
  // gone nor leak into the next test.
  const SUB = 'r1>c1'

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** Root + sub rows, a small root file, a sub file holding `subLog`. Returns
   *  the root file's bytes so a test can prove the parent was never rewritten. */
  function seedTree(subLog: SessionMessage[]): string {
    seedRow('r1')
    seedRow(SUB, { parentId: 'r1', agentId: 'dev' })
    const rootBytes = readFileSync(seedFile('r1', exchanges(2)), 'utf-8')
    seedFile('c1', subLog, 'dev')
    return rootBytes
  }

  /** Build the live sub log the way the runtime does: agent_start (empty text
   *  → no row added, no write) loads the sub's history from its own file. */
  function startSub(fullText = ''): void {
    sm.emitEvent(SUB, { type: 'agent_start', agentName: 'Dev', agentId: 'dev', text: '', fullText, taskId: SUB, sessionId: SUB })
  }

  it('moves all but the newest exchange into the sub\'s own segment', () => {
    const log = fatExchanges(4)
    const rootBytes = seedTree(log)
    startSub()

    expect(uiStore().archiveOldMessages(SUB)).toBe(6)

    expect(segmentShapes('dev')).toEqual(['c1.ui.arch.1.jsonl.gz'])
    expect(readSegment('c1', 1, 'dev').map((m) => m.content)).toEqual(log.slice(0, 6).map((m) => m.content))
    expect(readActive('c1', 'dev').map((m) => m.content)).toEqual(['u3', 'a3'])
    expect(countArchiveSegments(sessionDir('dev'), 'c1')).toBe(1)
    expect(loadRawMessages(SUB, 'dev', ws)).toEqual([{ role: 'user', content: 'raw' }])
    // The parent: same bytes, no segment.
    expect(readFileSync(uiLogPath(sessionDir(), 'r1'), 'utf-8')).toBe(rootBytes)
    expect(segmentNames()).toEqual([])
  })

  it('no-ops under the size threshold', () => {
    seedTree(exchanges(50))
    startSub()
    const before = readFileSync(uiLogPath(sessionDir('dev'), 'c1'), 'utf-8')

    expect(uiStore().archiveOldMessages(SUB)).toBe(0)
    expect(segmentNames('dev')).toEqual([])
    expect(readFileSync(uiLogPath(sessionDir('dev'), 'c1'), 'utf-8')).toBe(before)
  })

  it('keeps the in-flight turn (brief + live tool call) in the active file', () => {
    const log = fatExchanges(4)
    seedTree(log)
    startSub('follow-up brief')
    sm.emitEvent(SUB, { type: 'tool_call', agentName: 'Dev', agentId: 'dev', toolName: 'shell_exec', toolUseId: 'tu_live', toolInput: { command: 'ls' }, taskId: SUB })

    // All four seeded exchanges leave; the turn being run stays whole.
    expect(uiStore().archiveOldMessages(SUB)).toBe(8)

    expect(readSegment('c1', 1, 'dev').map((m) => m.content)).toEqual(log.map((m) => m.content))
    const kept = readActive('c1', 'dev')
    expect(kept[0].content).toBe('follow-up brief')
    expect(kept.some((m) => m.type === 'tool_call' && m.toolName === 'shell_exec')).toBe(true)
    // The live turn's buffers ride along as the temp assistant message.
    expect(kept[kept.length - 1].role).toBe('assistant')
  })

  it('a debounced sub persist armed before the archive writes the kept tail, not the old log', () => {
    seedTree(fatExchanges(4))
    startSub()
    // Arms the sub's 500ms debounce timer — it fires AFTER the archive.
    sm.emitEvent(SUB, { type: 'tool_result', agentName: 'Dev', toolResult: 'ok', durationMs: 1, taskId: SUB })
    expect(uiStore().archiveOldMessages(SUB)).toBe(6)
    const persist = vi.spyOn(sm, 'persistUILog')

    vi.advanceTimersByTime(600)

    expect(persist.mock.calls.some(([id]) => id === SUB)).toBe(true)  // the timer really wrote
    const active = readActive('c1', 'dev')
    expect(active.map((m) => m.content).slice(0, 2)).toEqual(['u3', 'a3'])
    expect(active.some((m) => m.content === 'u0')).toBe(false)
    expect(countArchiveSegments(sessionDir('dev'), 'c1')).toBe(1)
  })

  it('returns 0 without touching anything when the sub log is not in memory', () => {
    seedTree(fatExchanges(4))
    const before = readFileSync(uiLogPath(sessionDir('dev'), 'c1'), 'utf-8')

    expect(uiStore().archiveOldMessages(SUB)).toBe(0)
    expect(segmentNames('dev')).toEqual([])
    expect(readFileSync(uiLogPath(sessionDir('dev'), 'c1'), 'utf-8')).toBe(before)
  })

  it('an ordinary sub persist after the archive keeps the segment committed', () => {
    seedTree(fatExchanges(4))
    startSub()
    uiStore().archiveOldMessages(SUB)

    sm.emitEvent(SUB, { type: 'agent_done', agentName: 'Dev', taskId: SUB })   // flush write

    expect(countArchiveSegments(sessionDir('dev'), 'c1')).toBe(1)
    expect(readActive('c1', 'dev')[0].content).toBe('u3')
  })

  it('selfCompactSession on a sub archives the sub log (compact-path wiring)', async () => {
    seedTree(fatExchanges(4))
    const raw: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
    for (let i = 0; i < 6; i++) {
      raw.push({ role: 'user', content: [{ type: 'text', text: `q${i}` }] })
      raw.push({ role: 'assistant', content: [{ type: 'text', text: `r${i}` }] })
    }
    const agent = {
      messages: raw,
      async *run() {
        agent.messages.push({ role: 'user', content: [{ type: 'text', text: 'summarize' }] })
        agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'SUMMARY' }] })
        yield { type: 'text', text: 'SUMMARY' }
      },
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SUB, {
      id: SUB, parentId: 'r1', agentId: 'dev', agent, compactedThisTurn: false, systemPrompt: '',
    })
    // The compact callers' preflight notice — it is what builds the sub log.
    sm.emitEvent(SUB, { type: 'system', text: 'Compacting context…', taskId: SUB })

    expect(await sm.selfCompactSession(SUB)).not.toBeNull()

    expect(segmentShapes('dev')).toEqual(['c1.ui.arch.1.jsonl.gz'])
    expect(countArchiveSegments(sessionDir('dev'), 'c1')).toBe(1)
    expect(readActive('c1', 'dev').map((m) => m.content)).toEqual(['u3', 'a3', 'Compacting context…'])
    expect(segmentNames()).toEqual([])
  })
})

describe('deletion — directory listing, not commit state', () => {
  it('removes committed AND uncommitted segments', async () => {
    seedRow('r1')
    writeArchiveSegment(sessionDir(), 'r1', 1, exchanges(1, 10))
    writeArchiveSegment(sessionDir(), 'r1', 2, exchanges(1, 20))
    const active = exchanges(1)
    writeArchiveSegment(sessionDir(), 'r1', 3, active)   // uncommitted orphan
    seedFile('r1', active)
    expect(countArchiveSegments(sessionDir(), 'r1')).toBe(2)

    await findAndDeleteSessionFile('r1', ws)

    expect(segmentNames()).toEqual([])
  })

  it('only touches the target session\'s files', async () => {
    seedRow('r1')
    writeArchiveSegment(sessionDir(), 'r1', 1, exchanges(1))
    writeArchiveSegment(sessionDir(), 'other', 1, exchanges(1))
    seedFile('r1', exchanges(1, 5))
    seedFile('other', exchanges(1, 5))
    // A session whose id extends this one's is not this one's.
    seedFile('r1x', exchanges(1, 5))

    await findAndDeleteSessionFile('r1', ws)

    expect(readdirSync(sessionDir()).map((f) => f.replace(/\.[0-9a-f]{12}\./, '.')).sort())
      .toEqual(['other.raw.jsonl', 'other.ui.arch.1.jsonl.gz', 'other.ui.jsonl', 'r1x.raw.jsonl', 'r1x.ui.jsonl'])
  })

  it('findAndDeleteSessionFile (the DELETE /api route) clears segments too', async () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(4))
    uiStore().archiveOldMessages('r1')
    expect(segmentNames()).toHaveLength(1)

    await findAndDeleteSessionFile('r1', ws)

    expect(readdirSync(sessionDir())).toEqual([])
  })
})

describe('deleteExchange archive anchor', () => {
  it('refuses when the client anchor is behind the on-disk count', async () => {
    const log = fatExchanges(4)
    seedRow('r1')
    seedFile('r1', log)
    uiStore().archiveOldMessages('r1')
    const before = readActive('r1')
    const rawBefore = loadRawMessages('r1', 'default', ws)

    // A panel opened before the archive still counts from the pre-archive top:
    // its ordinal 0 points at a different turn here — refuse rather than delete
    // the wrong one.
    expect(await sm.deleteExchange('r1', 0, 0)).toBe('archived')

    const after = readActive('r1')
    expect(after.some((m) => m.deleted)).toBe(false)
    expect(after).toEqual(before)
    expect(loadRawMessages('r1', 'default', ws)).toEqual(rawBefore)
  })

  /** Two committed segments ahead of a 3-exchange active log. */
  function seedArchived(): void {
    seedRow('r1')
    writeArchiveSegment(sessionDir(), 'r1', 1, exchanges(1, 50))
    writeArchiveSegment(sessionDir(), 'r1', 2, exchanges(1, 60))
    seedFile('r1', exchanges(3))
  }

  it('deletes when the client anchor matches the on-disk count', async () => {
    seedArchived()

    // Reopened after the archive: the client anchored at 2, so its ordinal 0
    // is the active log's first turn on both sides.
    expect(await sm.deleteExchange('r1', 0, 2)).toBe('deleted')
    expect(readActive('r1').filter((m) => m.deleted).map((m) => m.content)).toEqual(['u0', 'a0'])
  })

  it('still deletes normally when nothing has been archived', async () => {
    seedRow('r1')
    seedFile('r1', exchanges(2))
    expect(await sm.deleteExchange('r1', 0, 0)).toBe('deleted')
  })

  it('reads the marker from disk, not memory', async () => {
    // No in-memory UI state at all (fresh manager over the same workspace, so the
    // db row persists) — the guard must still count the segments on disk.
    seedArchived()
    sm = new SessionManager(ws)

    expect(await sm.deleteExchange('r1', 0, 0)).toBe('archived')
    expect(await sm.deleteExchange('r1', 0, 2)).toBe('deleted')
  })
})

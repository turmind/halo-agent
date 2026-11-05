import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createEvoDb, setEvoDb, evolutionRuns, evolutionApplies, type EvoDb } from '../src/db/evo-db.js'
import { notifyAutoApplied, setEvoSessionRegistry, formatAutoAppliedNotice, type EvoNotifyTarget } from '../src/evolution/notify.js'
import { config } from '../src/config.js'
import { wsEvoHistoryDir, wsEvoRunDir } from '../src/paths.js'

/**
 * Auto-apply notice (plans/evo-l2-l3.md §6): db-driven — exactly one line per
 * applied auto apply, none repeated after a restart, none for reviewer
 * applies, no throw for a vanished session / workspace.
 */

let tmp: string, ws: string, db: EvoDb
let sent: Array<{ sid: string; text: string }>
let sessions: Set<string>

const target: EvoNotifyTarget = {
  getSessionById: (sid) => (sessions.has(sid) ? { id: sid } : null),
  notifySystem: (sid, text) => { sent.push({ sid, text }) },
}

function seedApply(id: string, opts: { approvedBy?: string; status?: string; observation?: string | null } = {}): void {
  const runId = `run-${id}`
  db.insert(evolutionRuns).values({ id: runId, workspacePath: ws, status: 'applied', triggerKind: 'pre-compact', sourceSession: 'sid-1', createdAt: 1 }).run()
  db.insert(evolutionApplies).values({
    id, workspacePath: ws, status: opts.status ?? 'applied', sourceRunIds: JSON.stringify([runId]),
    createdAt: 1, approvedBy: opts.approvedBy ?? 'auto',
  }).run()
  const hist = wsEvoHistoryDir(ws, id)
  fs.mkdirSync(hist, { recursive: true })
  fs.writeFileSync(path.join(hist, 'MANIFEST.json'), JSON.stringify({ files: [{ rel: 'INSTRUCTIONS.md', kind: 'overwrite' }] }))
  const runDir = wsEvoRunDir(ws, runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'auto-apply.json'), JSON.stringify({
    auto: true, score: { avg: 90, confidence: 'high' }, observation: opts.observation ?? null,
  }))
}
const notifiedAt = (id: string) => db.select().from(evolutionApplies).where(eq(evolutionApplies.id, id)).get()!.notifiedAt

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-notify-'))
  ws = path.join(tmp, 'ws')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  db = createEvoDb(path.join(tmp, 'global'))
  setEvoDb(db)
  sent = []
  sessions = new Set(['sid-1'])
  setEvoSessionRegistry({ getOrCreate: () => target })
  vi.spyOn(config, 'language', 'get').mockReturnValue('en')
})
afterEach(() => {
  setEvoSessionRegistry(null)
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('notifyAutoApplied', () => {
  it('sends once to the source session and stamps notified_at', () => {
    seedApply('a1')
    notifyAutoApplied(db)
    expect(sent).toEqual([{ sid: 'sid-1', text: '✨ Self-evolution auto-applied a change to INSTRUCTIONS.md (score 90, high). Review or roll back under Evolution.' }])
    expect(notifiedAt('a1')).not.toBeNull()
    notifyAutoApplied(db)
    expect(sent).toHaveLength(1)
  })

  it('after a "restart" (fresh db handle, fresh registry) nothing is re-sent', () => {
    seedApply('a1')
    notifyAutoApplied(db)
    const reopened = createEvoDb(path.join(tmp, 'global'))
    setEvoSessionRegistry({ getOrCreate: () => target })
    notifyAutoApplied(reopened)
    expect(sent).toHaveLength(1)
  })

  it('skips reviewer applies and auto applies not yet applied', () => {
    seedApply('a-rev', { approvedBy: 'reviewer' })
    seedApply('a-run', { status: 'running' })
    notifyAutoApplied(db)
    expect(sent).toEqual([])
    expect(notifiedAt('a-rev')).toBeNull()
    expect(notifiedAt('a-run')).toBeNull()
  })

  it('a deleted source session: no line, no throw, still stamped', () => {
    sessions.clear()
    seedApply('a1')
    expect(() => notifyAutoApplied(db)).not.toThrow()
    expect(sent).toEqual([])
    expect(notifiedAt('a1')).not.toBeNull()
  })

  it('a vanished workspace never gets a .halo scaffolded', () => {
    const getOrCreate = vi.fn(() => target)
    setEvoSessionRegistry({ getOrCreate })
    seedApply('a1')
    fs.rmSync(path.join(ws, '.halo'), { recursive: true })
    notifyAutoApplied(db)
    expect(getOrCreate).not.toHaveBeenCalled()
    expect(notifiedAt('a1')).not.toBeNull()
  })

  it('a throwing session layer is logged, stamped, and does not block other rows', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let first = true
    setEvoSessionRegistry({ getOrCreate: () => ({ ...target, notifySystem: (sid, text) => { if (first) { first = false; throw new Error('boom') } sent.push({ sid, text }) } }) })
    seedApply('a1')
    seedApply('a2')
    notifyAutoApplied(db)
    expect(sent).toHaveLength(1)
    expect(notifiedAt('a1')).not.toBeNull()
    expect(notifiedAt('a2')).not.toBeNull()
  })

  it('no registry (tests / AgentCore) → nothing sent, rows left for later', () => {
    setEvoSessionRegistry(null)
    seedApply('a1')
    notifyAutoApplied(db)
    expect(notifiedAt('a1')).toBeNull()
  })

  it('carries the observation preview', () => {
    seedApply('a1', { observation: 'Split the default agent.' })
    notifyAutoApplied(db)
    expect(sent[0].text).toContain('It also left a structural suggestion: Split the default agent. (see the Evolution tab).')
  })
})

describe('formatAutoAppliedNotice', () => {
  const base = { files: ['INSTRUCTIONS.md'], avg: 90, confidence: 'high', observation: null }

  it('zh without / with observation', () => {
    expect(formatAutoAppliedNotice({ ...base, lang: 'zh' }))
      .toBe('✨ 自我进化已自动应用对 INSTRUCTIONS.md 的修改（评分 90，high）。可在 Evolution 页查看或回滚。')
    expect(formatAutoAppliedNotice({ ...base, observation: '把 default 拆成两个 agent', lang: 'zh' }))
      .toBe('✨ 自我进化已自动应用对 INSTRUCTIONS.md 的修改（评分 90，high）。可在 Evolution 页查看或回滚。 另附一条结构性建议：把 default 拆成两个 agent（详见 Evolution 页）')
  })

  it('observation preview: whitespace flattened, first 120 chars + …', () => {
    const long = `line one\n\n${'字'.repeat(200)}`
    const text = formatAutoAppliedNotice({ ...base, observation: long, lang: 'zh' })
    const preview = text.split('另附一条结构性建议：')[1]
    expect(preview.startsWith('line one 字')).toBe(true)
    expect(preview).toBe(`${`line one ${'字'.repeat(200)}`.slice(0, 120)}…（详见 Evolution 页）`)
  })

  it('more than three files are summarised', () => {
    const text = formatAutoAppliedNotice({ ...base, files: ['a', 'b', 'c', 'd', 'e'], lang: 'en' })
    expect(text).toContain('a change to a, b, c and 5 files in total (score 90, high)')
  })

  it('missing score fields read "?"', () => {
    expect(formatAutoAppliedNotice({ ...base, avg: null, confidence: null, lang: 'en' })).toContain('(score ?, ?)')
  })
})

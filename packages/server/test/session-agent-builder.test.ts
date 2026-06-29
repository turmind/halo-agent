import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { toggleDisabled } from '../src/db/index.js'

/**
 * INTEGRATION coverage for SessionAgentBuilder, the agent-construction pipeline
 * carved out of SessionManager (third knife). The pipeline loads agent.yaml,
 * filters tools, composes the system prompt, and builds a ModelRuntime — too
 * coupled to mock usefully, so these drive a REAL SessionManager against a
 * tmpdir workspace with a self-contained agent.yaml. The chosen provider
 * ('anthropic') is a known createModelRuntime case whose constructor does NOT
 * hit the network (only .run() would), so the whole build runs offline.
 *
 * The build is triggered via getSessionContext (→ ensureSession →
 * buildAgentInstance), which surfaces exactly the BuiltAgent-derived data the
 * carve-out is responsible for: modelId, the /context tool + md-file metadata.
 */

let ws: string

/** Write a self-contained workspace agent.yaml (+ optional AGENT.md). */
function writeAgent(agentId: string, yamlLines: string[], agentMd?: string): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), yamlLines.join('\n'))
  if (agentMd !== undefined) writeFileSync(join(dir, 'AGENT.md'), agentMd)
}

function seedSession(sm: SessionManager, id: string, agentId: string, parentId: string | null = null, workingDir: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId, agentName: agentId,
    description: '', workingDir, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

const ANTHROPIC_MODEL = [
  'model:',
  '  provider: anthropic',
  '  id: claude-opus-4-8',
  '  endpoint: https://api.anthropic.com',
]

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-builder-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('buildAgentInstance — model config + tool whitelist', () => {
  it('resolves modelId and filters tools to the yaml whitelist', async () => {
    writeAgent('tester', ['name: Tester', ...ANTHROPIC_MODEL, 'tools: [file_read, grep]'], 'test agent')
    const sm = new SessionManager(ws)
    seedSession(sm, 's1', 'tester')

    const ctx = await sm.getSessionContext('s1')
    expect(ctx?.modelId).toBe('claude-opus-4-8')
    // whitelist honoured: declared tools present, undeclared ones absent
    expect(ctx?.meta.toolNames).toContain('file_read')
    expect(ctx?.meta.toolNames).toContain('grep')
    expect(ctx?.meta.toolNames).not.toContain('file_write')
    expect(ctx?.meta.toolNames).not.toContain('shell_exec')
  })

  it('throws (→ getSessionContext returns null) when the model triple is incomplete', async () => {
    // missing model.endpoint → validateAgentModelConfig throws; ensureSession's
    // try/catch in getSessionContext converts that to null.
    writeAgent('broken', ['name: Broken', 'model:', '  provider: anthropic', '  id: claude-opus-4-8'])
    const sm = new SessionManager(ws)
    seedSession(sm, 's_broken', 'broken')
    expect(await sm.getSessionContext('s_broken')).toBeNull()
  })

  it('includes the draft tool only when whitelisted', async () => {
    writeAgent('drafter', ['name: Drafter', ...ANTHROPIC_MODEL, 'tools: [file_read, draft]'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_draft', 'drafter')
    const ctx = await sm.getSessionContext('s_draft')
    expect(ctx?.meta.toolNames).toContain('draft')
  })
})

describe('composeSystemPrompt — root vs sub-agent vs metadata', () => {
  it('a root agent surfaces its AGENT.md in /context md-files', async () => {
    writeAgent('rooty', ['name: Rooty', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'I am rooty.')
    const sm = new SessionManager(ws)
    seedSession(sm, 'root1', 'rooty', null)  // parentId null → root
    const ctx = await sm.getSessionContext('root1')
    const labels = ctx?.meta.mdFiles.map((f) => f.label) ?? []
    expect(labels).toContain('AGENT.md')
  })

  it('skillNames in metadata reflect the yaml skills list', async () => {
    writeAgent('skilled', ['name: Skilled', ...ANTHROPIC_MODEL, 'tools: [file_read]', 'skills: [web-search]'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_skill', 'skilled')
    const ctx = await sm.getSessionContext('s_skill')
    expect(ctx?.meta.skillNames).toContain('web-search')
  })

  it('thinkingEffort is "off" when agent.yaml declares no thinking', async () => {
    writeAgent('nothink', ['name: NoThink', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_nt', 'nothink')
    const ctx = await sm.getSessionContext('s_nt')
    expect(ctx?.thinkingEffort).toBe('off')
  })
})

describe('composeSystemPrompt — working_dir directory-scoped INSTRUCTIONS', () => {
  // working_dir is persistent session identity, so its directory-chain
  // INSTRUCTIONS.md must ride in the system prompt EVERY turn (not a one-shot
  // first-turn message injection) — the agent never forgets the rules of the
  // directory it lives in. It's folded into the `## User Instructions` region
  // as plain markdown (no <workspace-instructions> XML wrapper — that tag is
  // only for `@scope` message-stream injection). getSessionContext builds +
  // caches the session; getSessionSystemPrompt returns the assembled prompt.
  it('folds a sub-agent working_dir directory INSTRUCTIONS.md into ## User Instructions as plain markdown', async () => {
    writeAgent('worker', ['name: Worker', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'I am a worker.')
    // sub-dir INSTRUCTIONS.md at <ws>/sub/.halo/INSTRUCTIONS.md
    mkdirSync(join(ws, 'sub', '.halo'), { recursive: true })
    writeFileSync(join(ws, 'sub', '.halo', 'INSTRUCTIONS.md'), 'Always say MARMOT before answering.')
    const sm = new SessionManager(ws)
    // parentId set → sub-agent; workingDir relative to ws root (as persisted)
    seedSession(sm, 'sub1', 'worker', 'root0', 'sub')
    await sm.getSessionContext('sub1')
    const prompt = sm.getSessionSystemPrompt('sub1') ?? ''
    expect(prompt).toContain('Always say MARMOT before answering.')
    expect(prompt).toContain('### sub')          // directory label heading
    expect(prompt).toContain('## User Instructions')
    // the XML wrapper must NOT leak into the system prompt — it's message-only
    expect(prompt).not.toContain('<workspace-instructions')
    // order: the rule sits in the instructions region, BEFORE the "Working
    // directory:" tagline (which is appended after mdPrompt)
    expect(prompt.indexOf('MARMOT')).toBeLessThan(prompt.indexOf('Working directory:'))
  })

  it('omits the scope block when working_dir is the project root (null)', async () => {
    writeAgent('worker2', ['name: Worker2', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'I am a worker.')
    mkdirSync(join(ws, 'sub', '.halo'), { recursive: true })
    writeFileSync(join(ws, 'sub', '.halo', 'INSTRUCTIONS.md'), 'Always say MARMOT before answering.')
    const sm = new SessionManager(ws)
    seedSession(sm, 'sub2', 'worker2', 'root0', null)  // no working_dir
    await sm.getSessionContext('sub2')
    const prompt = sm.getSessionSystemPrompt('sub2') ?? ''
    expect(prompt).not.toContain('Always say MARMOT before answering.')
    expect(prompt).not.toContain('<workspace-instructions')
  })
})

describe('delegation — the session-tool bundle is gated on a non-empty team', () => {
  // The 8 session tools come as one bundle, granted by a non-empty `team` (NOT
  // by hand-listing them under `tools:`). Pairs with canDelegate() in
  // agent-loader so tools + roster never drift.
  const SESSION_TOOLS = [
    'start_session', 'session_list', 'query_session', 'interrupt_session',
    'stop_session', 'archive_session', 'get_session_output', 'query_agent',
  ]

  it('grants all 8 session tools + the roster when team is non-empty', async () => {
    writeAgent('mate', ['name: Mate', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'a teammate')
    writeAgent('boss', ['name: Boss', ...ANTHROPIC_MODEL, 'tools: [file_read]', 'team: [mate]'], 'I delegate.')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_boss', 'boss', null)
    const ctx = await sm.getSessionContext('s_boss')
    for (const name of SESSION_TOOLS) expect(ctx?.meta.toolNames).toContain(name)
    // roster injected into the system prompt, listing the team member
    const prompt = sm.getSessionSystemPrompt('s_boss') ?? ''
    expect(prompt).toContain('Mate')
  })

  it('grants no session tools and no roster when team is absent', async () => {
    writeAgent('solo', ['name: Solo', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'I work alone.')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_solo', 'solo', null)
    const ctx = await sm.getSessionContext('s_solo')
    for (const name of SESSION_TOOLS) expect(ctx?.meta.toolNames).not.toContain(name)
    const prompt = sm.getSessionSystemPrompt('s_solo') ?? ''
    expect(prompt).not.toContain('Know Your Team')
    expect(prompt).not.toContain('Your Team')
  })

  it('treats an empty team [] as no delegation', async () => {
    writeAgent('empty', ['name: Empty', ...ANTHROPIC_MODEL, 'tools: [file_read]', 'team: []'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_empty', 'empty', null)
    const ctx = await sm.getSessionContext('s_empty')
    for (const name of SESSION_TOOLS) expect(ctx?.meta.toolNames).not.toContain(name)
  })

  it('ignores session tools hand-listed under tools: when team is absent', async () => {
    // start_session in `tools:` has no effect now — only `team` switches it on.
    writeAgent('legacy', ['name: Legacy', ...ANTHROPIC_MODEL, 'tools: [file_read, start_session, query_agent]'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_legacy', 'legacy', null)
    const ctx = await sm.getSessionContext('s_legacy')
    expect(ctx?.meta.toolNames).not.toContain('start_session')
    expect(ctx?.meta.toolNames).not.toContain('query_agent')
    expect(ctx?.meta.toolNames).toContain('file_read')  // real tool still honored
  })

  it('drops a disabled teammate from the roster (matches start_session rejection)', async () => {
    // A disabled agent is unreachable by start_session, so the roster must not
    // list it either — otherwise it's advertised but uncallable.
    writeAgent('mate', ['name: Matey', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'a teammate')
    writeAgent('boss', ['name: Boss', ...ANTHROPIC_MODEL, 'tools: [file_read]', 'team: [mate]'], 'I delegate.')
    const sm = new SessionManager(ws)
    toggleDisabled(sm.getDb(), 'agent', 'mate', 'workspace')
    seedSession(sm, 's_boss', 'boss', null)
    await sm.getSessionContext('s_boss')
    const prompt = sm.getSessionSystemPrompt('s_boss') ?? ''
    expect(prompt).not.toContain('Matey')
  })
})

describe('delegation — by-id session tools are scoped to the caller\'s own tree', () => {
  // query/interrupt/stop/archive/get_session_output take an arbitrary session_id.
  // Without an ownership gate, an agent on one root could stop/archive/read a
  // foreign user's tree on a shared workspace. The gate is "same root id"
  // (left-most `>` segment); a cross-tree id must be refused as not-found and
  // must NOT reach the SessionManager method underneath.
  function toolByName(sm: SessionManager, callerId: string, name: string) {
    const tool = sm.createSessionTools(callerId).find((t) => t.name === name)
    if (!tool) throw new Error(`tool ${name} not built`)
    return tool
  }

  it('refuses cross-tree stop/archive/query/get_output without touching the target', async () => {
    const sm = new SessionManager(ws)
    // Caller lives on root A; victim is an unrelated root B with a child.
    seedSession(sm, 'web_a_root', 'agent', null)
    seedSession(sm, 'web_b_root', 'agent', null)
    seedSession(sm, 'web_b_root>child', 'agent', 'web_b_root')

    for (const [name, args] of [
      ['stop_session', { session_id: 'web_b_root' }],
      ['archive_session', { session_id: 'web_b_root' }],
      ['query_session', { target_session_id: 'web_b_root', message: 'hi' }],
      ['get_session_output', { session_id: 'web_b_root>child' }],
      ['interrupt_session', { session_id: 'web_b_root', message: 'stop' }],
    ] as const) {
      const out = await toolByName(sm, 'web_a_root', name).callback(args)
      const parsed = JSON.parse(out as string)
      expect(parsed.code).toBe(1)
      expect(parsed.error).toMatch(/not found/)
    }

    // The victim tree must be untouched: not archived, not stopped.
    const rows = sm.getDb().select().from(agentSessions).all()
    for (const r of rows.filter((x) => x.id.startsWith('web_b_root'))) {
      expect(r.archivedAt).toBeNull()
      expect(r.stoppedAt).toBeNull()
    }
  })

  it('allows operating on a session in the caller\'s own tree (gate lets it through)', async () => {
    const sm = new SessionManager(ws)
    seedSession(sm, 'web_a_root', 'agent', null)
    seedSession(sm, 'web_a_root>kid', 'agent', 'web_a_root')

    // Stopping a same-root (cold, DB-only) session passes the gate and reaches
    // stopSession, which marks stoppedAt by id — no network, no model.
    const out = await toolByName(sm, 'web_a_root', 'stop_session').callback({ session_id: 'web_a_root>kid' })
    expect(JSON.parse(out as string).code).toBe(0)
    const kid = sm.getDb().select().from(agentSessions).all().find((r) => r.id === 'web_a_root>kid')
    expect(kid?.stoppedAt).not.toBeNull()
  })
})

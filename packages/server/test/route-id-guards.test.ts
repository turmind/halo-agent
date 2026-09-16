import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSafeIdSegment } from '../src/routes/workspace-path.js'
import { createAgentConfigRoutes } from '../src/routes/agent-configs.js'
import { createSkillRoutes } from '../src/routes/skills.js'
import { createSettingsRoutes } from '../src/routes/settings.js'

/**
 * Contract: admin routes that join a :param / body id into a filesystem
 * path must reject traversal-shaped ids with 400 BEFORE touching disk.
 * Hono URL-decodes %2F / %2e into route params, so `:id` can arrive as
 * `../../etc` — "a URL segment can't contain /" does not hold. Covered
 * endpoints (the B-H1 family):
 *
 *   - DELETE /agent-configs/:id                      (recursive rm)
 *   - GET/PUT /agent-configs/:id/yaml                 (file read / atomic write)
 *   - PATCH /agent-configs/:id/toggle
 *   - GET/PUT /agent-configs/:id/md/:fileType         (file read / write)
 *   - GET /agent-configs/:id/md-all
 *   - GET/DELETE /agent-configs/:id/sessions          (dir list / bulk rm)
 *   - GET/DELETE /agent-configs/:id/sessions/:sessionId (file read / rm)
 *   - POST /agent-configs/:id/sessions body.id        (arbitrary write)
 *   - DELETE /skills/:id                              (recursive rm)
 *   - PATCH/PUT/DELETE /settings body.projectId       (arbitrary-dir write)
 *
 * Plus B-M4: PATCH/DELETE /settings dotted keys walk `target[part]`
 * layer-by-layer — `__proto__` / `constructor` / `prototype` segments
 * must 400, and Object.prototype must stay unpolluted.
 *
 * Legit ids must keep working: agent slugs (CJK included), `__internal__`
 * platform agents, and every real session-id shape (sid_, s-, web_, tg_,
 * slack/feishu ids embedding `:` and `.`, hierarchical `a>b` ids,
 * cron-<id>, agentcore_).
 */

// URL-encoded traversal shapes as they'd arrive on the wire; Hono decodes
// them into the :param before our handler sees them.
const ENCODED_TRAVERSAL = ['..%2F..%2Fetc', '%2e%2e%2f%2e%2e%2fetc', '..%5C..%5Cwindows']

describe('isSafeIdSegment', () => {
  it('accepts every real id shape', () => {
    for (const id of [
      'default', 'deep-executor', '__evo_agent__', '中文-agent',
      'sid_m1abc_x7', 's-1699999-ab12cd', 'web_1a2b3c4d_lmnop',
      'tg_12345_q1', 'wx_oAbC-123_z9', 'slack_C0AB:1699.1234_k2',
      'feishu_oc_9f:om_8e_r4', 'cron-lx9-ab12cd', 'agentcore_user-1',
      'sid_root>sid_child', 'goal_x>sid_y',
    ]) {
      expect(isSafeIdSegment(id), id).toBe(true)
    }
  })

  it('rejects traversal / separator shapes', () => {
    for (const id of [
      '..', '.', '../x', '..\\x', 'a/b', 'a\\b', '/etc/passwd',
      '../../etc', '', 'a b', 'a%2Fb',
    ]) {
      expect(isSafeIdSegment(id), JSON.stringify(id)).toBe(false)
    }
  })

  it('allows dotted literals that cannot traverse', () => {
    expect(isSafeIdSegment('a..b')).toBe(true)
    expect(isSafeIdSegment('v1.2.3')).toBe(true)
  })
})

describe('route guards (attack shapes → 400, legit ids unaffected)', () => {
  let ws: string
  let realHome: string | undefined
  const agentApp = createAgentConfigRoutes()
  const skillApp = createSkillRoutes()
  const settingsApp = createSettingsRoutes()

  beforeAll(() => {
    // Redirect HOME so global agents/skills dirs and settings.yaml land in
    // a scratch dir (libuv re-reads $HOME on each homedir() call).
    realHome = process.env.HOME
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-id-guard-home-'))
    process.env.HOME = tmpHome
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-id-guard-ws-'))
    fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  })

  afterAll(() => {
    process.env.HOME = realHome
    fs.rmSync(ws, { recursive: true, force: true })
  })

  // ── DELETE /agent-configs/:id ──
  it('DELETE /agent-configs/:id rejects encoded traversal', async () => {
    for (const shape of ENCODED_TRAVERSAL) {
      const res = await agentApp.request(`/agent-configs/${shape}?scope=workspace&projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
      expect(res.status, shape).toBe(400)
    }
  })

  it('DELETE /agent-configs/:id still deletes a legit workspace agent', async () => {
    const dir = path.join(ws, '.halo', 'agents', 'doomed')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.yaml'), 'name: Doomed\n')
    const res = await agentApp.request(`/agent-configs/doomed?scope=workspace&projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(dir)).toBe(false)
  })

  // ── GET/PUT /agent-configs/:id/yaml ──
  it('GET yaml rejects traversal agent id', async () => {
    const res = await agentApp.request(`/agent-configs/..%2F..%2Fetc/yaml?scope=workspace&projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(400)
  })

  it('PUT yaml rejects traversal agent id and writes nothing', async () => {
    // With `..%2F..%2Fagents-evil` the unguarded join lands on a sibling of
    // `.halo/agents`; make that dir exist so the `fs.access(agentDir)` check
    // would pass and only the guard stands between the request and the write.
    const evilDir = path.join(ws, '.halo', 'agents-evil')
    fs.mkdirSync(evilDir, { recursive: true })
    const res = await agentApp.request('/agent-configs/..%2Fagents-evil/yaml', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: 'name: Evil\n', scope: 'workspace', projectId: ws }),
    })
    expect(res.status).toBe(400)
    expect(fs.existsSync(path.join(evilDir, 'agent.yaml'))).toBe(false)
  })

  // ── PATCH /agent-configs/:id/toggle ──
  it('PATCH toggle rejects traversal agent id', async () => {
    const res = await agentApp.request(`/agent-configs/..%2F..%2Fetc/toggle?scope=workspace&projectId=${encodeURIComponent(ws)}`, { method: 'PATCH' })
    expect(res.status).toBe(400)
  })

  // ── GET/PUT /agent-configs/:id/md/:fileType ──
  it('GET md rejects traversal agent id', async () => {
    const res = await agentApp.request(`/agent-configs/..%2F..%2Fetc/md/AGENT.md?scope=workspace&projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(400)
  })

  it('PUT md rejects traversal agent id and writes nothing', async () => {
    const evilDir = path.join(ws, '.halo', 'agents-evil-md')
    fs.mkdirSync(evilDir, { recursive: true })
    const res = await agentApp.request('/agent-configs/..%2Fagents-evil-md/md/AGENT.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# evil', scope: 'workspace', projectId: ws }),
    })
    expect(res.status).toBe(400)
    expect(fs.existsSync(path.join(evilDir, 'AGENT.md'))).toBe(false)
  })

  it('GET/PUT md still reject an unknown fileType (whitelist, not traversal)', async () => {
    const res = await agentApp.request(`/agent-configs/default/md/..%2F..%2Fetc?scope=workspace&projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(400)
  })

  // ── GET /agent-configs/:id/md-all ──
  it('GET md-all rejects traversal agent id', async () => {
    const res = await agentApp.request(`/agent-configs/..%2F..%2Fetc/md-all?scope=workspace&projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(400)
  })

  // ── GET /agent-configs/:id/sessions ──
  it('GET sessions list rejects traversal agent id', async () => {
    const res = await agentApp.request(`/agent-configs/..%2F..%2Fetc/sessions?projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(400)
  })

  // ── GET /agent-configs/:id/sessions/:sessionId ──
  it('GET single session rejects traversal session id', async () => {
    const res = await agentApp.request(`/agent-configs/default/sessions/..%2F..%2F..%2Fsecret?projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(400)
  })

  // ── POST /agent-configs/:id/sessions (body.id) ──
  it('POST session save rejects traversal body.id and writes nothing', async () => {
    const evil = path.join(os.tmpdir(), `halo-evil-${Date.now().toString(36)}`)
    const rel = path.relative(path.join(ws, '.halo', 'sessions', 'default'), evil)
    const res = await agentApp.request('/agent-configs/default/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rel, projectId: ws, messages: [] }),
    })
    expect(res.status).toBe(400)
    expect(fs.existsSync(`${evil}.json`)).toBe(false)
  })

  it('POST session save accepts a legit sid_ id and round-trips', async () => {
    const res = await agentApp.request('/agent-configs/default/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'sid_test_rt1', projectId: ws, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const file = path.join(ws, '.halo', 'sessions', 'default', 'sid_test_rt1.json')
    expect(fs.existsSync(file)).toBe(true)

    const get = await agentApp.request(`/agent-configs/default/sessions/sid_test_rt1?projectId=${encodeURIComponent(ws)}`)
    expect(get.status).toBe(200)

    const del = await agentApp.request(`/agent-configs/default/sessions/sid_test_rt1?projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(fs.existsSync(file)).toBe(false)
  })

  // ── DELETE /agent-configs/:id/sessions (bulk) + /:sessionId ──
  it('bulk + single session DELETE reject traversal ids', async () => {
    const bulk = await agentApp.request(`/agent-configs/..%2F..%2Fx/sessions?projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
    expect(bulk.status).toBe(400)
    const single = await agentApp.request(`/agent-configs/default/sessions/..%2Fescape?projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
    expect(single.status).toBe(400)
  })

  // ── DELETE /skills/:id ──
  it('DELETE /skills/:id rejects encoded traversal', async () => {
    for (const shape of ENCODED_TRAVERSAL) {
      const res = await skillApp.request(`/skills/${shape}?scope=workspace&projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
      expect(res.status, shape).toBe(400)
    }
  })

  it('DELETE /skills/:id still deletes a legit workspace skill', async () => {
    const dir = path.join(ws, '.halo', 'skills', 'doomed-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Doomed\n---\n')
    const res = await skillApp.request(`/skills/doomed-skill?scope=workspace&projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(dir)).toBe(false)
  })

  // ── settings projectId (workspace scope must resolve to an existing abs path) ──
  it('PATCH /settings rejects a non-existent projectId (no arbitrary-dir write)', async () => {
    const ghost = path.join(os.tmpdir(), `halo-ghost-${Date.now().toString(36)}`)
    const res = await settingsApp.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'workspace', projectId: ghost, key: 'general.language', value: 'en-US' }),
    })
    expect(res.status).toBe(404)
    expect(fs.existsSync(path.join(ghost, '.halo', 'settings.yaml'))).toBe(false)
  })

  it('PATCH /settings rejects a relative projectId', async () => {
    const res = await settingsApp.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'workspace', projectId: '../../etc', key: 'general.language', value: 'en-US' }),
    })
    expect(res.status).toBe(404)
  })

  it('PATCH /settings still writes to a real workspace', async () => {
    // NB: not `general.language` — that one is globalOnly and 400s at
    // workspace scope by design (rejectGlobalOnlyAtWorkspace).
    const res = await settingsApp.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'workspace', projectId: ws, key: 'general.compact.keep_messages', value: '7' }),
    })
    expect(res.status).toBe(200)
    const yaml = fs.readFileSync(path.join(ws, '.halo', 'settings.yaml'), 'utf-8')
    expect(yaml).toContain('keep_messages')
  })

  // ── B-M4: prototype pollution ──
  it('PATCH /settings rejects __proto__ / constructor / prototype segments and leaves Object.prototype clean', async () => {
    for (const key of ['__proto__.polluted', 'constructor.prototype.polluted', 'a.__proto__.polluted', 'a.prototype.b']) {
      const res = await settingsApp.request('/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'workspace', projectId: ws, key, value: 'boom' }),
      })
      expect(res.status, key).toBe(400)
    }
    // The actual pollution assertion: a fresh object must not have picked
    // anything up via Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('DELETE /settings rejects __proto__ keys', async () => {
    const res = await settingsApp.request('/settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'workspace', projectId: ws, key: '__proto__.polluted' }),
    })
    expect(res.status).toBe(400)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

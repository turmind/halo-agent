import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { insertAccount } from '../src/channels/shared/accounts.js'
import { createWebRoutes } from '../src/routes/web.js'
import type { WebChannel } from '../src/channels/web/handler.js'

/**
 * Contract: `GET /web/file` honors the workspace-relative hidden table the
 * tool sandbox enforces (`isHiddenWorkspacePath` in tools/sandbox.ts —
 * `.halo/sessions`, `.halo/logs`, `.halo/evo`, `halo.db` + WAL/SHM). The
 * route's realpath boundary check alone only keeps a token INSIDE its
 * workspace; the workspace itself holds every channel/user's transcripts,
 * so without this a readonly token could pull a colleague's session file
 * with `?path=.halo/sessions/<agent>/<sid>.json`.
 *
 * Applied at EVERY access level, full included — same as the sandbox
 * ("this is a security boundary", not a per-level courtesy). Workspace
 * knowledge (`.halo/INSTRUCTIONS.md` etc.) and ordinary files stay served.
 *
 * Mutation check: drop the `isHiddenWorkspacePath` branch in routes/web.ts
 * → the hidden-path cases go red for both tokens.
 */

let tmp: string
let ws: string
let db: ChannelDb

const FULL_TOKEN = 'tok-full'
const RO_TOKEN = 'tok-readonly'

const app = () => createWebRoutes({ db, channel: {} as WebChannel })

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-web-file-hidden-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo', 'sessions', 'default'), { recursive: true })
  fs.mkdirSync(path.join(ws, '.halo', 'logs'), { recursive: true })
  fs.mkdirSync(path.join(ws, '.halo', 'evo', 'runs', 'r1'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.halo', 'sessions', 'default', 'x.json'), '{"messages":[]}')
  fs.writeFileSync(path.join(ws, '.halo', 'sessions', 'x.json'), '{"messages":[]}')
  fs.writeFileSync(path.join(ws, '.halo', 'logs', 'server.log'), 'log')
  fs.writeFileSync(path.join(ws, '.halo', 'evo', 'runs', 'r1', 'patch.md'), 'patch')
  fs.writeFileSync(path.join(ws, '.halo', 'halo.db'), 'sqlite')
  fs.writeFileSync(path.join(ws, '.halo', 'halo.db-wal'), 'wal')
  fs.writeFileSync(path.join(ws, '.halo', 'INSTRUCTIONS.md'), '# instructions')
  fs.writeFileSync(path.join(ws, 'note.txt'), 'hello')
  db = createChannelDb(path.join(tmp, 'secrets'))
  insertAccount(db, { accountId: 'full1', channelType: 'web', workspacePath: ws, accessLevel: 'full', enabled: 1, config: { token: FULL_TOKEN } })
  insertAccount(db, { accountId: 'ro1', channelType: 'web', workspacePath: ws, accessLevel: 'readonly', enabled: 1, config: { token: RO_TOKEN } })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const get = (p: string, token: string) => app().request(`/web/file?path=${encodeURIComponent(p)}&token=${token}`)

const HIDDEN = [
  '.halo/sessions/x.json',
  '.halo/sessions/default/x.json',
  '.halo/logs/server.log',
  '.halo/evo/runs/r1/patch.md',
  '.halo/halo.db',
  '.halo/halo.db-wal',
]

describe.each([
  ['readonly', RO_TOKEN],
  ['full', FULL_TOKEN],
])('GET /web/file hides workspace runtime state — %s token', (_level, token) => {
  it.each(HIDDEN)('refuses %s', async (p) => {
    const res = await get(p, token)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'path is not accessible' })
  })

  it('refuses the same paths written with ./ and .. hops that still land inside the hidden dir', async () => {
    const res = await get('docs/../.halo/sessions/./x.json', token)
    expect(res.status).toBe(403)
  })

  it('still serves workspace knowledge and ordinary files', async () => {
    const instr = await get('.halo/INSTRUCTIONS.md', token)
    expect(instr.status).toBe(200)
    expect(await instr.text()).toBe('# instructions')
    const note = await get('note.txt', token)
    expect(note.status).toBe(200)
    expect(await note.text()).toBe('hello')
  })
})

describe('GET /web/file hidden check runs on the realpath', () => {
  it('a symlink inside the workspace pointing into .halo/sessions is refused too', async () => {
    // The lexical path (`peek.json`) isn't in the table; only the resolved
    // target is — pins that the check consults `real`, not `resolved`.
    fs.symlinkSync(path.join(ws, '.halo', 'sessions', 'x.json'), path.join(ws, 'peek.json'))
    const res = await get('peek.json', FULL_TOKEN)
    expect(res.status).toBe(403)
  })
})

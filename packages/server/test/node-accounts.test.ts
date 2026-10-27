import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { deleteNodeAccount, getNodeAccountByToken, insertNodeAccount, listNodeAccounts } from '../src/nodes/accounts.js'
import { getAccountByToken as getWebAccountByToken, insertAccount as insertWebAccount } from '../src/channels/web/accounts.js'

/** Linked-machine pairing tokens (channel_accounts, channel_type 'node'). */

let tmp: string
let db: ChannelDb
let ws1: string
let ws2: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-node-acc-')))
  db = createChannelDb(path.join(tmp, 'secrets'))
  ws1 = path.join(tmp, 'ws1')
  ws2 = path.join(tmp, 'ws2')
  fs.mkdirSync(ws1)
  fs.mkdirSync(ws2)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function ok(r: ReturnType<typeof insertNodeAccount>) {
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('node accounts', () => {
  it('a name is unique within a workspace — 409 on a repeat', () => {
    ok(insertNodeAccount(db, { workspacePath: ws1, name: 'mbp' }))
    const r = insertNodeAccount(db, { workspacePath: ws1, name: 'mbp' })
    expect(r).toEqual({ error: 'machine name "mbp" is already used in this workspace', status: 409 })
  })

  it('the same workspace via a symlink is the same workspace', () => {
    ok(insertNodeAccount(db, { workspacePath: ws1, name: 'mbp' }))
    const link = path.join(tmp, 'ws1-link')
    fs.symlinkSync(ws1, link)
    expect(insertNodeAccount(db, { workspacePath: link, name: 'mbp' })).toMatchObject({ status: 409 })
  })

  it('different workspaces may reuse a name', () => {
    ok(insertNodeAccount(db, { workspacePath: ws1, name: 'mbp' }))
    ok(insertNodeAccount(db, { workspacePath: ws2, name: 'mbp' }))
    expect(listNodeAccounts(db).map((a) => a.name)).toEqual(['mbp', 'mbp'])
  })

  it('rejects a bad name (400)', () => {
    for (const name of ['', 'MBP', '-x', 'a b', 'a_b', 'x'.repeat(33), undefined]) {
      expect(insertNodeAccount(db, { workspacePath: ws1, name })).toMatchObject({ status: 400 })
    }
    expect(insertNodeAccount(db, { workspacePath: 'relative/ws', name: 'mbp' })).toMatchObject({ status: 400 })
    expect(insertNodeAccount(db, { workspacePath: path.join(tmp, 'missing'), name: 'mbp' })).toMatchObject({ status: 400 })
  })

  it('after a delete the name can be created again', () => {
    const a = ok(insertNodeAccount(db, { workspacePath: ws1, name: 'mbp' }))
    deleteNodeAccount(db, a.accountId)
    expect(getNodeAccountByToken(db, a.token)).toBeUndefined()
    ok(insertNodeAccount(db, { workspacePath: ws1, name: 'mbp' }))
  })

  it('node and web tokens never cross: each lookup sees only its own type', () => {
    const n = ok(insertNodeAccount(db, { workspacePath: ws1, name: 'mbp' }))
    expect(getNodeAccountByToken(db, n.token)?.name).toBe('mbp')
    expect(getWebAccountByToken(db, n.token)).toBeUndefined()
    insertWebAccount(db, { accountId: 'w1', token: 'web-token-xyz', workspacePath: ws1, accessLevel: 'full' })
    expect(getNodeAccountByToken(db, 'web-token-xyz')).toBeUndefined()
    // deleteNodeAccount ignores a non-node row
    deleteNodeAccount(db, 'w1')
    expect(getWebAccountByToken(db, 'web-token-xyz')).toBeDefined()
  })
})

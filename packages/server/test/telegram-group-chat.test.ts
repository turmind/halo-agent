import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'grammy'

/**
 * Telegram group chats (2026 channel cleanup #11). Contract:
 * - session is per USER (`tg_<from.id>_`), shared between that user's DM and
 *   any group they talk in;
 * - the reply goes to the chat the message came from (the group);
 * - `allowedUsers` is checked against the sender, for commands too;
 * - `/skill@thisbot` (what clients send in a group) reaches the skill.
 *
 * Real grammY command matching; only polling and transport are replaced.
 */

const state = vi.hoisted(() => ({ bot: null as Bot | null, sent: [] as Array<{ chatId: number; text: string }> }))

vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>()
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(token: string) {
        super(token, { botInfo: {
          id: 1, is_bot: true, first_name: 'Test', username: 'group_test_bot',
          can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
        } })
        state.bot = this
        this.api.config.use(async (_prev, method, payload) => {
          if (method === 'sendMessage') {
            const p = payload as { chat_id: number; text: string }
            state.sent.push({ chatId: p.chat_id, text: p.text })
          }
          return { ok: true, result: true } as never
        })
      }
      override async start(): Promise<void> {}
      override async stop(): Promise<void> {}
    },
  }
})

const GROUP = -100123
const ALLOWED = 7
const STRANGER = 99
const NOT_ALLOWED = '⚠️ You are not in this bot\'s allowed list'

let home: string
let workspace: string
let channel: import('../src/channels/telegram/handler.js').TelegramChannel
let sm: import('../src/agents/session-manager.js').SessionManager

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function groupText(fromId: number, text: string, updateId: number) {
  const head = text.split(' ')[0]
  return state.bot!.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId, date: 0,
      chat: { id: GROUP, type: 'supergroup', title: 'Team' },
      from: { id: fromId, is_bot: false, first_name: 'U' },
      text,
      ...(text.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: head.length }] } : {}),
    },
  })
}

beforeAll(async () => {
  home = fs.mkdtempSync(join(tmpdir(), 'halo-tg-group-'))
  vi.stubEnv('HOME', home)
  workspace = join(home, 'workspace')
  const skillDir = join(workspace, '.halo', 'skills', 'echo')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(join(skillDir, 'SKILL.md'), ['---', 'name: echo', 'description: test skill', 'command: /echo', '---', '# echo body'].join('\n'))
  const agentDir = join(workspace, '.halo', 'agents', 'default')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(join(agentDir, 'agent.yaml'), [
    'name: default',
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]', 'skills: [echo]',
  ].join('\n'))

  const { SessionManagerRegistry } = await import('../src/agents/session-manager-registry.js')
  const registry = new SessionManagerRegistry()
  const { createChannelDb } = await import('../src/db/channel-db.js')
  const db = createChannelDb(join(home, 'channel-db'))
  const { insertAccount } = await import('../src/channels/telegram/accounts.js')
  insertAccount(db, {
    accountId: 'group-test', botToken: '123:test-only', botUsername: 'group_test_bot',
    workspacePath: workspace, accessLevel: 'full', language: 'en-US', allowedUsers: String(ALLOWED),
  })
  const { startTelegramChannel } = await import('../src/channels/telegram/handler.js')
  channel = startTelegramChannel({ registry, db })
  sm = registry.getOrCreate(workspace)

  const { agentSessions } = await import('../src/db/schema.js')
  sm.getDb().insert(agentSessions).values({
    id: `tg_${ALLOWED}_s1`, parentId: null, agentId: 'default', agentName: 'default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
})

afterEach(() => {
  state.sent.length = 0
  vi.restoreAllMocks()
})

afterAll(async () => {
  await channel?.stopAll()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('telegram group chat', () => {
  it('a group message lands in the SENDER\'s session and the reply goes back to the group', async () => {
    const send = vi.spyOn(sm, 'sendUserMessage').mockResolvedValue(undefined as never)
    await groupText(ALLOWED, 'hello from the group', 1)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe(`tg_${ALLOWED}_s1`)
    expect(send.mock.calls[0]![1]).toContain(`[channel: telegram | user: ${ALLOWED}]`)

    sm.emitEvent(`tg_${ALLOWED}_s1`, { type: 'stream', text: 'group reply', final: true })
    sm.emitEvent(`tg_${ALLOWED}_s1`, { type: 'complete' })
    await tick()
    expect(state.sent).toEqual([{ chatId: GROUP, text: 'group reply' }])
  })

  it('a non-whitelisted member is refused for plain messages', async () => {
    const send = vi.spyOn(sm, 'sendUserMessage')
    await groupText(STRANGER, 'hi bot', 2)
    expect(send).not.toHaveBeenCalled()
    expect(state.sent).toEqual([{ chatId: GROUP, text: NOT_ALLOWED }])
  })

  it.each(['/session list', '/session@group_test_bot list', '/workspace@group_test_bot info'])(
    'a non-whitelisted member is refused for builtin %s too', async (text) => {
      const before = sm.listSessions().sessions.length
      const create = vi.spyOn(sm, 'createSession')
      await groupText(STRANGER, text, 3)
      expect(state.sent).toEqual([{ chatId: GROUP, text: NOT_ALLOWED }])
      expect(create).not.toHaveBeenCalled()
      expect(sm.listSessions().sessions.length).toBe(before)
    },
  )

  it('/skill@thisbot in a group reaches the skill (the @bot suffix is stripped)', async () => {
    const send = vi.spyOn(sm, 'sendUserMessage').mockResolvedValue(undefined as never)
    await groupText(ALLOWED, '/echo@group_test_bot hi', 4)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe(`tg_${ALLOWED}_s1`)
    expect(send.mock.calls[0]![1]).toContain('[Skill activated: /echo]')
    expect(state.sent[0]!.chatId).toBe(GROUP)
  })

  it('/skill@otherbot is not treated as ours', async () => {
    const send = vi.spyOn(sm, 'sendUserMessage').mockResolvedValue(undefined as never)
    await groupText(ALLOWED, '/echo@other_bot hi', 5)
    // Falls through to chat: delivered as a plain message, no skill body.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).not.toContain('[Skill activated')
  })
})

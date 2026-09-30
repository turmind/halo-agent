import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'grammy'

const state = vi.hoisted(() => ({ bot: null as Bot | null, replies: [] as string[] }))

// Keep grammY's real command matching (/goal@botname included); replace only
// polling and transport so the test neither starts a service nor calls Telegram.
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>()
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(token: string) {
        super(token, { botInfo: {
          id: 1, is_bot: true, first_name: 'Test', username: 'goal_test_bot',
          can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
        } })
        state.bot = this
        this.api.config.use(async (_prev, method, payload) => {
          if (method === 'sendMessage') state.replies.push((payload as { text: string }).text)
          return { ok: true, result: true } as never
        })
      }
      override async start(): Promise<void> {}
      override async stop(): Promise<void> {}
    },
  }
})

let home: string
let workspace: string
let channel: import('../src/channels/telegram/handler.js').TelegramChannel
let sm: import('../src/agents/session-manager.js').SessionManager

beforeAll(async () => {
  home = fs.mkdtempSync(join(tmpdir(), 'halo-goal-tg-'))
  vi.stubEnv('HOME', home)
  workspace = join(home, 'workspace')
  fs.mkdirSync(join(workspace, '.halo'), { recursive: true })
  const { SessionManagerRegistry } = await import('../src/agents/session-manager-registry.js')
  const registry = new SessionManagerRegistry()
  const { createChannelDb } = await import('../src/db/channel-db.js')
  const db = createChannelDb(join(home, 'channel-db'))
  const { insertAccount } = await import('../src/channels/telegram/accounts.js')
  insertAccount(db, {
    accountId: 'goal-test', botToken: '123:test-only', botUsername: 'goal_test_bot',
    workspacePath: workspace, accessLevel: 'full', language: 'en-US',
  })
  const { startTelegramChannel } = await import('../src/channels/telegram/handler.js')
  channel = startTelegramChannel({ registry, db })
  sm = registry.getOrCreate(workspace)
})

afterAll(async () => {
  await channel?.stopAll()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('hidden goal command in Telegram', () => {
  it.each(['/goal', '/goal@goal_test_bot', '/goal@goal_test_bot help', '/goal@goal_test_bot create test'])('%s reaches the disabled response, never chat', async (text) => {
    state.replies.length = 0
    const send = vi.spyOn(sm, 'sendUserMessage')
    const create = vi.spyOn(sm, 'createSession')
    await state.bot!.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1, date: 0, chat: { id: 42, type: 'private', first_name: 'Test' },
        from: { id: 42, is_bot: false, first_name: 'Test' }, text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
      },
    })
    expect(state.replies).toEqual(['Goal mode is disabled.'])
    expect(send).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(sm.listSessions().sessions).toEqual([])
    expect(fs.existsSync(join(workspace, '.halo', 'goal'))).toBe(false)
    vi.restoreAllMocks()
  })
})

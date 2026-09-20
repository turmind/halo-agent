import { describe, it, expect } from 'vitest'
import type { BaseMessage } from '@wecom/aibot-node-sdk'
import { stripGroupMention, pickConversation, sniffImageMime } from '../src/channels/wecom/handler.js'
import { normalizeWecomId } from '../src/channels/wecom/accounts.js'

/**
 * Pure helpers of the WeCom handler — no network, no SDK instantiation.
 * `handler.ts` imports `WSClient` at module level but only constructs it
 * inside `startWecomChannel`, so importing the helpers is side-effect free.
 */

const base = (over: Partial<BaseMessage>): BaseMessage => ({
  msgid: 'm1',
  aibotid: 'bot',
  chattype: 'single',
  from: { userid: 'alice' },
  msgtype: 'text',
  ...over,
})

describe('stripGroupMention', () => {
  it('strips a single leading @mention', () => {
    expect(stripGroupMention('@Halo hello')).toBe('hello')
  })

  it('strips several leading @mentions', () => {
    expect(stripGroupMention('@A @B hi')).toBe('hi')
  })

  it('leaves a non-leading @ untouched', () => {
    expect(stripGroupMention('hello @x')).toBe('hello @x')
  })

  // Documented behaviour: only whitespace-free `@token`s are stripped, so a
  // multi-word bot name leaves its tail as residue. Preferable to guessing
  // the bot's display name and eating the user's first word.
  it('leaves the tail of a multi-word bot name as residue', () => {
    expect(stripGroupMention('@Halo 助手 hello')).toBe('助手 hello')
  })

  it('handles an empty / mention-only message', () => {
    expect(stripGroupMention('')).toBe('')
    expect(stripGroupMention('@Halo')).toBe('')
  })
})

describe('normalizeWecomId', () => {
  it('folds chars outside [\\w-] to dashes', () => {
    expect(normalizeWecomId('a@b.c')).toBe('a-b-c')
    expect(normalizeWecomId('wr_AbC-12')).toBe('wr_AbC-12')
  })
})

describe('pickConversation', () => {
  it('single chat: keys on the (normalized) userid', () => {
    const conv = pickConversation(base({ from: { userid: 'a@b.c' } }))
    expect(conv).toEqual({
      key: 'a-b-c',
      chatKey: 'a@b.c',
      chatType: 'single',
      chatId: 'a@b.c',
      userid: 'a@b.c',
    })
  })

  it('group chat: one shared key per chatid, user carried separately', () => {
    const conv = pickConversation(base({ chattype: 'group', chatid: 'wr.grp@1', from: { userid: 'bob' } }))
    expect(conv.chatType).toBe('group')
    expect(conv.key).toBe('wr-grp-1')
    expect(conv.chatKey).toBe('wr.grp@1')
    expect(conv.chatId).toBe('wr.grp@1')
    expect(conv.userid).toBe('bob')
  })

  it('two users in the same group resolve to the same key', () => {
    const a = pickConversation(base({ chattype: 'group', chatid: 'g1', from: { userid: 'u1' } }))
    const b = pickConversation(base({ chattype: 'group', chatid: 'g1', from: { userid: 'u2' } }))
    expect(a.key).toBe(b.key)
    expect(a.userid).not.toBe(b.userid)
  })

  it('group without chatid degrades to single-chat keying', () => {
    const conv = pickConversation(base({ chattype: 'group', from: { userid: 'u1' } }))
    expect(conv.chatType).toBe('single')
    expect(conv.key).toBe('u1')
  })
})

describe('sniffImageMime', () => {
  it('png', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
  })
  it('gif', () => {
    expect(sniffImageMime(Buffer.from('GIF89a', 'ascii'))).toBe('image/gif')
  })
  it('falls back to jpeg', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('not an image'))).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.alloc(0))).toBe('image/jpeg')
  })
})

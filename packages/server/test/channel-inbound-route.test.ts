import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { InboundBridge, deliverInbound, dispatchChannelCommand } from '../src/channels/shared/inbound.js'
import { wxRoute } from '../src/channels/wechat/handler.js'
import { WechatResponder } from '../src/channels/wechat/event-adapter.js'
import type { CommandContext } from '../src/channels/shared/commands.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Regression coverage for two audited channel bugs (audit A, 2026-08-06),
 * fixed structurally in channels/shared/inbound.ts:
 *
 *   A-M2 — the wechat responder closure captured `fromUserId` at listener-
 *   registration time. A session later driven by a DIFFERENT user (full-access
 *   `/session switch`) kept replying to the first user, and the side-table
 *   `sessionContextTokens` map only ever grew. Fix: the reply route is a
 *   per-session value refreshed on every inbound message; responders read it
 *   lazily via `bridge.getRoute` at send time, and the route entry is dropped
 *   together with its listener.
 *
 *   A-M5 — the four channels' command-dispatch sites ignored
 *   `CommandResult.startedTurn`: a skill command kicked the agent without any
 *   responder listener attached, so the skill body's reply was silently
 *   dropped. Fix: `dispatchChannelCommand` wires route + listener whenever
 *   dispatch reports startedTurn.
 *
 * Driven through the REAL shared seam (`deliverInbound` /
 * `dispatchChannelCommand` / `InboundBridge`) with the REAL WechatResponder
 * and the REAL wechat route factory (`wxRoute` — the token-carry-over rules
 * live there). The test's `makeResponder` deps mirror the production closure
 * in wechat/handler.ts byte-for-byte in structure: `bridge.getRoute(sessionId)`
 * read at send-call entry. Sessions are the same compacting in-memory stubs
 * used by telegram-inbound-media.test.ts, so `sendUserMessage` queues and no
 * model runtime is ever built.
 */

interface WxRoute {
  fromUserId: string
  contextToken?: string
}

interface Sent {
  toUserId: string
  contextToken?: string
  text: string
}

let ws: string
let secretsDir: string
let sm: SessionManager
let channelDb: ChannelDb

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** In-memory compacting stub: sendUserMessage queues instead of running a
 *  turn (same seeding approach as telegram-inbound-media.test.ts). */
function injectStub(id: string): { messageQueue: Array<{ text: string }> } {
  const stub = { accessLevel: null, isCompacting: true, promise: null, messageQueue: [] as Array<{ text: string }> }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, stub)
  return stub
}

/** Listener count for a root session, read out of the real store (same
 *  deliberate private access as ws-abandoned-listener-reclaim.test.ts —
 *  the listener set IS the resource under test). */
function listenerCount(sessionId: string): number {
  return (sm as unknown as {
    uiStore: { eventListeners: Map<string, Set<unknown>> }
  }).uiStore.eventListeners.get(sessionId)?.size ?? 0
}

/** Bridge wired exactly like wechat/handler.ts's startAccount: the responder
 *  deps read `bridge.getRoute(sessionId)` lazily at send time. */
function makeBridge(sends: Sent[]): InboundBridge<WxRoute> {
  const bridge: InboundBridge<WxRoute> = new InboundBridge({
    channel: 'wechat',
    makeResponder: (sessionId) => new WechatResponder({
      sendText: async (chunk) => {
        const route = bridge.getRoute(sessionId)
        if (!route) return
        sends.push({ toUserId: route.fromUserId, contextToken: route.contextToken, text: chunk })
      },
      sendMedia: async () => {},
    }),
  })
  return bridge
}

/** One inbound wechat text message through the shared tail. */
async function deliver(args: {
  bridge: InboundBridge<WxRoute>
  overrides: Map<string, string>
  fromUserId: string
  text: string
  contextToken?: string
}): Promise<string> {
  return deliverInbound({
    sm,
    db: channelDb,
    accountId: 'wx-acc-test',
    bridge: args.bridge,
    chatKey: args.fromUserId,
    tagKey: args.fromUserId,
    sessionPrefix: `wx_${args.fromUserId}_`,
    activeOverrides: args.overrides,
    accountAccessLevel: 'full',
    workspacePath: ws,
    sessionLabel: `WeChat: ${args.fromUserId}`,
    route: wxRoute(args.fromUserId, args.contextToken),
    lang: 'en',
    sendHint: async () => {},
    uiText: args.text,
    agentText: args.text,
    userTag: args.fromUserId,
  })
}

function writeAgent(agentId: string, skills: string[]): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${agentId}`,
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
    `skills: [${skills.join(', ')}]`,
  ].join('\n'))
}

function writeSkill(skillId: string, command: string): void {
  const dir = join(ws, '.halo', 'skills', skillId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), [
    '---', `name: ${skillId}`, `description: test skill ${skillId}`, `command: ${command}`, '---',
    `# ${skillId} body`,
  ].join('\n'))
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-inbound-route-ws-'))
  secretsDir = mkdtempSync(join(tmpdir(), 'halo-inbound-route-db-'))
  sm = new SessionManager(ws)
  channelDb = createChannelDb(secretsDir)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(secretsDir, { recursive: true, force: true })
})

// ── A-M2: reply route follows the latest inbound user ───────────────────────

describe('A-M2 — responder replies to the LATEST inbound user, never the first', () => {
  it('after a full-access user takes over the session, replies go to them (same listener, refreshed route)', async () => {
    const SID = 'wx_userA_s1'
    seedRow(SID)
    injectStub(SID)
    const sends: Sent[] = []
    const bridge = makeBridge(sends)
    const overrides = new Map<string, string>()

    // userA opens the conversation.
    const sid1 = await deliver({ bridge, overrides, fromUserId: 'userA', text: 'hi from A', contextToken: 'tok-A' })
    expect(sid1).toBe(SID)
    sm.emitEvent(SID, { type: 'stream', text: 'reply to A', final: true })
    sm.emitEvent(SID, { type: 'complete' })
    await tick()
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ toUserId: 'userA', contextToken: 'tok-A', text: 'reply to A' })

    // userB (full access) has run `/session switch` onto A's session — the
    // override is exactly what execSwitch sets. B's message lands on SID.
    overrides.set('userB', SID)
    const sid2 = await deliver({ bridge, overrides, fromUserId: 'userB', text: 'hi from B', contextToken: 'tok-B' })
    expect(sid2).toBe(SID)

    // Listener was registered once — the SAME responder must now send to B.
    // Pre-fix, the closure had locked fromUserId=userA at registration time.
    expect(listenerCount(SID)).toBe(1)
    sm.emitEvent(SID, { type: 'stream', text: 'reply to B', final: true })
    sm.emitEvent(SID, { type: 'complete' })
    await tick()
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ toUserId: 'userB', contextToken: 'tok-B', text: 'reply to B' })
  })

  it('wxRoute: context token carries over within the same user, never across users', () => {
    const bridge = makeBridge([])
    const SID = 'wx_userA_s2'

    bridge.setRoute(SID, wxRoute('userA', 'tok-1'))
    expect(bridge.getRoute(SID)!.fromUserId).toBe('userA')
    expect(bridge.getRoute(SID)!.contextToken).toBe('tok-1')

    // Same user, next message without a token → still-valid token kept.
    bridge.setRoute(SID, wxRoute('userA', undefined))
    expect(bridge.getRoute(SID)!.contextToken).toBe('tok-1')

    // DIFFERENT user takes over without a token → A's passive-reply-window
    // credential must NOT be replayed against B.
    bridge.setRoute(SID, wxRoute('userB', undefined))
    expect(bridge.getRoute(SID)!.fromUserId).toBe('userB')
    expect(bridge.getRoute(SID)!.contextToken).toBeUndefined()

    // B's own token then applies normally.
    bridge.setRoute(SID, wxRoute('userB', 'tok-2'))
    expect(bridge.getRoute(SID)!.contextToken).toBe('tok-2')
  })

  it('dropListener flushes buffered output to the current route, then frees the route entry (the sessionContextTokens leak)', async () => {
    const SID = 'wx_userA_s3'
    seedRow(SID)
    injectStub(SID)
    const sends: Sent[] = []
    const bridge = makeBridge(sends)

    await deliver({ bridge, overrides: new Map(), fromUserId: 'userA', text: 'hi', contextToken: 'tok-A' })
    // Stream text WITHOUT complete — stays in the responder buffer.
    sm.emitEvent(SID, { type: 'stream', text: 'partial reply', final: true })

    bridge.dropListener(SID)
    await tick()

    // close() ran before the route entry was deleted, so the flush still had
    // a destination (routes are deleted AFTER close in the unsubscribe fn).
    expect(sends.at(-1)).toMatchObject({ toUserId: 'userA', contextToken: 'tok-A', text: 'partial reply' })
    expect(listenerCount(SID)).toBe(0)
    expect(bridge.getRoute(SID)).toBeUndefined()
  })

  it('closeAll tears down every listener and empties the route map (stopAccount path)', async () => {
    const A = 'wx_userA_s4'
    const B = 'wx_userB_s4'
    seedRow(A); seedRow(B)
    injectStub(A); injectStub(B)
    const sends: Sent[] = []
    const bridge = makeBridge(sends)

    await deliver({ bridge, overrides: new Map(), fromUserId: 'userA', text: 'a' })
    await deliver({ bridge, overrides: new Map(), fromUserId: 'userB', text: 'b' })
    expect(listenerCount(A)).toBe(1)
    expect(listenerCount(B)).toBe(1)

    bridge.closeAll()
    expect(listenerCount(A)).toBe(0)
    expect(listenerCount(B)).toBe(0)
    // The internal map is the leaked resource pre-fix — must be empty once the
    // responders have drained. WechatResponder serializes its sends (same
    // chain as slack/feishu) and hands the bridge a drain promise, so the
    // route is released after it settles, not synchronously.
    await tick()
    expect((bridge as unknown as { routes: Map<string, unknown> }).routes.size).toBe(0)
  })
})

// ── A-M5: skill command startedTurn wires the responder ─────────────────────

describe('A-M5 — dispatchChannelCommand wires route + listener on startedTurn', () => {
  it('a skill command on a fresh session attaches the listener so the agent reply reaches the user', async () => {
    writeSkill('echo', '/echo')
    writeAgent('default', ['echo'])
    const SID = 'wx_userA_k1'
    seedRow(SID)
    const stub = injectStub(SID)
    const sends: Sent[] = []
    const bridge = makeBridge(sends)

    const ctx: CommandContext = {
      sm, userId: 'userA', sessionPrefix: 'wx_userA_', accessLevel: 'full',
      channelLabel: 'WeChat: userA', activeOverrides: new Map(), workspacePath: ws, lang: 'en',
      channel: { type: 'wechat', accountId: 'wx-acc-test', chatId: 'userA' },
    }
    const result = await dispatchChannelCommand(ctx, '/echo', 'hello', {
      bridge, route: wxRoute('userA', 'tok-1'), channelName: 'wechat',
    })

    // dispatch reached execSkillCommand and kicked the agent.
    expect(result?.startedTurn).toBe(true)
    expect(result?.sessionId).toBe(SID)
    await tick(50)
    expect(stub.messageQueue).toHaveLength(1)
    expect(stub.messageQueue[0]!.text).toContain('[Skill activated: /echo]')

    // THE fix: listener + route wired without any plain message ever having
    // passed through deliverInbound for this session. Pre-fix both missing.
    expect(listenerCount(SID)).toBe(1)
    expect(bridge.getRoute(SID)).toMatchObject({ fromUserId: 'userA', contextToken: 'tok-1' })

    // The skill body's eventual reply actually lands with the user.
    sm.emitEvent(SID, { type: 'stream', text: 'echo says hi', final: true })
    sm.emitEvent(SID, { type: 'complete' })
    await tick()
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ toUserId: 'userA', text: 'echo says hi' })
  })

  it('builtin command (no startedTurn) wires nothing', async () => {
    const SID = 'wx_userA_k2'
    seedRow(SID)
    injectStub(SID)
    const bridge = makeBridge([])
    const ctx: CommandContext = {
      sm, userId: 'userA', sessionPrefix: 'wx_userA_', accessLevel: 'full',
      channelLabel: 'WeChat: userA', activeOverrides: new Map(), workspacePath: ws, lang: 'en',
    }
    const result = await dispatchChannelCommand(ctx, '/session', 'list', {
      bridge, route: wxRoute('userA', undefined), channelName: 'wechat',
    })
    expect(result?.text).toBeTruthy()
    expect(result?.startedTurn).toBeUndefined()
    expect(listenerCount(SID)).toBe(0)
    expect(bridge.getRoute(SID)).toBeUndefined()
  })

  it('startedTurn with no constructible route degrades to a log — turn still ran, nothing wired (defensive branch)', async () => {
    writeSkill('echo', '/echo')
    writeAgent('default', ['echo'])
    const SID = 'wx_userA_k3'
    seedRow(SID)
    const stub = injectStub(SID)
    const bridge = makeBridge([])
    const ctx: CommandContext = {
      sm, userId: 'userA', sessionPrefix: 'wx_userA_', accessLevel: 'full',
      channelLabel: 'WeChat: userA', activeOverrides: new Map(), workspacePath: ws, lang: 'en',
    }
    const result = await dispatchChannelCommand(ctx, '/echo', 'hello', {
      bridge, route: undefined, channelName: 'wechat',
    })
    expect(result?.startedTurn).toBe(true)
    await tick(50)
    expect(stub.messageQueue).toHaveLength(1)
    expect(listenerCount(SID)).toBe(0)
  })
})

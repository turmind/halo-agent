import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import { createElement as h } from 'react'
import { render } from 'ink'
import { fakeTty, captureOutput, stripAnsi, flush, waitFor, INK_TEST_OPTIONS } from './fixtures/fake-tty.js'

// The TUI persists input history to ~/.halo/global/tui-history.json; a test
// that submits a message must not append to the developer's real history.
vi.mock('../src/tui/history.js', () => ({
  loadHistory: () => [],
  appendHistory: () => {},
}))

const { App } = await import('../src/tui/app.js')
import type { Harness, SessionTreeNode } from '../src/harness.js'
import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'

/**
 * Contract (audit E-H1): ink dispatches every key to EVERY mounted `useInput`
 * handler — there is no capture or bubbling. So the app-level
 * "Esc interrupts the running turn" handler must explicitly stand down
 * whenever a modal owns Esc for itself:
 *
 *   - log viewer open  → Esc closes the viewer only
 *   - log navigator open → Esc closes the navigator only (its own header
 *     advertises "Esc/q to cancel")
 *   - completion popup open → Esc dismisses the popup only
 *
 * Mutation check (each verified red when reverted): remove any one of
 * `!viewer` / `!navTree` / `!popupOpen` from the guard in app.tsx and the
 * matching "does not interrupt" test below fails.
 */

interface Stub {
  harness: Harness
  interrupts: () => number
}

function stubHarness(): Stub {
  let interrupts = 0
  const handlers = new Set<(e: AgentSessionEvent) => void>()
  const tree: SessionTreeNode = {
    id: 'cli_root', agentName: 'dev', status: 'running', children: [],
  } as unknown as SessionTreeNode
  const harness = {
    sessionId: 'cli_root',
    workspace: os.tmpdir(),
    agentId: 'dev',
    lang: 'en',
    supportsImage: false,
    run: async function* () { /* unused */ },
    send: async () => 'running' as const,
    onEvent: (fn: (e: AgentSessionEvent) => void) => { handlers.add(fn) },
    offEvent: (fn: (e: AgentSessionEvent) => void) => { handlers.delete(fn) },
    command: async () => null,
    interrupt: () => { interrupts++ },
    stop: async () => {},
    destroy: () => {},
    switchWorkspace: async () => {},
    getSessionTree: () => tree,
    // One tool message so the viewer has a line to show (an empty log makes
    // handleNavPick bail with "has no log" instead of opening the viewer).
    getSessionMessages: async () => [{ toolName: 'shell_exec', toolOutput: 'ok', timestamp: 0 }],
    isSessionRunning: () => true,
    listCommands: async () => [
      { name: 'help', slashName: '/help', description: 'show help', type: 'client', source: 'builtin' },
      { name: 'history', slashName: '/history', description: 'show history', type: 'client', source: 'builtin' },
    ],
    getMaxContextTokens: async () => 200_000,
  } as unknown as Harness
  return { harness, interrupts: () => interrupts }
}

/** Mount App on a pseudo-TTY and drive it by writing raw key bytes to stdin. */
async function mountApp() {
  const stdout = fakeTty(100, 30)
  const read = captureOutput(stdout)
  const stdin = fakeTty()
  const stub = stubHarness()
  const app = render(h(App, { harness: stub.harness, verbose: false }), {
    stdout, stdin, ...INK_TEST_OPTIONS,
  })
  await flush(app)
  const press = async (bytes: string) => {
    stdin.write(bytes)
    await flush(app)
  }
  const frame = () => stripAnsi(read())
  let exited = false
  app.waitUntilExit().then(() => { exited = true }, () => { exited = true })
  return {
    press,
    frame,
    /** Forget frames written so far, so the next assertion reads fresh output. */
    resetFrames: () => read.reset(),
    /** Press a key, then wait until the frame it produces shows `text`. */
    async pressUntil(bytes: string, text: string) {
      await press(bytes)
      await waitFor(() => frame().includes(text), `${JSON.stringify(text)} after key ${JSON.stringify(bytes)}`, frame)
    },
    interrupts: stub.interrupts,
    exited: () => exited,
    async done() {
      app.unmount()
      await app.waitUntilExit()
    },
  }
}

const ESC = '\x1b'
const ENTER = '\r'
const CTRL_O = '\x0f'
const CTRL_C = '\x03'

/**
 * Settle time for the NEGATIVE assertions ("Esc did not interrupt", "one Ctrl+C
 * did not exit"). A positive assertion can poll until it comes true, but proving
 * absence needs a real window in which the wrong thing could have happened —
 * several render cycles plus a fixed grace period, so the test isn't merely
 * asserting "faster than the bug".
 */
async function flushAndSettle(t: Awaited<ReturnType<typeof mountApp>>) {
  for (let i = 0; i < 3; i++) await t.press('')
  await new Promise((r) => setTimeout(r, 150))
}

/** Get the app into `running` state the way a real turn does: submit a message
 *  whose `send()` resolves to 'running'. The hint switching to "esc to
 *  interrupt" is the observable proof that `state.running` is set — waiting for
 *  it removes the "did the turn start yet?" race from every test below. */
async function startTurn(t: Awaited<ReturnType<typeof mountApp>>) {
  await t.press('hello')
  await t.pressUntil(ENTER, 'esc to interrupt')
}

describe('E-H1 — Esc while a modal is open must not interrupt the turn', () => {
  it('baseline: Esc with nothing open DOES interrupt the running turn', async () => {
    const t = await mountApp()
    await startTurn(t)
    expect(t.interrupts()).toBe(0)
    await t.pressUntil(ESC, 'interrupting')
    expect(t.interrupts()).toBe(1)
    await t.done()
  })

  it('log navigator open: Esc closes it and leaves the turn running', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.pressUntil(CTRL_O, 'Session log')
    // Navigator gone → the input box (and its hint) is back. Reset first: the
    // reader accumulates, so the pre-navigator hint is still in the buffer.
    t.resetFrames()
    await t.pressUntil(ESC, 'esc to interrupt')
    expect(t.interrupts()).toBe(0)
    // …and Esc now reaches the interrupt handler again.
    await t.pressUntil(ESC, 'interrupting')
    expect(t.interrupts()).toBe(1)
    await t.done()
  })

  it('log viewer open: Esc closes it and leaves the turn running', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.pressUntil(CTRL_O, 'Session log')
    await t.pressUntil(ENTER, 'q to close') // pick the root session → viewer opens
    t.resetFrames()
    await t.pressUntil(ESC, 'esc to interrupt')
    expect(t.interrupts()).toBe(0)
    await t.done()
  })

  it('completion popup open: Esc dismisses the popup and leaves the turn running', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.pressUntil('/h', 'show help')
    await t.press(ESC)
    // The popup owns this Esc: give the interrupt path every chance to fire
    // wrongly (it would land within a poll tick) before asserting it didn't.
    await flushAndSettle(t)
    expect(t.interrupts()).toBe(0)
    // Second Esc — popup already dismissed, so this one interrupts.
    await t.pressUntil(ESC, 'interrupting')
    expect(t.interrupts()).toBe(1)
    await t.done()
  })

  it('Ctrl+C is unaffected by the guard — still exits (twice) with a modal open', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.pressUntil(CTRL_O, 'Session log')
    await t.press(CTRL_C)
    await flushAndSettle(t)
    expect(t.exited()).toBe(false)
    await t.press(CTRL_C)
    await waitFor(() => t.exited(), 'the app to exit on the second Ctrl+C', t.frame)
    expect(t.interrupts()).toBe(0)
    await t.done()
  })
})

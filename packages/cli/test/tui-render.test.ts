import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { render, Box, Text } from 'ink'
import { Messages } from '../src/tui/components/messages.js'
import { LogViewer } from '../src/tui/components/log-viewer.js'
import { Streaming } from '../src/tui/components/streaming.js'
import { truncateLines, messagesToLogLines } from '../src/tui/app.js'
import type { ChatBlock } from '../src/tui/types.js'
import { fakeTty, captureOutput, stripAnsi, displayWidth, flush, INK_TEST_OPTIONS } from './fixtures/fake-tty.js'

/**
 * Byte-level assertions on what ink actually writes to a (pseudo-)TTY. ink's
 * tokenizer strips non-SGR CSI and OSC on its own, but NOT C0 controls, and it
 * only truncates what a component asks it to — so the three fixes below can
 * only be pinned by looking at the emitted frame.
 *
 * Mutation checks (each verified to go red when the fix is reverted, with and
 * without CI=true in the environment):
 *   E-H2 — drop `sanitizeToolOutput` from `truncateLines` / `messagesToLogLines`
 *          → "no CR reaches the terminal" tests fail.
 *   E-M1 — put the hand-rolled `truncateForCols` back in LogViewer (or drop
 *          `wrap="truncate-end"`) → the CJK row exceeds the terminal width and
 *          the fixed-height viewport pushes the footer out of the frame.
 *   E-M2 — render `liveText` instead of the row-capped tail → a long streaming
 *          reply makes ink emit clearTerminal (`2J` + `3J`) per frame.
 *
 * Every render goes through INK_TEST_OPTIONS — see fake-tty.ts for why
 * `interactive: true` is mandatory rather than cosmetic.
 */

async function renderFrame(node: React.ReactElement, columns = 80, rows = 24): Promise<string> {
  const stdout = fakeTty(columns, rows)
  const read = captureOutput(stdout)
  const stdin = fakeTty()
  const app = render(node, { stdout, stdin, ...INK_TEST_OPTIONS })
  await flush(app)
  const out = read()
  app.unmount()
  await app.waitUntilExit()
  // Guard the whole file's negative assertions: an empty frame satisfies every
  // `not.toMatch(/\r/)` / `isWellFormed()` check for the wrong reason. That is
  // exactly how non-interactive ink (CI=true) turned real coverage into silent
  // vacuous passes — fail loudly instead.
  if (out === '') throw new Error('ink wrote no frame — INK_TEST_OPTIONS.interactive must be true')
  return out
}

const toolBlock = (toolResult: string): ChatBlock => ({
  id: 'b1', kind: 'tool', text: '', toolName: 'shell_exec', toolResult,
})

describe('E-H2 — C0 control chars from tool output never reach the terminal', () => {
  // A pip-style progress bar: the classic shell_exec result, and shell_exec is
  // the one tool whose output shows without -v.
  const PROGRESS = 'Collecting halo\r  1% |#         |\r100% |##########|\ndone\x07'

  it('truncateLines (chat block seam) removes CR/BEL and splits redraws into lines', () => {
    const body = truncateLines(PROGRESS, 20, 200)
    expect(body).not.toMatch(/\r/)
    expect(body).not.toContain('\x07')
    expect(body.split('\n')).toEqual([
      'Collecting halo',
      '  1% |#         |',
      '100% |##########|',
      'done',
    ])
  })

  it('the rendered <Static> chat block writes no CR — the │ gutter survives', async () => {
    const out = await renderFrame(h(Messages, { blocks: [toolBlock(truncateLines(PROGRESS, 20, 200))] }))
    expect(out).not.toMatch(/\r/)
    expect(out).not.toContain('\x07')
    // Every redraw frame is now its own gutter-prefixed row.
    const gutter = stripAnsi(out).split('\n').filter((l) => l.includes('│ '))
    expect(gutter.length).toBe(4)
    expect(gutter.some((l) => l.includes('100% |##########|'))).toBe(true)
  })

  it('messagesToLogLines (viewer seam) sanitizes a string toolOutput', () => {
    const lines = messagesToLogLines([{ toolName: 'shell_exec', toolOutput: PROGRESS, timestamp: 0 }])
    const body = lines.map((l) => l.text).join('\n')
    expect(body).not.toMatch(/\r/)
    expect(body).not.toContain('\x07')
    expect(body).toContain('100% |##########|')
  })

  it('the rendered log viewer writes no CR/BEL either', async () => {
    const lines = messagesToLogLines([{ toolName: 'shell_exec', toolOutput: PROGRESS, timestamp: 0 }])
    const out = await renderFrame(h(LogViewer, { title: 'Log', lines, onClose: () => {} }), 80, 30)
    expect(out).not.toMatch(/\r/)
    expect(out).not.toContain('\x07')
  })

  it('a foreign SGR reset in tool output cannot leak into the frame', async () => {
    const out = await renderFrame(h(Messages, {
      blocks: [toolBlock(truncateLines('start\x1b[0mrest of line', 20, 200))],
    }))
    expect(stripAnsi(out)).toContain('startrest of line')
  })
})

describe('E-M1 — log viewer lines occupy exactly one row at any width', () => {
  // The viewport is a FIXED-height box (`height={viewportRows}`, 16 rows at
  // rows=30), so a wrapped line is only observable once the viewport is full —
  // it then steals a row from the line below and the overflow bleeds into the
  // footer. A 3-line fixture proves nothing: the box clips the slack silently.
  const fillViewport = (n = 16) =>
    Array.from({ length: n }, (_, i) => ({ text: `\x1b[90mL${i}\x1b[0m ` + '中文日志行'.repeat(20) }))

  it('every line of a full viewport still reaches the screen (CJK counted at 2 columns)', async () => {
    const lines = fillViewport()
    const plain = stripAnsi(await renderFrame(h(LogViewer, { title: 'Log: sid_x', lines, onClose: () => {} }), 80, 30))
    // One row per line: all 16 tags visible, and no row wider than the terminal.
    for (let i = 0; i < lines.length; i++) expect(plain).toMatch(new RegExp(`L${i}\\b`))
    for (const row of plain.split('\n')) {
      if (row !== '') expect(displayWidth(row)).toBeLessThanOrEqual(80)
    }
  })

  it('the footer row stays clean — a wrapped CJK line used to bleed into it', async () => {
    const plain = stripAnsi(await renderFrame(
      h(LogViewer, { title: 'Log: sid_x', lines: fillViewport(), onClose: () => {} }), 80, 30,
    ))
    expect(plain).toContain('╰')
    const footer = plain.split('\n').find((r) => r.includes('/ 16'))
    expect(footer).toBeDefined()
    expect(footer).toContain('q to close')
    // The regression signature: log content overflowing the fixed-height
    // viewport landed between the counter and the key hints.
    expect(footer).not.toMatch(/中文/)
  })

  it('truncation does not tear a surrogate pair even at a 2-column cut', async () => {
    const out = await renderFrame(
      h(LogViewer, { title: 'T', lines: [{ text: '🎯'.repeat(80) }], onClose: () => {} }),
      // 40 cols → the emoji row must be cut mid-run.
      40, 30,
    )
    expect(out.isWellFormed()).toBe(true)
    expect(out).not.toContain('\ufffd')
  })
})

describe('E-M2 — the live streaming zone is capped to the terminal height', () => {
  /** Stream `lineCount` lines into <Streaming> the way app.tsx does (liveText
   *  only grows until usage/complete commits it) and report whether ink fell
   *  back to a full clearTerminal — `2J` + `3J`, and `3J` erases scrollback. */
  async function streamAndWatch(lineCount: number, rows = 24): Promise<{ clearTerminal: boolean; bytes: number }> {
    const stdout = fakeTty(80, rows)
    const read = captureOutput(stdout)
    const stdin = fakeTty()
    const frame = (text: string) => h(Box, { flexDirection: 'column' },
      h(Streaming, {
        key: 's', spinnerLabel: null, liveText: text, liveThinking: null,
        activeSubs: [], turnStartedAt: null,
      }),
      // Stand-in for the status bar + input box below the live zone.
      h(Box, { key: 'i', borderStyle: 'round' }, h(Text, null, '> ')),
    )
    let text = ''
    const app = render(frame(text), { stdout, stdin, ...INK_TEST_OPTIONS })
    await flush(app)
    for (let i = 0; i < lineCount; i++) {
      text += `paragraph line ${i}\n`
      app.rerender(frame(text))
      // Per-frame flush, not a fixed sleep: every frame must actually reach
      // stdout, otherwise ink coalesces the stream into one write and the
      // clearTerminal check below never sees the incremental growth that
      // triggers it.
      await flush(app)
    }
    const out = read()
    app.unmount()
    await app.waitUntilExit()
    return { clearTerminal: out.includes('\x1b[2J') && out.includes('\x1b[3J'), bytes: out.length }
  }

  it('a reply far longer than the viewport never triggers ink clearTerminal (no ESC 3J → scrollback intact)', async () => {
    const { clearTerminal } = await streamAndWatch(40)
    expect(clearTerminal).toBe(false)
  })

  it('a short reply behaves exactly as before (no cap side effects)', async () => {
    const out = await renderFrame(h(Streaming, {
      spinnerLabel: null, liveText: 'one\ntwo\nthree', liveThinking: null,
      activeSubs: [], turnStartedAt: null,
    }))
    const plain = stripAnsi(out)
    expect(plain).toContain('one')
    expect(plain).toContain('two')
    expect(plain).toContain('three')
  })

  it('shows the TAIL of a long reply (newest text), not the head', async () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const out = await renderFrame(h(Streaming, {
      spinnerLabel: null, liveText: text, liveThinking: null,
      activeSubs: [], turnStartedAt: null,
    }))
    const plain = stripAnsi(out)
    expect(plain).toContain('line 59')
    expect(plain).not.toContain('line 0\n')
  })
})

describe('the harness itself renders live frames regardless of environment', () => {
  // Meta-test: the CI failure was environmental, not logical — ink writes
  // dynamic frames only in interactive mode, and `is-in-ci` flips that off on
  // any machine with CI set. Pin it here so a future edit to INK_TEST_OPTIONS
  // (or an ink upgrade that changes the default) fails one obvious test instead
  // of quietly hollowing out every assertion above.
  it('emits a frame while mounted, not just at unmount', async () => {
    const stdout = fakeTty(80, 24)
    const read = captureOutput(stdout)
    const app = render(h(Text, null, 'LIVE-FRAME-MARKER'), {
      stdout, stdin: fakeTty(), ...INK_TEST_OPTIONS,
    })
    await flush(app)
    const whileMounted = read()
    app.unmount()
    await app.waitUntilExit()
    expect(whileMounted).toContain('LIVE-FRAME-MARKER')
  })

  it('INK_TEST_OPTIONS forces interactive mode even when CI is set', () => {
    expect(INK_TEST_OPTIONS.interactive).toBe(true)
  })
})

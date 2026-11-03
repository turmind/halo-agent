/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The `PredictionStats` and `timeline` suites are ported from VS Code's
 * terminalTypeAhead.test.ts:
 * https://github.com/microsoft/vscode/blob/ae11932c6109d3977d78f2fe8937d861e246151d/src/vs/workbench/contrib/terminalContrib/typeAhead/test/browser/terminalTypeAhead.test.ts
 * (MIT, commit ae11932c6109d3977d78f2fe8937d861e246151d). Halo changes:
 * vitest instead of mocha / sinon, `beforeServerInput()` instead of an
 * `onBeforeProcessData` event, and the fixed `dim` style (CSI 2m / 22m)
 * instead of the `italic` (3m / 23m) the upstream suite configures. The
 * `real xterm` suite is Halo's own.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Terminal as XTerm, type IBuffer, type IDisposable, type Terminal } from '@xterm/xterm'
import { CharPredictState, type IPrediction, PredictionStats, TypeAheadAddon } from '@/features/terminal/type-ahead/type-ahead-addon'
import { Emitter } from '@/features/terminal/type-ahead/lifecycle'

const CSI = `\x1b[`

const enum CursorMoveDirection {
  Back = 'D',
  Forwards = 'C',
}

describe('terminal type-ahead', () => {
  describe('PredictionStats', () => {
    let stats: PredictionStats
    let add: Emitter<IPrediction>
    let succeed: Emitter<IPrediction>
    let fail: Emitter<IPrediction>

    beforeEach(() => {
      add = new Emitter<IPrediction>()
      succeed = new Emitter<IPrediction>()
      fail = new Emitter<IPrediction>()

      stats = new PredictionStats({
        onPredictionAdded: add.event,
        onPredictionSucceeded: succeed.event,
        onPredictionFailed: fail.event,
      } as any)
    })

    afterEach(() => {
      stats.dispose()
      vi.useRealTimers()
    })

    it('creates sane data', () => {
      const stubs = createPredictionStubs(5)
      vi.useFakeTimers()
      for (const s of stubs) add.fire(s)

      for (let i = 0; i < stubs.length; i++) {
        vi.advanceTimersByTime(100);
        (i % 2 ? fail : succeed).fire(stubs[i])
      }

      expect(stats.accuracy).toBe(3 / 5)
      expect(stats.sampleSize).toBe(5)
      expect(stats.latency).toEqual({ count: 3, min: 100, max: 500, median: 300 })
    })

    it('sorts latencies numerically', () => {
      const stubs = createPredictionStubs(3)
      vi.useFakeTimers()
      for (const s of stubs) add.fire(s)

      vi.advanceTimersByTime(5)
      succeed.fire(stubs[0])
      vi.advanceTimersByTime(45)
      succeed.fire(stubs[1])
      vi.advanceTimersByTime(150)
      succeed.fire(stubs[2])

      expect(stats.latency).toEqual({ count: 3, min: 5, max: 200, median: 50 })
    })

    it('circular buffer', () => {
      const bufferSize = 24
      const stubs = createPredictionStubs(bufferSize * 2)

      for (const s of stubs.slice(0, bufferSize)) { add.fire(s); succeed.fire(s) }
      expect(stats.accuracy).toBe(1)

      for (const s of stubs.slice(bufferSize, bufferSize * 3 / 2)) { add.fire(s); fail.fire(s) }
      expect(stats.accuracy).toBe(0.5)

      for (const s of stubs.slice(bufferSize * 3 / 2)) { add.fire(s); fail.fire(s) }
      expect(stats.accuracy).toBe(0)
    })
  })

  describe('timeline', () => {
    let addon: TestTypeAheadAddon
    let mocks: MockTerminal[]

    const predictedHelloo = [
      `${CSI}?25l`, // hide cursor
      `${CSI}2;7H`, // move cursor
      'o', // new character
      `${CSI}2;8H`, // place cursor back at end of line
      `${CSI}?25h`, // show cursor
    ].join('')

    const expectProcessed = (input: string, output: string) => {
      expect(JSON.stringify(addon.beforeServerInput(input))).toBe(JSON.stringify(output))
    }

    const mockTerminal = (opts: { lines: string[]; cursorAttrs?: any }) => {
      const t = createMockTerminal(opts)
      mocks.push(t)
      return t
    }

    beforeEach(() => {
      mocks = []
      addon = new TestTypeAheadAddon()
      addon.unlockMakingPredictions()
    })

    afterEach(() => {
      addon.dispose()
      for (const t of mocks) t.dispose()
    })

    it('predicts a single character', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')
      t.expectWritten(`${CSI}2mo${CSI}22m`)
    })

    it('validates character prediction', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')
      expectProcessed('o', predictedHelloo)
      expect(addon.stats?.accuracy).toBe(1)
    })

    it('validates zsh prediction (#112842)', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')
      expectProcessed('o', predictedHelloo)

      t.onData('x')
      expectProcessed('\box', [
        `${CSI}?25l`, // hide cursor
        `${CSI}2;8H`, // move cursor
        '\box', // new data
        `${CSI}2;9H`, // place cursor back at end of line
        `${CSI}?25h`, // show cursor
      ].join(''))
      expect(addon.stats?.accuracy).toBe(1)
    })

    it('does not validate zsh prediction on differing lookbehindn (#112842)', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')
      expectProcessed('o', predictedHelloo)

      t.onData('x')
      expectProcessed('\bqx', [
        `${CSI}?25l`, // hide cursor
        `${CSI}2;8H`, // move cursor cursor
        `${CSI}X`, // delete character
        `${CSI}0m`, // reset style
        '\bqx', // new data
        `${CSI}?25h`, // show cursor
      ].join(''))
      expect(addon.stats?.accuracy).toBe(0.5)
    })

    it('rolls back character prediction', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')

      expectProcessed('q', [
        `${CSI}?25l`, // hide cursor
        `${CSI}2;7H`, // move cursor cursor
        `${CSI}X`, // delete character
        `${CSI}0m`, // reset style
        'q', // new character
        `${CSI}?25h`, // show cursor
      ].join(''))
      expect(addon.stats?.accuracy).toBe(0)
    })

    it('handles left arrow when we hit the boundary', () => {
      const t = mockTerminal({ lines: ['|'] })
      addon.activate(t.terminal)
      addon.unlockNavigating()

      const cursorXBefore = addon.physicalCursor(t.terminal.buffer.active)?.x
      t.onData(`${CSI}${CursorMoveDirection.Back}`)
      t.expectWritten('')

      // Trigger rollback because we don't expect this data
      addon.beforeServerInput('xy')

      // The cursor should not have changed because we've hit the boundary
      // (start of prompt)
      expect(addon.physicalCursor(t.terminal.buffer.active)?.x).toBe(cursorXBefore)
    })

    it('handles right arrow when we hit the boundary', () => {
      const t = mockTerminal({ lines: ['|'] })
      addon.activate(t.terminal)
      addon.unlockNavigating()

      const cursorXBefore = addon.physicalCursor(t.terminal.buffer.active)?.x
      t.onData(`${CSI}${CursorMoveDirection.Forwards}`)
      t.expectWritten('')

      // Trigger rollback because we don't expect this data
      addon.beforeServerInput('xy')

      // The cursor should not have changed because we've hit the boundary
      // (end of prompt)
      expect(addon.physicalCursor(t.terminal.buffer.active)?.x).toBe(cursorXBefore)
    })

    it('internal cursor state is reset when all predictions are undone', () => {
      const t = mockTerminal({ lines: ['|'] })
      addon.activate(t.terminal)
      addon.unlockNavigating()

      const cursorXBefore = addon.physicalCursor(t.terminal.buffer.active)?.x
      t.onData(`${CSI}${CursorMoveDirection.Back}`)
      t.expectWritten('')
      addon.undoAllPredictions()

      // The cursor should not have changed because we've hit the boundary
      // (start of prompt)
      expect(addon.physicalCursor(t.terminal.buffer.active)?.x).toBe(cursorXBefore)
    })

    it('restores cursor graphics mode', () => {
      const t = mockTerminal({
        lines: ['hello|'],
        cursorAttrs: { isAttributeDefault: false, isBold: true, isFgPalette: true, getFgColor: 1 },
      })
      addon.activate(t.terminal)
      t.onData('o')

      expectProcessed('q', [
        `${CSI}?25l`, // hide cursor
        `${CSI}2;7H`, // move cursor cursor
        `${CSI}X`, // delete character
        `${CSI}1;38;5;1m`, // reset style
        'q', // new character
        `${CSI}?25h`, // show cursor
      ].join(''))
      expect(addon.stats?.accuracy).toBe(0)
    })

    it('validates against and applies graphics mode on predicted', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')
      expectProcessed(`${CSI}4mo`, [
        `${CSI}?25l`, // hide cursor
        `${CSI}2;7H`, // move cursor
        `${CSI}4m`, // new PTY's style
        'o', // new character
        `${CSI}2;8H`, // place cursor back at end of line
        `${CSI}?25h`, // show cursor
      ].join(''))
      expect(addon.stats?.accuracy).toBe(1)
    })

    it('ignores cursor hides or shows', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')
      expectProcessed(`${CSI}?25lo${CSI}?25h`, [
        `${CSI}?25l`, // hide cursor from PTY
        `${CSI}?25l`, // hide cursor
        `${CSI}2;7H`, // move cursor
        'o', // new character
        `${CSI}?25h`, // show cursor from PTY
        `${CSI}2;8H`, // place cursor back at end of line
        `${CSI}?25h`, // show cursor
      ].join(''))
      expect(addon.stats?.accuracy).toBe(1)
    })

    it('matches backspace at EOL (bash style)', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('\x7F')
      expectProcessed(`\b${CSI}K`, `\b${CSI}K`)
      expect(addon.stats?.accuracy).toBe(1)
    })

    it('matches backspace at EOL (zsh style)', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('\x7F')
      expectProcessed('\b \b', '\b \b')
      expect(addon.stats?.accuracy).toBe(1)
    })

    it('gradually matches backspace', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('\x7F')
      expectProcessed('\b', '')
      expectProcessed(' \b', '\b \b')
      expect(addon.stats?.accuracy).toBe(1)
    })

    it('restores old character after invalid backspace', () => {
      const t = mockTerminal({ lines: ['hel|lo'] })
      addon.activate(t.terminal)
      addon.unlockNavigating()
      t.onData('\x7F')
      t.expectWritten(`${CSI}2;4H${CSI}X`)
      expectProcessed('x', `${CSI}?25l${CSI}0ml${CSI}2;5H${CSI}0mx${CSI}?25h`)
      expect(addon.stats?.accuracy).toBe(0)
    })

    it('waits for validation before deleting to left of cursor', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)

      // initially should not backspace (until the server confirms it)
      t.onData('\x7F')
      t.expectWritten('')
      expectProcessed('\b \b', '\b \b')
      t.cursor.x--

      // enter input on the column...
      t.onData('o')
      addon.beforeServerInput('o')
      t.cursor.x++
      t.clearWritten()

      // now that the column is 'unlocked', we should be able to predict backspace on it
      t.onData('\x7F')
      t.expectWritten(`${CSI}2;6H${CSI}X`)
    })

    it('waits for first valid prediction on a line', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.lockMakingPredictions()
      addon.activate(t.terminal)

      t.onData('o')
      t.expectWritten('')
      expectProcessed('o', 'o')

      t.onData('o')
      t.expectWritten(`${CSI}2mo${CSI}22m`)
    })

    it('disables on title change', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)

      addon.reevaluateNow()
      expect(addon.isShowing, 'expected to show initially').toBe(true)

      t.onTitleChange.fire('foo - VIM.exe')
      addon.reevaluateNow()
      expect(addon.isShowing, 'expected to hide when vim is open').toBe(false)

      t.onTitleChange.fire('foo - git.exe')
      addon.reevaluateNow()
      expect(addon.isShowing, 'expected to show again after vim closed').toBe(true)
    })

    it('adds line wrap prediction even if behind a boundary', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.lockMakingPredictions()
      addon.activate(t.terminal)

      t.onData('hi'.repeat(50))
      t.expectWritten('')
      expectProcessed('hi', [
        `${CSI}?25l`, // hide cursor
        'hi', // this greeting characters
        ...new Array(36).fill(`${CSI}2mh${CSI}22m${CSI}2mi${CSI}22m`), // rest of the greetings that fit on this line
        `${CSI}2;81H`, // move to end of line
        `${CSI}?25h`,
      ].join(''))
    })

    // Halo: the snapshot path (`terminal:snapshot` → `typeAhead.reset()` →
    // `term.reset()`) — pending predictions are dropped without a rollback,
    // and the next PTY output passes through untouched.
    it('reset() drops pending predictions without writing a rollback', () => {
      const t = mockTerminal({ lines: ['hello|'] })
      addon.activate(t.terminal)
      t.onData('o')
      t.expectWritten(`${CSI}2mo${CSI}22m`)

      addon.reset()
      t.expectWritten('')
      expectProcessed('o', 'o')
    })
  })

  // Halo: against a real (unrendered) xterm, so the private `_core`
  // attribute reads and the rollback sequences are checked on the actual
  // screen buffer.
  describe('real xterm', () => {
    let term: XTerm
    let addon: TypeAheadAddon

    const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve))
    /** What the panel does with a `terminal:output` frame. */
    const output = (data: string) => write(addon.beforeServerInput(data))
    /** A keystroke on this page (xterm fires onData; the addon predicts). */
    const type = async (data: string) => { term.input(data, true); await write('') }
    const line = () => term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)!
    const text = () => line().translateToString(true)

    beforeEach(async () => {
      term = new XTerm({ cols: 40, rows: 5 })
      addon = new TypeAheadAddon()
      term.loadAddon(addon)
      await write('$ ')
      // The first keystroke on a line is only shown once the PTY confirms it.
      await type('l')
      expect(text()).toBe('$ ')
      await output('l')
      expect(text()).toBe('$ l')
    })

    afterEach(() => {
      term.dispose()
    })

    it('draws a prediction dimmed and keeps it when the PTY echoes it', async () => {
      await type('s')
      expect(text()).toBe('$ ls')
      expect(line().getCell(3)!.isDim()).toBeTruthy()

      await output('s')
      expect(text()).toBe('$ ls')
      expect(line().getCell(3)!.isDim()).toBeFalsy()
      expect(term.buffer.active.cursorX).toBe(4)
    })

    it('rolls back without residue when another page typed something else', async () => {
      await type('s')
      expect(text()).toBe('$ ls')

      // Another page's keystroke reaches the PTY first.
      await output('x')
      expect(text()).toBe('$ lx')
      expect(line().getCell(3)!.isDim()).toBeFalsy()
      expect(term.buffer.active.cursorX).toBe(4)

      // Then our own keystroke's echo arrives as plain output.
      await output('s')
      expect(text()).toBe('$ lxs')
      expect(line().getCell(4)!.isDim()).toBeFalsy()
    })

    it('rolls back a prediction the PTY never echoes (password prompt)', async () => {
      await type('s')
      expect(text()).toBe('$ ls')
      await new Promise((resolve) => setTimeout(resolve, 600))
      await write('')
      expect(text()).toBe('$ l')
    })

    it('drops predictions on reset() before a snapshot replaces the screen', async () => {
      await type('s')
      addon.reset()
      term.reset()
      await write('restored')
      expect(text()).toBe('restored')

      // The echo of the dropped keystroke is written as-is, no rollback.
      expect(addon.beforeServerInput('s')).toBe('s')
    })

    it('does not predict on the alternate screen', async () => {
      await write('\x1b[?1049h')
      const writeSpy = vi.spyOn(term, 'write')
      term.input('q', true)
      expect(writeSpy).not.toHaveBeenCalled()
      expect(addon.beforeServerInput('q')).toBe('q')
    })
  })
})

class TestTypeAheadAddon extends TypeAheadAddon {
  unlockMakingPredictions() {
    this._lastRow = { y: 1, startingX: 100, endingX: 100, charState: CharPredictState.Validated }
  }

  lockMakingPredictions() {
    this._lastRow = undefined
  }

  unlockNavigating() {
    this._lastRow = { y: 1, startingX: 1, endingX: 1, charState: CharPredictState.Validated }
  }

  reevaluateNow() {
    this._reevaluatePredictorStateNow(this.stats!, this._timeline!)
  }

  get isShowing() {
    return !!this._timeline?.isShowingPredictions
  }

  undoAllPredictions() {
    this._timeline?.undoAllPredictions()
  }

  physicalCursor(buffer: IBuffer) {
    return this._timeline?.physicalCursor(buffer)
  }

  tentativeCursor(buffer: IBuffer) {
    return this._timeline?.tentativeCursor(buffer)
  }
}

function createPredictionStubs(n: number) {
  return new Array(n).fill(0).map(stubPrediction)
}

function stubPrediction(): IPrediction {
  return {
    apply: () => '',
    rollback: () => '',
    matches: () => 0,
    rollForwards: () => '',
  }
}

type MockTerminal = ReturnType<typeof createMockTerminal>

function createMockTerminal({ lines, cursorAttrs }: {
  lines: string[]
  cursorAttrs?: any
}) {
  const disposables: IDisposable[] = []
  const written: string[] = []
  const cursor = { y: 1, x: 1 }
  const onTitleChange = new Emitter<string>()
  const onData = new Emitter<string>()
  const csiEmitter = new Emitter<number[]>()

  for (let y = 0; y < lines.length; y++) {
    const line = lines[y]
    if (line.includes('|')) {
      cursor.y = y + 1
      cursor.x = line.indexOf('|') + 1
      lines[y] = line.replace('|', '')
      break
    }
  }

  return {
    written,
    cursor,
    expectWritten: (s: string) => {
      expect(JSON.stringify(written.join(''))).toBe(JSON.stringify(s))
      written.splice(0, written.length)
    },
    clearWritten: () => written.splice(0, written.length),
    onData: (s: string) => onData.fire(s),
    csiEmitter,
    onTitleChange,
    dispose: () => {
      for (const d of disposables) d.dispose()
      onTitleChange.dispose()
      onData.dispose()
      csiEmitter.dispose()
    },
    terminal: {
      cols: 80,
      rows: 5,
      onResize: new Emitter<void>().event,
      onData: onData.event,
      onTitleChange: onTitleChange.event,
      parser: {
        registerCsiHandler(_: unknown, callback: (args: number[]) => void) {
          const d = csiEmitter.event(callback)
          disposables.push(d)
          return d
        },
      },
      write(line: string) {
        written.push(line)
      },
      _core: {
        _inputHandler: {
          _curAttrData: mockCell('', cursorAttrs),
        },
        writeSync() {
          // unused
        },
      },
      buffer: {
        active: {
          type: 'normal',
          baseY: 0,
          get cursorY() { return cursor.y },
          get cursorX() { return cursor.x },
          getLine(y: number) {
            const s = lines[y - 1] || ''
            return {
              length: s.length,
              getCell: (x: number) => mockCell(s[x - 1] || ''),
              translateToString: (trim: boolean, start = 0, end = s.length) => {
                const out = s.slice(start, end)
                return trim ? out.trimEnd() : out
              },
            }
          },
        },
      },
    } as unknown as Terminal,
  }
}

function mockCell(char: string, attrs: { [key: string]: unknown } = {}) {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(attrs, prop)) {
        return () => attrs[prop]
      }

      switch (prop) {
        case 'getWidth':
          return () => 1
        case 'getChars':
          return () => char
        case 'getCode':
          return () => char.charCodeAt(0) || 0
        case 'isAttributeDefault':
          return () => true
        default:
          return String(prop).startsWith('is') ? (() => false) : (() => 0)
      }
    },
  })
}

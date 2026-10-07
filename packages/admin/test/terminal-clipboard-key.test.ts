import { describe, it, expect } from 'vitest'
import { terminalClipboardKey } from '../src/features/terminal/terminal-clipboard'

/**
 * Contract: on non-mac clients (Windows / Linux) Ctrl+C copies only when
 * something is selected — otherwise it stays ^C (SIGINT); Ctrl+Shift+C always
 * means copy; Ctrl+V and Ctrl+Shift+V paste. Mac keeps Cmd+C / Cmd+V, so
 * nothing is intercepted there.
 */

const key = (k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; type?: string } = {}) => ({
  type: mods.type ?? 'keydown',
  key: k,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
})

const nonMac = (hasSelection: boolean) => ({ isMac: false, hasSelection })

describe('terminalClipboardKey (non-mac)', () => {
  it('Ctrl+C copies with a selection, stays ^C without one', () => {
    expect(terminalClipboardKey(key('c', { ctrl: true }), nonMac(true))).toBe('copy')
    expect(terminalClipboardKey(key('c', { ctrl: true }), nonMac(false))).toBeNull()
  })

  it('Ctrl+Shift+C always means copy (never sent to the shell)', () => {
    expect(terminalClipboardKey(key('C', { ctrl: true, shift: true }), nonMac(true))).toBe('copy')
    expect(terminalClipboardKey(key('C', { ctrl: true, shift: true }), nonMac(false))).toBe('copy')
  })

  it('Ctrl+V and Ctrl+Shift+V paste', () => {
    expect(terminalClipboardKey(key('v', { ctrl: true }), nonMac(false))).toBe('paste')
    expect(terminalClipboardKey(key('V', { ctrl: true, shift: true }), nonMac(true))).toBe('paste')
  })

  it('leaves everything else alone', () => {
    expect(terminalClipboardKey(key('c'), nonMac(true))).toBeNull()
    expect(terminalClipboardKey(key('v'), nonMac(false))).toBeNull()
    expect(terminalClipboardKey(key('d', { ctrl: true }), nonMac(true))).toBeNull()
    expect(terminalClipboardKey(key('c', { ctrl: true, alt: true }), nonMac(true))).toBeNull()
    expect(terminalClipboardKey(key('v', { ctrl: true, meta: true }), nonMac(false))).toBeNull()
    // keyup / keypress of the same chord: only the keydown decides
    expect(terminalClipboardKey(key('c', { ctrl: true, type: 'keyup' }), nonMac(true))).toBeNull()
    expect(terminalClipboardKey(key('v', { ctrl: true, type: 'keypress' }), nonMac(false))).toBeNull()
  })
})

describe('terminalClipboardKey (mac)', () => {
  it('intercepts nothing — Cmd+C / Cmd+V already work, Ctrl+C stays ^C', () => {
    const mac = { isMac: true, hasSelection: true }
    expect(terminalClipboardKey(key('c', { ctrl: true }), mac)).toBeNull()
    expect(terminalClipboardKey(key('v', { ctrl: true }), mac)).toBeNull()
    expect(terminalClipboardKey(key('c', { meta: true }), mac)).toBeNull()
    expect(terminalClipboardKey(key('C', { ctrl: true, shift: true }), mac)).toBeNull()
  })
})

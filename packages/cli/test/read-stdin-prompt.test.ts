import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { readStdinPrompt, STDIN_HINT, STDIN_GRACE_MS, STDIN_HINT_MS } from '../src/read-stdin-prompt.js'

/**
 * `halo cli`'s non-TTY stdin rule. The regression it guards: an open stdin
 * that never sends data or EOF (ssh without -t, CI) used to hang `halo cli
 * "prompt"` forever, because stdin was read to EOF unconditionally.
 */

afterEach(() => {
  vi.useRealTimers()
})

describe('readStdinPrompt — positional prompt given', () => {
  it('idle stdin → gives up after the grace window with "" and releases the stream', async () => {
    vi.useFakeTimers()
    const stdin = new PassThrough()
    const p = readStdinPrompt(stdin, { hasPositional: true })
    await vi.advanceTimersByTimeAsync(STDIN_GRACE_MS - 1)
    let settled = false
    void p.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBe('')
    expect(stdin.destroyed).toBe(true)
  })

  it('a first chunk inside the window → reads to EOF, no timeout after that', async () => {
    vi.useFakeTimers()
    const stdin = new PassThrough()
    const p = readStdinPrompt(stdin, { hasPositional: true })
    await vi.advanceTimersByTimeAsync(100)
    stdin.write('diff --git a/x\n')
    // Long past the grace window: still reading, not given up.
    await vi.advanceTimersByTimeAsync(10_000)
    stdin.end('more\n')
    await expect(p).resolves.toBe('diff --git a/x\nmore\n')
  })

  it('piped input that ends quickly (echo hi |) → its content', async () => {
    const stdin = new PassThrough()
    const p = readStdinPrompt(stdin, { hasPositional: true })
    stdin.end('hi\n')
    await expect(p).resolves.toBe('hi\n')
  })

  it('never prints the waiting hint', async () => {
    vi.useFakeTimers()
    const writeHint = vi.fn()
    const p = readStdinPrompt(new PassThrough(), { hasPositional: true, writeHint })
    await vi.advanceTimersByTimeAsync(STDIN_HINT_MS * 3)
    await p
    expect(writeHint).not.toHaveBeenCalled()
  })
})

describe('readStdinPrompt — no positional prompt (stdin IS the prompt)', () => {
  it('waits for EOF however long it takes, hinting once after the hint delay', async () => {
    vi.useFakeTimers()
    const stdin = new PassThrough()
    const writeHint = vi.fn()
    const p = readStdinPrompt(stdin, { hasPositional: false, writeHint })
    await vi.advanceTimersByTimeAsync(STDIN_HINT_MS - 1)
    expect(writeHint).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(writeHint).toHaveBeenCalledTimes(1)
    expect(writeHint).toHaveBeenCalledWith(STDIN_HINT)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(writeHint).toHaveBeenCalledTimes(1)
    stdin.end('late prompt')
    await expect(p).resolves.toBe('late prompt')
  })

  it('data before the hint delay → no hint', async () => {
    vi.useFakeTimers()
    const stdin = new PassThrough()
    const writeHint = vi.fn()
    const p = readStdinPrompt(stdin, { hasPositional: false, writeHint })
    stdin.write('a')
    await vi.advanceTimersByTimeAsync(STDIN_HINT_MS * 2)
    stdin.end('b')
    await expect(p).resolves.toBe('ab')
    expect(writeHint).not.toHaveBeenCalled()
  })

  it('empty stdin (EOF, no data) → ""', async () => {
    const stdin = new PassThrough()
    const p = readStdinPrompt(stdin, { hasPositional: false, writeHint: () => {} })
    stdin.end()
    await expect(p).resolves.toBe('')
  })
})

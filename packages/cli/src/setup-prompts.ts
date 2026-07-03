/**
 * Tiny prompt helpers for `halo setup`.
 *
 * No external deps. Implements:
 *   - text input with default value (Enter = keep)
 *   - yes/no
 *   - masked password input
 *   - single-select (↑↓ + Enter)
 *   - multi-select (↑↓ + Space + Enter)
 *
 * Cross-platform notes:
 *   - macOS / Linux / Windows Terminal / PS 7 / WSL: ANSI escape + raw mode
 *     all work as expected.
 *   - Old Windows cmd.exe (pre-2018): ANSI may not render; raw-mode arrow keys
 *     come as scancodes rather than ESC sequences. We fall back to a numbered
 *     menu when stdin isn't a TTY OR when `HALO_PROMPT=plain` is set.
 *   - Non-TTY (piped stdin / CI): always fall back to plain readline + numbered
 *     menu, so scripted setup still works.
 */
import readline from 'node:readline'

function isTty(): boolean {
  return Boolean((process.stdin as NodeJS.ReadStream).isTTY && (process.stdout as NodeJS.WriteStream).isTTY)
}

/** True when we should use rich (raw-mode + ANSI) prompts.
 *  Plain-mode opt-out via HALO_PROMPT=plain for old terminals / CI. */
function useRichPrompts(): boolean {
  if (process.env.HALO_PROMPT === 'plain') return false
  return isTty()
}

// ── Plain prompts ─────────────────────────────────────────────────────────

/** Plain-text prompt (echo on). Returns trimmed input, or null on Ctrl+C / EOF.
 *  When `defaultValue` is provided, an empty input returns the default. */
export function promptText(question: string, defaultValue?: string): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    let settled = false
    const done = (val: string | null) => {
      if (settled) return
      settled = true
      resolve(val)
    }
    const display = defaultValue !== undefined ? `${question} [${defaultValue}]: ` : `${question}: `
    rl.question(display, (answer) => {
      const trimmed = answer.trim()
      done(trimmed.length === 0 && defaultValue !== undefined ? defaultValue : trimmed)
      rl.close()
    })
    rl.on('SIGINT', () => { done(null); rl.close() })
    // EOF (piped stdin ran out of lines, `< /dev/null`, closed terminal):
    // readline emits 'close' without ever firing the question callback. Without
    // this handler the promise stays pending forever and the process silently
    // exits 0 — a fake-green in CI. Resolve null so callers abort non-zero.
    rl.on('close', () => {
      if (!settled) {
        process.stderr.write('\n[setup] stdin closed before an answer was received\n')
        done(null)
      }
    })
  })
}

/** Yes/no prompt — default to `defaultYes` (y/N or Y/n shown accordingly). */
export async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const ans = await promptText(`${question} ${suffix}`)
  if (ans == null) return false
  if (!ans) return defaultYes
  return ans.toLowerCase().startsWith('y')
}

/** Masked password prompt. Echoes `*` per char. Honors backspace + Ctrl+C. */
export function promptPassword(question: string): Promise<string | null> {
  if (!isTty()) {
    // Pipe / non-tty — fall back to plain readline (no echo control available).
    return promptText(question)
  }

  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream
    const stdout = process.stdout as NodeJS.WriteStream

    stdout.write(`${question}: `)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let buffer = ''
    const done = (val: string | null) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
      resolve(val)
    }

    const onData = (chunk: string) => {
      // Iterate code units rather than .charCodeAt() per index so paste-style
      // multi-char chunks still get processed in one go.
      for (const ch of chunk) {
        const code = ch.charCodeAt(0)
        if (code === 13 /* CR */ || code === 10 /* LF */) {
          done(buffer)
          return
        }
        if (code === 3 /* Ctrl+C */) {
          done(null)
          return
        }
        if (code === 4 /* Ctrl+D / EOF */) {
          done(buffer.length > 0 ? buffer : null)
          return
        }
        if (code === 127 /* DEL */ || code === 8 /* BS */) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        if (code < 32) continue // ignore other control chars
        buffer += ch
        stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

// ── Selection prompts ─────────────────────────────────────────────────────

export interface SelectOption {
  /** Stable value returned when this option is picked. */
  value: string
  /** Label shown to the user. */
  label: string
  /** Optional dim suffix, e.g. `[not configured]`. */
  hint?: string
  /** Optional initial-checked for multi-select. */
  checked?: boolean
}

/** Single-select prompt. Returns the chosen value, or null on Ctrl+C.
 *  Rich mode (TTY): ↑↓ + Enter, redraw in place.
 *  Plain mode: print numbered list, ask for input. */
export async function promptSelect(
  question: string,
  options: SelectOption[],
  initialIndex = 0,
): Promise<string | null> {
  if (!useRichPrompts()) return promptSelectPlain(question, options, initialIndex)
  return promptSelectRich(question, options, initialIndex)
}

async function promptSelectPlain(
  question: string,
  options: SelectOption[],
  initialIndex: number,
): Promise<string | null> {
  const stdout = process.stdout as NodeJS.WriteStream
  stdout.write(`${question}\n`)
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!
    const hint = opt.hint ? ` ${opt.hint}` : ''
    stdout.write(`  ${i + 1}) ${opt.label}${hint}\n`)
  }
  while (true) {
    const ans = await promptText(`Choose [1-${options.length}]`, String(initialIndex + 1))
    if (ans == null) return null
    const n = parseInt(ans, 10)
    if (Number.isFinite(n) && n >= 1 && n <= options.length) {
      return options[n - 1]!.value
    }
    stdout.write(`Invalid choice. Enter a number between 1 and ${options.length}.\n`)
  }
}

function promptSelectRich(
  question: string,
  options: SelectOption[],
  initialIndex: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream
    const stdout = process.stdout as NodeJS.WriteStream
    let cursor = Math.max(0, Math.min(initialIndex, options.length - 1))
    let drawn = false

    const draw = () => {
      if (drawn) {
        // Move cursor up by N lines and clear each
        stdout.write(`\x1b[${options.length}A`)
      }
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!
        const prefix = i === cursor ? '\x1b[36m❯ \x1b[0m' : '  '
        const label = i === cursor ? `\x1b[36m${opt.label}\x1b[0m` : opt.label
        const hint = opt.hint ? ` \x1b[2m${opt.hint}\x1b[0m` : ''
        stdout.write(`\x1b[2K${prefix}${label}${hint}\n`)
      }
      drawn = true
    }

    stdout.write(`${question}\n`)
    draw()

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }

    const onData = (chunk: string) => {
      // Multi-byte sequences arrive together (paste, terminal escape sequences).
      // We just look at the first identifying bytes — arrow keys are 3 bytes
      // (\x1b [ A/B), Enter is 1 byte (\r or \n).
      if (chunk === '\x1b[A' || chunk === '\x1bOA') {            // up
        cursor = (cursor - 1 + options.length) % options.length
        draw()
        return
      }
      if (chunk === '\x1b[B' || chunk === '\x1bOB') {            // down
        cursor = (cursor + 1) % options.length
        draw()
        return
      }
      if (chunk === '\r' || chunk === '\n') {
        cleanup()
        resolve(options[cursor]!.value)
        return
      }
      if (chunk === '\x03') {                                     // Ctrl+C
        cleanup()
        resolve(null)
        return
      }
      // ignore everything else
    }
    stdin.on('data', onData)
  })
}

/** Multi-select prompt. Returns the values that ended up checked, or null on Ctrl+C.
 *  Rich mode (TTY): ↑↓ to move, Space to toggle, Enter to confirm.
 *  Plain mode: numbered list, repeat-toggle until user types "done". */
export async function promptMultiSelect(
  question: string,
  options: SelectOption[],
): Promise<string[] | null> {
  if (!useRichPrompts()) return promptMultiSelectPlain(question, options)
  return promptMultiSelectRich(question, options)
}

async function promptMultiSelectPlain(
  question: string,
  options: SelectOption[],
): Promise<string[] | null> {
  const stdout = process.stdout as NodeJS.WriteStream
  const checked = options.map((o) => Boolean(o.checked))

  while (true) {
    stdout.write(`${question}\n`)
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!
      const mark = checked[i] ? '[x]' : '[ ]'
      const hint = opt.hint ? ` ${opt.hint}` : ''
      stdout.write(`  ${i + 1}) ${mark} ${opt.label}${hint}\n`)
    }
    const ans = await promptText('Toggle a number (or `done` / `none`)')
    if (ans == null) return null
    const trimmed = ans.trim().toLowerCase()
    if (trimmed === 'done' || trimmed === '') {
      return options.filter((_, i) => checked[i]).map((o) => o.value)
    }
    if (trimmed === 'none' || trimmed === 'clear') {
      for (let i = 0; i < checked.length; i++) checked[i] = false
      continue
    }
    if (trimmed === 'all') {
      for (let i = 0; i < checked.length; i++) checked[i] = true
      continue
    }
    const n = parseInt(trimmed, 10)
    if (Number.isFinite(n) && n >= 1 && n <= options.length) {
      checked[n - 1] = !checked[n - 1]
      continue
    }
    stdout.write(`Invalid input. Enter 1-${options.length}, "done", "all", or "none".\n`)
  }
}

function promptMultiSelectRich(
  question: string,
  options: SelectOption[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream
    const stdout = process.stdout as NodeJS.WriteStream
    let cursor = 0
    const checked = options.map((o) => Boolean(o.checked))
    let drawn = false

    // Including the hint line at the bottom — accounted for in redraw.
    const totalLines = options.length + 1

    const draw = () => {
      if (drawn) stdout.write(`\x1b[${totalLines}A`)
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!
        const cursorMark = i === cursor ? '\x1b[36m❯\x1b[0m' : ' '
        const checkMark = checked[i] ? '\x1b[32m●\x1b[0m' : '○'
        const label = i === cursor ? `\x1b[36m${opt.label}\x1b[0m` : opt.label
        const hint = opt.hint ? ` \x1b[2m${opt.hint}\x1b[0m` : ''
        stdout.write(`\x1b[2K${cursorMark} ${checkMark} ${label}${hint}\n`)
      }
      stdout.write(`\x1b[2K\x1b[2m  (space to toggle · enter to confirm · ctrl-c to cancel)\x1b[0m\n`)
      drawn = true
    }

    stdout.write(`${question}\n`)
    draw()

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }

    const onData = (chunk: string) => {
      if (chunk === '\x1b[A' || chunk === '\x1bOA') {
        cursor = (cursor - 1 + options.length) % options.length
        draw()
        return
      }
      if (chunk === '\x1b[B' || chunk === '\x1bOB') {
        cursor = (cursor + 1) % options.length
        draw()
        return
      }
      if (chunk === ' ') {
        checked[cursor] = !checked[cursor]
        draw()
        return
      }
      if (chunk === '\r' || chunk === '\n') {
        cleanup()
        resolve(options.filter((_, i) => checked[i]).map((o) => o.value))
        return
      }
      if (chunk === '\x03') {
        cleanup()
        resolve(null)
        return
      }
    }
    stdin.on('data', onData)
  })
}

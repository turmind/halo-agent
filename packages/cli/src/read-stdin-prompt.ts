/**
 * Stdin half of `halo cli`'s prompt, for a stdin that isn't a TTY.
 *
 * A non-TTY stdin isn't proof anything is coming: `ssh host halo cli "x"`
 * without -t, CI runners and some IDE task runners hand the process an open
 * pipe that never gets data or EOF. Reading it to EOF unconditionally hung
 * forever. So:
 *
 *   - positional prompt given → stdin is optional context. Wait at most
 *     `graceMs` for a first chunk; none → stop reading and run with the
 *     positional prompt alone (Gemini CLI does the same). A first chunk means
 *     something really is piped, so read the rest to EOF with no timeout.
 *   - no positional prompt → stdin is the prompt, wait for EOF as before, but
 *     after `hintMs` of silence print one hint so it doesn't look hung.
 */

export const STDIN_GRACE_MS = 500
export const STDIN_HINT_MS = 1000
export const STDIN_HINT = 'halo cli: waiting for the prompt on stdin (end with Ctrl-D, or pass it as an argument)\n'

/** Reads the whole stream; '' when it was given up on or empty. */
export function readStdinPrompt(
  stdin: NodeJS.ReadableStream & { destroy?: () => void },
  opts: { hasPositional: boolean; graceMs?: number; hintMs?: number; writeHint?: (text: string) => void },
): Promise<string> {
  const { hasPositional, graceMs = STDIN_GRACE_MS, hintMs = STDIN_HINT_MS, writeHint = (t) => process.stderr.write(t) } = opts
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    const finish = (): void => {
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.off('end', finish)
      stdin.off('error', onError)
      resolve(Buffer.concat(chunks).toString('utf-8'))
    }
    const onData = (chunk: Buffer | string): void => {
      // First chunk: something is really piped — no more grace / hint timer.
      if (chunks.length === 0) clearTimeout(timer)
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const onError = (err: Error): void => {
      clearTimeout(timer)
      reject(err)
    }

    // Handlers above only run after this line (listeners attach below), so
    // their reads of `timer` never hit the TDZ.
    const timer = hasPositional
      ? setTimeout(() => {
        // Nothing within the grace window: let go of stdin entirely so the
        // open pipe doesn't hold the event loop (and the process) alive.
        stdin.pause()
        stdin.destroy?.()
        finish()
      }, graceMs)
      : setTimeout(() => writeHint(STDIN_HINT), hintMs)

    stdin.on('data', onData)
    stdin.once('end', finish)
    stdin.once('error', onError)
  })
}

import { render } from 'ink'
import type { Harness } from './harness.js'
import { App } from './tui/app.js'

export interface RunTuiOptions {
  /** When true, tool blocks render with args + truncated result. */
  verbose?: boolean
}

export async function runTui(harness: Harness, opts: RunTuiOptions = {}): Promise<void> {
  // patchConsole: false — keep server's initLogger() filtering in place. Ink's
  // patch would otherwise route every console.debug call straight to stderr,
  // bypassing log-level gating and flooding the screen with SessionManager
  // internals. initRuntime already routes console.log to stderr, so ink's
  // stdout (the rendered UI) doesn't collide with log output.
  const instance = render(<App harness={harness} verbose={opts.verbose ?? false} />, {
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await instance.waitUntilExit()
}

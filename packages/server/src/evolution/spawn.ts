/**
 * Real spawner installed at server boot. Detached so the wrapper survives
 * server restart; stdio ignored so the wrapper writes its own log file.
 *
 * Path resolution: the wrapper is built alongside this file under
 * `<server-dist>/evolution/evo-wrapper.js`. We resolve via `import.meta.url`
 * so a packaged install (where the dist sits next to admin/, not inside
 * the dev tree) still finds it.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { EvoSpawner } from './ticker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to the compiled wrapper. */
const WRAPPER_PATH = path.resolve(__dirname, 'evo-wrapper.js')

export const realEvoSpawner: EvoSpawner = (mode, id) => {
  // `node` is whatever node is running this server — same runtime, same
  // version, no surprises with shebang resolution on minimal containers.
  const child = spawn(process.execPath, [WRAPPER_PATH, `--mode=${mode}`, `--id=${id}`], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    // Without this, a detached console process on Windows gets a freshly
    // allocated console window (a black box pops up for every evo/score/apply
    // run). cron doesn't hit this — it spawns the cli inline, not via a
    // detached wrapper. No-op on macOS/Linux.
    windowsHide: true,
  })
  // unref so the server's event loop doesn't keep waiting on this child.
  child.unref()
  console.log(`[evo-spawn] launched ${mode} wrapper pid=${child.pid} id=${id}`)
}

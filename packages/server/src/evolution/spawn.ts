/**
 * Real spawner installed at server boot. Detached so the wrapper survives
 * server restart; stdin/stdout ignored, stderr appended to the run's / apply's
 * own log file (the one the wrapper itself writes and admin reads back), so a
 * wrapper that dies before it opens that log — e.g. `Cannot find module` —
 * still leaves its error there.
 *
 * Path resolution: the wrapper sits next to the module this code lands in —
 * `<server-dist>/evolution/evo-wrapper.js` beside `spawn.js` in a tsc build,
 * `dist/evo-wrapper.js` beside the single-file `dist/index.js` in the npm
 * bundle (build-bundle.mjs emits it as a second entry). We resolve via
 * `import.meta.url` so either layout finds it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { EvoSpawner, WrapperMode } from './ticker.js'
import { cleanChildEnv } from '../child-env.js'
import { evoLogsDir, evoWrapperLogFile, evoApplyLogFile } from '../paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to the compiled wrapper. */
const WRAPPER_PATH = path.resolve(__dirname, 'evo-wrapper.js')

/** Spawn `wrapperPath` detached; exported with the path as a parameter so
 *  tests can point it at a stub. */
export function spawnEvoWrapper(wrapperPath: string, mode: WrapperMode, id: string): ChildProcess {
  fs.mkdirSync(evoLogsDir(), { recursive: true })
  const logPath = mode === 'run' ? evoWrapperLogFile(id) : evoApplyLogFile(id)
  const logFd = fs.openSync(logPath, 'a')
  let child: ChildProcess
  try {
    // `node` is whatever node is running this server — same runtime, same
    // version, no surprises with shebang resolution on minimal containers.
    child = spawn(process.execPath, [wrapperPath, `--mode=${mode}`, `--id=${id}`], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      env: cleanChildEnv(),
      // Without this, a detached console process on Windows gets a freshly
      // allocated console window (a black box pops up for every evo/score/apply
      // run). cron doesn't hit this — it spawns the cli inline, not via a
      // detached wrapper. No-op on macOS/Linux.
      windowsHide: true,
    })
  } finally {
    // The child holds its own dup of the fd; ours is no longer needed.
    fs.closeSync(logFd)
  }
  child.once('exit', (code, signal) => {
    if (code === 0) return
    console.error(`[EvoSpawn] ${mode} wrapper pid=${child.pid} id=${id} exited code=${code} signal=${signal} — see ${logPath}`)
  })
  // unref so the server's event loop doesn't keep waiting on this child.
  child.unref()
  console.log(`[EvoSpawn] launched ${mode} wrapper pid=${child.pid} id=${id}`)
  return child
}

export const realEvoSpawner: EvoSpawner = (mode, id) => {
  spawnEvoWrapper(WRAPPER_PATH, mode, id)
}

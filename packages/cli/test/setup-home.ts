/**
 * Per-test-file setup: os.homedir() reads USERPROFILE on Windows, never HOME —
 * so a test redirecting HOME still hit the real ~/.halo there. Make it follow
 * HOME; syncBuiltinESMExports updates `import { homedir } from 'node:os'`
 * bindings too.
 */
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { afterAll } from 'vitest'

const realHomedir = os.homedir
os.homedir = function homedirFromEnv() { return process.env.HOME || realHomedir() }
syncBuiltinESMExports()

afterAll(() => {
  os.homedir = realHomedir
  syncBuiltinESMExports()
})

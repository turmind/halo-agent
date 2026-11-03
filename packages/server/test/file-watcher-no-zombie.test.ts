import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceWatcher } from '../src/ws/file-watcher.js'

/**
 * Contract: starting a WorkspaceWatcher leaves no zombie child behind.
 * @parcel/watcher's 'default' backend on Linux probes watchman with
 * popen("watchman … get-sockname"); with no watchman installed the empty reply
 * throws before pclose(), so each subscribe left one defunct `sh` (and a pipe
 * fd) under the server process — prod collected ~60 in a day and a half.
 * Pinning the inotify backend skips the probe.
 */
const zombieChildren = (): number => {
  const out = execFileSync('ps', ['--ppid', String(process.pid), '-o', 'stat='], { encoding: 'utf-8' })
  return out.split('\n').filter((s) => s.startsWith('Z')).length
}

describe.runIf(process.platform === 'linux')('WorkspaceWatcher child processes', () => {
  it('start/stop leaves no zombie sh behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-zombie-'))
    try {
      const before = zombieChildren()
      for (let i = 0; i < 3; i++) {
        const w = new WorkspaceWatcher()
        await w.start(dir)
        await w.stop()
      }
      expect(zombieChildren()).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

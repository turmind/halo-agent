import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: the server log's directory is created when an append finds it
 * missing — the first line, or after the dir was removed while running — not
 * before every line (a mkdir round trip per line on an NFS/EFS HOME). No line
 * is lost either way.
 *
 * Mutation check: put ensureDir back in front of every append → the mkdir
 * count goes from 1 to one per line, red.
 *
 * HALO_LOG_LEVEL / HOME are read when the modules load, so both are set
 * before the dynamic import (HOME = the per-file scratch dir, setup-home.ts).
 */

let logAlways: (message: string) => void
let logDir: string
const prevLevel = process.env.HALO_LOG_LEVEL

beforeAll(async () => {
  process.env.HALO_LOG_LEVEL = 'info'
  logDir = path.join(os.homedir(), '.halo', 'global', 'logs')
  ;({ logAlways } = await import('../src/logger.js'))
})
afterAll(() => {
  if (prevLevel === undefined) delete process.env.HALO_LOG_LEVEL
  else process.env.HALO_LOG_LEVEL = prevLevel
})

describe('server.log file sink', () => {
  it('mkdirs once for a run of lines, and again only when the dir went missing', () => {
    fs.rmSync(logDir, { recursive: true, force: true })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const mkdir = vi.spyOn(fs, 'mkdirSync')
    const mkdirs = (): number => mkdir.mock.calls.filter(([d]) => d === logDir).length
    try {
      for (const n of [1, 2, 3]) logAlways(`[Test] line ${n}`)
      expect(mkdirs()).toBe(1)

      fs.rmSync(logDir, { recursive: true })
      logAlways('[Test] after the dir was removed')
      logAlways('[Test] and one more')
      expect(mkdirs()).toBe(2)
    } finally {
      mkdir.mockRestore()
      stderr.mockRestore()
    }
    const lines = fs.readFileSync(path.join(logDir, 'server.log'), 'utf-8').trim().split('\n')
    expect(lines.map((l) => l.replace(/^time=\S+ level=info /, ''))).toEqual(['[Test] after the dir was removed', '[Test] and one more'])
  })
})

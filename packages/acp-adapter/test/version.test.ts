import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { ADAPTER_VERSION } from '../src/version.js'

describe('ADAPTER_VERSION', () => {
  it('matches package.json (reported as agentInfo.version)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }
    expect(ADAPTER_VERSION).toBe(pkg.version)
  })
})

/**
 * Per-test-file setup: point HOME at a scratch dir seeded with the bundled
 * models registry, so tests never read the machine's real ~/.halo (and agent
 * builds resolve each provider's `runtime:` the same way locally and on CI).
 * Files that redirect HOME themselves still do so on top of this.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { seedBundledModels } from './helpers/seed-models.js'

const realHome = process.env.HOME
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-test-home-'))
seedBundledModels(home)
process.env.HOME = home

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(home, { recursive: true, force: true })
})

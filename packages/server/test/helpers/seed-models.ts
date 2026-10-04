/**
 * Seed `<home>/.halo/global/models/` with the bundled provider yamls. Building
 * a session agent resolves the provider's `runtime:` from that registry, so
 * any test that builds one needs it. Not a test file itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLED_MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'models')

export function seedBundledModels(home: string): void {
  fs.cpSync(BUNDLED_MODELS_DIR, path.join(home, '.halo', 'global', 'models'), { recursive: true })
}

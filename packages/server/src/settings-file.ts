/**
 * The global `~/.halo/secrets/settings.yaml`, parsed lazily and cached by
 * mtime. A leaf module so code under tools/sandbox.ts (child-env.ts reads the
 * outbound proxy on every spawn) can share config.ts's cache: config.ts →
 * settings-schema.ts → tools/sandbox.ts → child-env.ts, so child-env importing
 * config.ts would be a load-order cycle.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

/** Load a YAML file synchronously; missing / unparseable → {}. */
export function loadYamlFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return YAML.parse(raw) ?? {}
  } catch {
    return {}
  }
}

/** Lazy + mtime-watched settings cache. UI saves rewrite the file; bumping
 *  the mtime triggers a reparse on the next read so the server picks up new
 *  secrets without a restart. One stat per call; the returned object is the
 *  same until the mtime moves (callers only read it). */
const SETTINGS_PATH = path.join(homedir(), '.halo', 'secrets', 'settings.yaml')
let _settingsCache: { mtimeMs: number; data: Record<string, unknown> } | null = null
export function getSettings(): Record<string, unknown> {
  let mtimeMs = 0
  try { mtimeMs = fs.statSync(SETTINGS_PATH).mtimeMs } catch { /* missing → mtime 0 */ }
  if (!_settingsCache || _settingsCache.mtimeMs !== mtimeMs) {
    _settingsCache = { mtimeMs, data: loadYamlFile(SETTINGS_PATH) }
  }
  return _settingsCache.data
}

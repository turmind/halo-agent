/**
 * Tripwire: halo-hub/scripts/pack.mjs (`manifestError` + its constants) is a
 * hand copy of the manifest rules in src/extensions/registry.ts — separate
 * repo, dependency-free, so it can't import them. This pins a hash of those
 * rules; any change fails here until the hub copy is updated to match and
 * EXPECTED is re-pinned.
 *
 * Hashed: the rule constant lines, plus parseSettings / parseManifest from
 * declaration to closing `}` with full-line `//` comments dropped and
 * whitespace collapsed (comment / formatting edits don't trip it).
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const REGISTRY = path.resolve(import.meta.dirname, '..', 'src', 'extensions', 'registry.ts')
const RULE_CONSTANTS = ['ID_RE', 'VERSION_RE', 'FILE_EXT_RE', 'CAPABILITIES', 'PLATFORMS', 'SETTING_KEY_RE', 'SETTING_TYPES']
const EXPECTED = '81c911ea71c872664c90bced32737584ae59a83c801241e5445f39b81680da07'

function rulesSource(src: string): string {
  const lines = src.split('\n')
  const parts = RULE_CONSTANTS.map((name) => {
    const line = lines.find((l) => l.startsWith(`const ${name}`))
    if (!line) throw new Error(`rule constant ${name} not found in registry.ts`)
    return line
  })
  for (const decl of ['function parseSettings(', 'export function parseManifest(']) {
    const start = lines.findIndex((l) => l.startsWith(decl))
    const end = lines.findIndex((l, i) => i > start && l === '}')
    if (start < 0 || end < 0) throw new Error(`${decl} not found in registry.ts`)
    parts.push(...lines.slice(start, end + 1).filter((l) => !l.trim().startsWith('//')))
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim()
}

describe('extension manifest rules drift', () => {
  it('registry.ts manifest rules match the pinned hash mirrored by halo-hub pack.mjs', () => {
    const actual = createHash('sha256').update(rulesSource(fs.readFileSync(REGISTRY, 'utf-8'))).digest('hex')
    expect(actual, 'manifest rules in registry.ts changed — mirror the change in halo-hub/scripts/pack.mjs (manifestError), then update EXPECTED here').toBe(EXPECTED)
  })
})

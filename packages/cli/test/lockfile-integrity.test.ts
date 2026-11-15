import { describe, it, expect } from 'vitest'
import { findMissingIntegrity } from '../scripts/lockfile-integrity.mjs'

/**
 * Contract for build-bundle.mjs's lockfile integrity gate: every `resolution:`
 * under `packages:` must carry `integrity`. The case it exists for: the
 * pre-release `pnpm update -r --prod --no-save` drops it from tarball-URL deps
 * (admin's `xlsx`), which breaks `pnpm install --frozen-lockfile`.
 */

const lock = (pkgs: string) => `lockfileVersion: '9.0'

importers:

  packages/admin:
    dependencies:
      xlsx:
        specifier: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
        version: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz

packages:

${pkgs}
snapshots:

  ansi-regex@6.1.0: {}
`

const ANSI = `  ansi-regex@6.1.0:
    resolution: {integrity: sha512-aaa==}
    engines: {node: '>=12'}
`
const SCOPED = `  '@alcalzone/ansi-tokenize@0.3.1':
    resolution: {integrity: sha512-bbb==}
`
const XLSX_OK = `  xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz:
    resolution: {integrity: sha512-ccc==, tarball: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz}
    version: 0.20.3
`

describe('findMissingIntegrity', () => {
  it('returns nothing when every resolution has integrity', () => {
    expect(findMissingIntegrity(lock(SCOPED + '\n' + ANSI + '\n' + XLSX_OK))).toEqual({ missing: [], resolutions: 3 })
  })

  it('names the one package whose resolution lacks integrity', () => {
    const scopedBroken = SCOPED.replace('integrity: sha512-bbb==', 'tarball: https://example.com/x.tgz')
    expect(findMissingIntegrity(lock(scopedBroken + '\n' + ANSI)).missing).toEqual(['@alcalzone/ansi-tokenize@0.3.1'])
  })

  it('catches a tarball resolution that lost its integrity', () => {
    const xlsxBroken = XLSX_OK.replace('integrity: sha512-ccc==, ', '')
    expect(findMissingIntegrity(lock(ANSI + '\n' + xlsxBroken)).missing).toEqual(['xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'])
  })
})

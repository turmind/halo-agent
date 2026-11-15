/**
 * Lockfile integrity gate for build-bundle.mjs (see the comment at its call
 * site for why). Split out so the scan is importable from a vitest case —
 * build-bundle.mjs runs top-level and can't be imported.
 */
import fs from 'node:fs'

/**
 * Package keys under `packages:` whose `resolution:` lacks `integrity`.
 * Line scan, no YAML parser: a package key is a two-space-indented line
 * ending in `:` (quotes stripped); the section ends at the next top-level key.
 */
export function findMissingIntegrity(lockText) {
  const missing = []
  let inPackages = false
  let pkg = null
  let resolutions = 0
  for (const line of lockText.split('\n')) {
    if (/^\S/.test(line)) { inPackages = line.startsWith('packages:'); continue }
    if (!inPackages) continue
    const key = /^ {2}(\S.*):$/.exec(line)
    if (key) { pkg = key[1].replace(/^'(.*)'$/, '$1'); continue }
    if (/^\s+resolution:/.test(line)) {
      resolutions++
      if (!line.includes('integrity:')) missing.push(pkg)
    }
  }
  return { missing, resolutions }
}

export function lockfileIntegrityGate(lockPath) {
  const { missing, resolutions } = findMissingIntegrity(fs.readFileSync(lockPath, 'utf-8'))
  if (missing.length > 0) {
    console.error(`[build-bundle] FATAL: ${missing.length} package(s) in ${lockPath} have no resolution integrity — \`pnpm install --frozen-lockfile\` fails with ERR_PNPM_MISSING_TARBALL_INTEGRITY. Restore the line from the previous release's lockfile (\`git show <prev tag>:pnpm-lock.yaml\`):\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`[build-bundle] lockfile integrity gate: ${resolutions} resolutions OK`)
}

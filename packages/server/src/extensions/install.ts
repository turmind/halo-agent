/**
 * Install / uninstall a canvas preview extension from a zip.
 *
 * Both writers of `~/.halo/global/extensions/` (this module behind
 * POST /extensions/install, and ext.sh behind the `extension` skill) follow the
 * same six steps so the root watcher sees exactly one rename per install:
 *
 *   1. unpack into a staging dir OUTSIDE the root's listing (`.tmp-<id>-<rand>`
 *      — dot-prefixed, so the scanner skips it while it fills up)
 *   2. strip one wrapper directory if the zip was `zip -r glb.zip glb/`
 *   3. pre-check with the scanner's own rules (registry.readExtensionDir)
 *   4. move an existing `<id>/` aside to `.old-<id>-<rand>`
 *   5. rename staging → `<id>/`   (atomic, same directory)
 *   6. remove the `.old` dir; on a step-5 failure move it back
 *
 * Same id = upgrade (or downgrade — there is no version comparison, the
 * package you install is the one you get). Zip entries with `..` segments,
 * absolute paths or symlink mode bits are refused up front.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import JSZip from 'jszip'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { extensionsRoot, isExtensionId, MANIFEST_FILE, readExtensionDir } from './registry.js'

export class ExtensionInstallError extends Error {}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000

/** Validate + normalize one zip entry name to a root-relative posix path.
 *  Throws ExtensionInstallError on anything that could land outside `dest`. */
function safeEntryPath(name: string): string {
  const posix = name.replace(/\\/g, '/')
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) throw new ExtensionInstallError(`zip entry has an absolute path: ${name}`)
  const segments = posix.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) throw new ExtensionInstallError(`zip entry escapes the archive root: ${name}`)
  if (segments.some((s) => s.includes('\0'))) throw new ExtensionInstallError(`zip entry name contains NUL: ${name}`)
  return segments.join('/')
}

async function unpackZip(zipBuf: Buffer, dest: string): Promise<void> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(zipBuf)
  } catch (err) {
    throw new ExtensionInstallError(`not a zip file: ${err instanceof Error ? err.message : String(err)}`)
  }
  const files = Object.values(zip.files)
  if (files.length === 0) throw new ExtensionInstallError('zip is empty')
  for (const entry of files) {
    const rel = safeEntryPath(entry.name)
    if (rel === '') continue // the archive root itself
    const perm = entry.unixPermissions
    if (typeof perm === 'number' && (perm & S_IFMT) === S_IFLNK) throw new ExtensionInstallError(`zip entry is a symlink: ${entry.name}`)
    const abs = path.join(dest, rel)
    if (entry.dir) {
      fs.mkdirSync(abs, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, await entry.async('nodebuffer'))
  }
}

/** `zip -r glb.zip glb/` puts everything under one top-level directory. If
 *  that is the only child and the manifest lives inside it, hoist its
 *  contents so the manifest sits at the staging root. */
function stripWrapperDir(dir: string): void {
  if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return
  const children = fs.readdirSync(dir, { withFileTypes: true })
  if (children.length !== 1 || !children[0].isDirectory()) return
  const inner = path.join(dir, children[0].name)
  if (!fs.existsSync(path.join(inner, MANIFEST_FILE))) return
  for (const name of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, name), path.join(dir, name))
  }
  fs.rmdirSync(inner)
}

function rand(): string {
  return randomBytes(3).toString('hex')
}

/**
 * Install (or replace) an extension from zip bytes. `expectId` — when the
 * caller knows which id it asked for (the skill's `install <id>`) — must match
 * the manifest; the admin upload passes nothing and takes the manifest's id.
 * Returns the freshly validated info (installedAt from the final rename).
 */
export async function installExtensionZip(zipBuf: Buffer, expectId?: string): Promise<ExtensionInfo> {
  const root = extensionsRoot()
  fs.mkdirSync(root, { recursive: true })

  // The id is only known after unpacking, so the staging dir starts with a
  // generic dot-name (still skipped by the scanner) and is renamed once.
  const stage = path.join(root, `.tmp-unpack-${rand()}`)
  fs.mkdirSync(stage)
  try {
    await unpackZip(zipBuf, stage)
    stripWrapperDir(stage)

    let manifestId: string
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stage, MANIFEST_FILE), 'utf-8')) as { id?: unknown }
      manifestId = typeof raw.id === 'string' ? raw.id : ''
    } catch (err) {
      throw new ExtensionInstallError(`${MANIFEST_FILE} missing or unreadable at the zip root: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!isExtensionId(manifestId)) throw new ExtensionInstallError(`manifest id "${manifestId}" is not a valid extension id`)
    if (expectId !== undefined && manifestId !== expectId) throw new ExtensionInstallError(`manifest id "${manifestId}" does not match requested "${expectId}"`)

    // Pre-check with the scanner's own rules before touching a working install.
    const verdict = readExtensionDir(stage, manifestId)
    if ('error' in verdict) throw new ExtensionInstallError(`invalid extension: ${verdict.error}`)

    // Swap into place — same-directory renames only.
    const target = path.join(root, manifestId)
    const old = path.join(root, `.old-${manifestId}-${rand()}`)
    const hadOld = fs.existsSync(target)
    if (hadOld) fs.renameSync(target, old)
    try {
      fs.renameSync(stage, target)
    } catch (err) {
      if (hadOld) fs.renameSync(old, target)
      throw err
    }
    if (hadOld) fs.rmSync(old, { recursive: true, force: true })

    const info = readExtensionDir(target)
    if ('error' in info) throw new ExtensionInstallError(`installed but failed re-validation: ${info.error}`) // unreachable in practice
    console.log(`[Extensions] installed ${info.id}@${info.version}${hadOld ? ' (replaced previous)' : ''}`)
    return info
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** Remove `<root>/<id>/`. Returns false when nothing was installed under id. */
export function uninstallExtension(id: string): boolean {
  if (!isExtensionId(id)) throw new ExtensionInstallError(`"${id}" is not a valid extension id`)
  const dir = path.join(extensionsRoot(), id)
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`[Extensions] removed ${id}`)
  return true
}

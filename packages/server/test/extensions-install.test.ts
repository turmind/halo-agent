import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { installExtensionZip, uninstallExtension, ExtensionInstallError } from '../src/extensions/install.js'
import { extensionsRoot, scanExtensions } from '../src/extensions/registry.js'

/**
 * Contract: installing from a zip is atomic from the root watcher's point of
 * view — unpack + validate happen in a dot-prefixed staging dir the scanner
 * ignores, then ONE rename puts `<id>/` in place (replacing a previous install
 * without a window where neither exists). Bad packages never touch a working
 * install and leave no staging dirs behind. Zip entries that could land outside
 * the extension dir (`..`, absolute, symlinks) are refused before anything is
 * written.
 */

const manifest = { id: 'glb', name: 'GLB Viewer', version: '1.0.0', extensions: ['.glb'], entry: 'index.html' }

async function zipOf(files: Record<string, string | { symlink: string }>, opts: { platform?: 'UNIX' | 'DOS' } = {}): Promise<Buffer> {
  const z = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    if (typeof content === 'string') z.file(name, content)
    else z.file(name, content.symlink, { unixPermissions: 0o120777 })
  }
  return z.generateAsync({ type: 'nodebuffer', platform: opts.platform ?? 'UNIX' })
}

const flat = (m: Record<string, unknown> = manifest, extra: Record<string, string> = {}) => ({
  'halo-extension.json': JSON.stringify(m),
  'index.html': '<html>v' + String(m.version) + '</html>',
  ...extra,
})

let home: string
const prevHome = process.env.HOME

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-install-'))
  process.env.HOME = home
})
afterEach(() => {
  process.env.HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
})

const rootEntries = () => fs.readdirSync(extensionsRoot()).sort()

describe('installExtensionZip', () => {
  it('installs a flat zip and returns the validated info', async () => {
    const info = await installExtensionZip(await zipOf(flat()))
    expect(info).toMatchObject({ id: 'glb', version: '1.0.0', entry: 'index.html', priority: 'default', capabilities: [] })
    expect(info.installedAt).toBeGreaterThan(0)
    expect(rootEntries()).toEqual(['glb'])
    expect(fs.readFileSync(path.join(extensionsRoot(), 'glb', 'index.html'), 'utf-8')).toBe('<html>v1.0.0</html>')
    expect(scanExtensions().extensions.map((e) => e.id)).toEqual(['glb'])
  })

  it('strips a single wrapper directory (zip -r glb.zip glb/) and keeps nested files', async () => {
    const wrapped: Record<string, string> = {}
    for (const [k, v] of Object.entries(flat(manifest, { 'decoders/draco/d.wasm': 'wasm' }))) wrapped[`glb/${k}`] = v
    const info = await installExtensionZip(await zipOf(wrapped))
    expect(info.id).toBe('glb')
    expect(fs.existsSync(path.join(extensionsRoot(), 'glb', 'decoders', 'draco', 'd.wasm'))).toBe(true)
    expect(fs.existsSync(path.join(extensionsRoot(), 'glb', 'glb'))).toBe(false)
  })

  it('reinstalling the same id replaces the directory wholesale (upgrade and downgrade)', async () => {
    await installExtensionZip(await zipOf(flat(manifest, { 'old-only.js': 'x' })))
    const v2 = await installExtensionZip(await zipOf(flat({ ...manifest, version: '2.0.0' })))
    expect(v2.version).toBe('2.0.0')
    expect(fs.existsSync(path.join(extensionsRoot(), 'glb', 'old-only.js'))).toBe(false)
    expect(fs.readFileSync(path.join(extensionsRoot(), 'glb', 'index.html'), 'utf-8')).toBe('<html>v2.0.0</html>')
    const v1 = await installExtensionZip(await zipOf(flat({ ...manifest, version: '1.0.0' })))
    expect(v1.version).toBe('1.0.0')
    expect(rootEntries()).toEqual(['glb']) // no .old / .tmp leftovers
  })

  it('expectId must match the manifest id', async () => {
    await expect(installExtensionZip(await zipOf(flat()), 'drawio')).rejects.toThrow(/does not match requested "drawio"/)
    expect(rootEntries()).toEqual([])
    await expect(installExtensionZip(await zipOf(flat()), 'glb')).resolves.toMatchObject({ id: 'glb' })
  })

  it('an invalid package never disturbs the working install and leaves no staging dirs', async () => {
    await installExtensionZip(await zipOf(flat()))
    const before = fs.statSync(path.join(extensionsRoot(), 'glb')).mtimeMs
    await new Promise((r) => setTimeout(r, 5))
    // entry missing
    await expect(installExtensionZip(await zipOf({ 'halo-extension.json': JSON.stringify(manifest) }))).rejects.toThrow(/entry not found/)
    // manifest unparseable
    await expect(installExtensionZip(await zipOf({ 'halo-extension.json': '{oops', 'index.html': '' }))).rejects.toThrow(/missing or unreadable/)
    // no manifest at all
    await expect(installExtensionZip(await zipOf({ 'index.html': '' }))).rejects.toThrow(/missing or unreadable/)
    // bad id
    await expect(installExtensionZip(await zipOf(flat({ ...manifest, id: 'Bad Id' })))).rejects.toThrow(/not a valid extension id/)
    // unknown capability
    await expect(installExtensionZip(await zipOf(flat({ ...manifest, capabilities: ['nope'] })))).rejects.toThrow(/unknown capability/)
    // not a zip
    await expect(installExtensionZip(Buffer.from('definitely not a zip'))).rejects.toThrow(/not a zip file/)
    expect(rootEntries()).toEqual(['glb'])
    expect(fs.statSync(path.join(extensionsRoot(), 'glb')).mtimeMs).toBe(before)
    expect(fs.readFileSync(path.join(extensionsRoot(), 'glb', 'index.html'), 'utf-8')).toBe('<html>v1.0.0</html>')
  })

  it('refuses zip entries that escape the archive root or are symlinks', async () => {
    for (const bad of ['../evil.txt', 'a/../../evil.txt', '/etc/evil', 'C:\\evil.txt', 'sub\\..\\..\\evil']) {
      await expect(installExtensionZip(await zipOf({ ...flat(), [bad]: 'x' }))).rejects.toThrow(ExtensionInstallError)
    }
    await expect(installExtensionZip(await zipOf({ ...flat(), link: { symlink: '/etc/passwd' } }))).rejects.toThrow(/symlink/)
    expect(fs.existsSync(path.join(home, 'evil.txt'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.halo', 'global', 'evil.txt'))).toBe(false)
    expect(rootEntries()).toEqual([])
  })

  it('empty zip is rejected', async () => {
    await expect(installExtensionZip(await new JSZip().generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/empty/)
  })
})

describe('uninstallExtension', () => {
  it('removes the directory, reports false when absent, rejects bad ids', async () => {
    await installExtensionZip(await zipOf(flat()))
    expect(uninstallExtension('glb')).toBe(true)
    expect(rootEntries()).toEqual([])
    expect(uninstallExtension('glb')).toBe(false)
    expect(() => uninstallExtension('../glb')).toThrow(ExtensionInstallError)
    expect(() => uninstallExtension('.tmp-glb-x')).toThrow(ExtensionInstallError)
  })
})

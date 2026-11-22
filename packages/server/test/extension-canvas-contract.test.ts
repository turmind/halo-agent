import { describe, it, expect } from 'vitest'
import type { ExtensionCanvasInitFrame, ExtensionCanvasTab, ExtensionClientFrame, ExtensionHostFrame, ExtensionInfo, ExtensionNoticeRespondFrame, ExtensionNoticeServerFrame, WsClientMessage, WsServerMessage } from '@turmind/halo-core/protocol'
import { parseManifest } from '../src/extensions/registry.js'

const manifest = { id: 'canvas-test', name: 'Canvas test', version: '1.0.0', entry: 'index.html', extensions: [], canvas: {} }
const parse = (patch: Record<string, unknown> = {}, exists = (_: string) => true) => parseManifest({ ...manifest, ...patch }, manifest.id, exists)

describe('file-less Canvas contract', () => {
  it('composes frozen types into public unions without a file path', () => {
    const tab: ExtensionCanvasTab = { kind: 'extension', extensionId: 'canvas-test', viewId: 'view', projectId: '/workspace', sessionId: 'root>child' }
    const init: ExtensionCanvasInitFrame = { haloExt: 1, type: 'init', view: 'canvas', protocol: 1, context: tab, capabilities: [], theme: 'dark', themeVars: {}, platform: 'web', lang: 'en' }
    const host: ExtensionHostFrame = init
    const focus: ExtensionClientFrame = { haloExt: 1, type: 'focus-chat' }
    const reply: ExtensionNoticeRespondFrame = { type: 'extension:notice:respond', extensionId: tab.extensionId, generation: 'g', id: 'n', decision: 'confirm' }
    const client: WsClientMessage = reply
    const snapshot: ExtensionNoticeServerFrame = { type: 'extension:notice:snapshot', projectId: tab.projectId, notices: [] }
    const server: WsServerMessage = snapshot
    const canvas: ExtensionInfo['canvas'] = { title: 'Canvas', title_zh: '画布', icon: 'icon.svg' }
    expect([host, focus, client, server, canvas]).toHaveLength(5)
    expect(host).not.toHaveProperty('file')
  })

  it('accepts an empty declaration, no file claims, and no implicit grants', () => {
    expect(parse()).toMatchObject({ canvas: {}, extensions: [], capabilities: [], bundle: false })
  })

  it('keeps only declared Canvas metadata with activity-compatible title/icon rules', () => {
    expect(parse({ canvas: { title: 'View', title_zh: '视图', icon: 'icons/a.PNG', order: 5 } })).toMatchObject({ canvas: { title: 'View', title_zh: '视图', icon: 'icons/a.PNG' } })
    expect(parse({ canvas: { title: 'a'.repeat(64) } })).not.toHaveProperty('error')
  })

  it.each([null, [], 'canvas', false])('rejects non-object canvas %j', (canvas) => {
    expect(parse({ canvas })).toEqual({ error: 'canvas must be an object' })
  })

  it.each([{ title: '' }, { title: ' ' }, { title: 'x'.repeat(65) }, { title_zh: 7 }])('rejects malformed titles %j', (canvas) => {
    expect(parse({ canvas })).toHaveProperty('error')
  })

  it.each(['/a.svg', '../a.svg', '..\\a.svg', 'a.jpg', ''])('rejects icon %s', (icon) => {
    expect(parse({ canvas: { icon } })).toHaveProperty('error')
  })

  it('requires an existing icon and the extensions key', () => {
    expect(parse({ canvas: { icon: 'missing.svg' } }, (p) => p !== 'missing.svg')).toEqual({ error: 'canvas icon not found: missing.svg' })
    expect(parse({ extensions: undefined })).toHaveProperty('error')
    expect(parse({ canvas: undefined })).toEqual({ error: 'extensions must be a non-empty array' })
  })

  it('leaves activity, chatbar, and file declarations unchanged', () => {
    expect(parse({ canvas: undefined, activity: {} })).toMatchObject({ activity: { order: 100 } })
    expect(parse({ canvas: undefined, chatbar: {} })).toMatchObject({ chatbar: { order: 100, height: 160 } })
    expect(parse({ canvas: undefined, extensions: ['.html'] })).toMatchObject({ extensions: ['.html'] })
  })
})

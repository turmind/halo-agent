import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettingsSchema } from '../src/settings-schema.js'
import { createSettingsRoutes } from '../src/routes/settings.js'

/**
 * Outbound A2A bearer tokens (`a2a.secrets.<remote>`) are declared by
 * ~/.halo/secrets/a2a-remotes.yaml: one secret field per `auth: bearer`
 * remote under a System-group `a2a` section, so a token in use is never
 * listed as an orphan. A token for a remote no longer in the list still is.
 */

const remotesFile = () => path.join(os.homedir(), '.halo', 'secrets', 'a2a-remotes.yaml')

beforeAll(() => {
  fs.mkdirSync(path.dirname(remotesFile()), { recursive: true })
  fs.writeFileSync(remotesFile(), [
    'remotes:',
    '  peer:', '    card: https://peer.example.ts.net/.well-known/agent-card.json',
    '  runtime:', '    card: https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/x/invocations/.well-known/agent-card.json', '    auth: sigv4',
  ].join('\n'))
})

afterAll(() => {
  fs.rmSync(remotesFile(), { force: true })
})

describe('a2a remotes settings section', () => {
  it('declares one secret field per bearer remote; sigv4 remotes get none', () => {
    const a2a = loadSettingsSchema().filter((s) => s.namespaceId === 'a2a')
    expect(a2a).toHaveLength(1)
    expect(a2a[0].source).toBe('general')
    expect(a2a[0].fields.map((f) => [f.kind, f.key, f.secret, f.globalOnly])).toEqual([['secret', 'peer', true, undefined]])
    expect(a2a[0].fields[0].description).toContain('https://peer.example.ts.net/.well-known/agent-card.json')
  })

  it('a2a.secrets.<bearer remote> is not an orphan; a2a.secrets.<unknown remote> is', async () => {
    const app = createSettingsRoutes()
    for (const key of ['a2a.secrets.peer', 'a2a.secrets.gone']) {
      const res = await app.request('/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'global', key, value: 'tok-value-1234' }),
      })
      expect(res.status).toBe(200)
    }
    const body = await (await app.request('/settings/schema')).json() as {
      sections: Array<{ namespaceId: string; fields: Array<{ key: string; hasValue: boolean; value: string | null }> }>
      orphans: Array<{ namespaceId: string; kind: string; key: string }>
    }
    const peer = body.sections.find((s) => s.namespaceId === 'a2a')!.fields.find((f) => f.key === 'peer')!
    expect(peer.hasValue).toBe(true)
    expect(peer.value).not.toContain('value-1234')
    expect(body.orphans.filter((o) => o.namespaceId === 'a2a')).toEqual([{ namespaceId: 'a2a', kind: 'secret', key: 'gone' }])
  })

  it('no bearer remote → no a2a section', () => {
    fs.writeFileSync(remotesFile(), 'remotes:\n  runtime:\n    card: https://bedrock-agentcore.us-east-1.amazonaws.com/x\n    auth: sigv4\n')
    expect(loadSettingsSchema().some((s) => s.namespaceId === 'a2a')).toBe(false)
  })
})

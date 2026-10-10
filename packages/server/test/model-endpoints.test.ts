import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import * as server from '../src/models/model-endpoints.js'
import * as admin from '../../admin/src/features/agents/model-endpoints.js'

/**
 * resolveModelEndpoints — per-model `endpoints:` narrow the provider's
 * `endpointPresets`; no list = provider presets / default unchanged. The
 * server (scaffold / setup) and the admin agent form keep separate copies,
 * so every case runs against both, and the bundled mantle yaml is checked
 * against the region matrix in its header comment.
 */

const E1 = 'https://bedrock-mantle.us-east-1.api.aws/openai/v1'
const E2 = 'https://bedrock-mantle.us-east-2.api.aws/openai/v1'
const W2 = 'https://bedrock-mantle.us-west-2.api.aws/openai/v1'
const provider = { defaultEndpoint: E1, endpointPresets: [E1, E2, W2] }

describe.each([['server', server.resolveModelEndpoints], ['admin', admin.resolveModelEndpoints]])('%s copy', (_name, resolve) => {
  it('no model list → provider presets + provider default', () => {
    expect(resolve(provider, { })).toEqual({ presets: [E1, E2, W2], defaultEndpoint: E1, modelScoped: false })
    expect(resolve(provider, { endpoints: [] })).toEqual({ presets: [E1, E2, W2], defaultEndpoint: E1, modelScoped: false })
    expect(resolve(provider, undefined)).toEqual({ presets: [E1, E2, W2], defaultEndpoint: E1, modelScoped: false })
  })

  it('model list that includes the provider default keeps that default', () => {
    expect(resolve(provider, { endpoints: [E2, E1] })).toEqual({ presets: [E2, E1], defaultEndpoint: E1, modelScoped: true })
  })

  it('model list without the provider default → its first entry', () => {
    expect(resolve(provider, { endpoints: [W2] })).toEqual({ presets: [W2], defaultEndpoint: W2, modelScoped: true })
  })

  it('no provider / non-string junk is tolerated', () => {
    expect(resolve(undefined, { endpoints: [E2] })).toEqual({ presets: [E2], defaultEndpoint: E2, modelScoped: true })
    expect(resolve({ endpointPresets: 'x' }, { endpoints: [42] })).toEqual({ presets: [], defaultEndpoint: '', modelScoped: false })
  })
})

describe('the two copies stay identical', () => {
  // Everything past the header comment (the `urls` helper + resolveModelEndpoints),
  // byte for byte — the shared cases above can miss a branch only one copy grew.
  const code = (file: string) => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', file), 'utf-8')
    return src.slice(src.indexOf('\nconst urls'))
  }

  it('server and admin code match', () => {
    const s = code('server/src/models/model-endpoints.ts')
    expect(s).toContain('export function resolveModelEndpoints(')
    expect(code('admin/src/features/agents/model-endpoints.ts')).toBe(s)
  })
})

describe('aws-bedrock-mantle.yaml', () => {
  const data = YAML.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'templates', 'models', 'aws-bedrock-mantle.yaml'), 'utf-8')) as {
    defaultEndpoint: string; endpointPresets: string[]; models: Array<{ id: string; endpoints?: string[] }>
  }
  const at = (id: string) => server.resolveModelEndpoints(data, data.models.find((m) => m.id === id))

  it('per-model endpoints follow the region matrix', () => {
    expect(at('openai.gpt-6-astra')).toEqual({ presets: [W2], defaultEndpoint: W2, modelScoped: true })
    for (const id of ['openai.gpt-6-sol', 'openai.gpt-6.1-sol', 'openai.gpt-6-luna']) {
      expect(at(id)).toEqual({ presets: [E1], defaultEndpoint: E1, modelScoped: true })
    }
    expect(at('openai.gpt-5.6-sol')).toEqual({ presets: [E1, E2], defaultEndpoint: E1, modelScoped: true })
    for (const id of ['openai.gpt-5.6-terra', 'openai.gpt-5.6-luna']) {
      expect(at(id)).toEqual({ presets: [E1, W2, E2], defaultEndpoint: E1, modelScoped: false })
    }
  })

  it('provider presets: us-east-1, then us-west-2, then the rest', () => {
    expect(data.endpointPresets).toEqual([E1, W2, E2])
  })

  it('every per-model endpoint is one of the provider presets', () => {
    for (const m of data.models) for (const ep of m.endpoints ?? []) expect(data.endpointPresets).toContain(ep)
  })
})

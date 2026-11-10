import { describe, it, expect } from 'vitest'
import { endpointLabel, formatTokens, modelEndpointChips } from '../src/features/settings/model-browse'

/**
 * Contract for Settings → provider → Models: endpoint URLs read as an AWS
 * region chip when the host carries one, else the host; a model's chips follow
 * model-endpoints.ts (own `endpoints:` beat the provider presets) with the
 * default flagged; token counts read as K / M.
 */

describe('endpointLabel', () => {
  it('AWS bedrock-runtime / bedrock-mantle hosts → the region', () => {
    expect(endpointLabel('https://bedrock-runtime.us-east-1.amazonaws.com')).toEqual({ label: 'us-east-1', region: true })
    expect(endpointLabel('https://bedrock-runtime.ap-northeast-1.amazonaws.com/openai/v1')).toEqual({ label: 'ap-northeast-1', region: true })
    expect(endpointLabel('https://bedrock-mantle.us-west-2.api.aws/anthropic')).toEqual({ label: 'us-west-2', region: true })
    expect(endpointLabel('https://bedrock-runtime.cn-north-1.amazonaws.com.cn')).toEqual({ label: 'cn-north-1', region: true })
    expect(endpointLabel('https://bedrock-runtime.us-gov-west-1.amazonaws.com')).toEqual({ label: 'us-gov-west-1', region: true })
  })

  it('anything else → the host (a region-looking label off AWS stays a host); garbage as-is', () => {
    expect(endpointLabel('https://api.deepseek.com')).toEqual({ label: 'api.deepseek.com', region: false })
    expect(endpointLabel('https://ark.cn-beijing.volces.com/api/v3')).toEqual({ label: 'ark.cn-beijing.volces.com', region: false })
    expect(endpointLabel('https://bedrock.us-east-1.example.com')).toEqual({ label: 'bedrock.us-east-1.example.com', region: false })
    expect(endpointLabel('https://s3.amazonaws.com')).toEqual({ label: 's3.amazonaws.com', region: false })
    expect(endpointLabel('not a url')).toEqual({ label: 'not a url', region: false })
  })
})

describe('modelEndpointChips', () => {
  const provider = {
    defaultEndpoint: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
    endpointPresets: ['https://bedrock-mantle.us-east-1.api.aws/openai/v1', 'https://bedrock-mantle.us-west-2.api.aws/openai/v1', 'https://api.openai.com/v1'],
  }
  const brief = (chips: ReturnType<typeof modelEndpointChips>) => chips.map((c) => `${c.label}${c.isDefault ? '*' : ''}`)

  it('no model list → the provider presets, the default flagged', () => {
    expect(brief(modelEndpointChips(provider, {}))).toEqual(['us-east-1*', 'us-west-2', 'api.openai.com'])
  })

  it("the model's own list wins; its first entry is the default when it leaves the provider's out", () => {
    expect(brief(modelEndpointChips(provider, { endpoints: ['https://bedrock-mantle.us-west-2.api.aws/openai/v1'] }))).toEqual(['us-west-2*'])
    expect(brief(modelEndpointChips(provider, { endpoints: ['https://api.openai.com/v1', 'https://bedrock-mantle.us-east-1.api.aws/openai/v1'] }))).toEqual(['api.openai.com', 'us-east-1*'])
  })

  it('no presets → just the provider default; a default missing from the presets is listed first', () => {
    expect(brief(modelEndpointChips({ defaultEndpoint: 'https://api.deepseek.com' }, {}))).toEqual(['api.deepseek.com*'])
    expect(brief(modelEndpointChips({ defaultEndpoint: 'https://a.example.com', endpointPresets: ['https://b.example.com'] }, {}))).toEqual(['a.example.com*', 'b.example.com'])
    expect(modelEndpointChips({}, {})).toEqual([])
  })

  it('two URLs with one label share a chip', () => {
    const chips = modelEndpointChips({
      defaultEndpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      endpointPresets: ['https://bedrock-runtime.us-east-1.amazonaws.com', 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1'],
    }, {})
    expect(chips).toEqual([{ label: 'us-east-1', region: true, isDefault: true, urls: ['https://bedrock-runtime.us-east-1.amazonaws.com', 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1'] }])
  })
})

describe('formatTokens', () => {
  it('decimal and binary sizes read as K / M', () => {
    expect([272000, 1000000, 1050000, 128000, 64000, 200000, 204800, 500].map(formatTokens))
      .toEqual(['272K', '1M', '1.05M', '128K', '64K', '200K', '200K', '500'])
    expect([262144, 1048576, 65536, 131072, 16384, 32768, 229376].map(formatTokens))
      .toEqual(['256K', '1M', '64K', '128K', '16K', '32K', '224K'])
  })
})

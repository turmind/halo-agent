import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api } from '../src/shared/api-client'
import { ProviderModels } from '../src/features/settings/provider-models'
import { SettingsMain } from '../src/features/settings/settings-main'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Contract for Settings → a model provider's page → Models (read-only):
 *  - provider line: runtime, revision, default model (defaultModelId, else the
 *    first model); one card per model, the default one tagged;
 *  - a card: name + id, context "272K (max 1M)", output, capability chips,
 *    endpoint chips — AWS region or host, the default highlighted;
 *  - only provider pages show it (below the credentials), fed by
 *    /agent-configs/models; the section collapses.
 * Rendered without I18n providers: `t()` echoes keys, params dropped — so
 * values are asserted through chip / card text, not localized phrases.
 */

type Registry = Awaited<ReturnType<typeof api.agentConfigs.models>>
const bedrock: Registry['providers'][number] = {
  id: 'aws-bedrock-claude-invoke',
  runtime: 'bedrock-invoke',
  revision: 2026111001,
  displayName: 'AWS Bedrock Claude (Invoke API)',
  defaultEndpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  endpointPresets: ['https://bedrock-runtime.us-east-1.amazonaws.com', 'https://bedrock-runtime.us-west-2.amazonaws.com'],
  defaultModelId: 'global.anthropic.claude-sonnet-4-6',
  models: [
    {
      id: 'global.anthropic.claude-fable-5-2', displayName: 'Claude Fable 5.2', maxOutputTokens: 128000, contextWindow: 272000, maxContextWindow: 1000000, compressAt: 0.9,
      capabilities: {
        image: true, video: false, audio: false,
        promptCaching: { default: '1h', ttlPresets: [{ value: '5m', label: '5min' }, { value: '1h', label: '1hour' }] },
        thinking: { mode: 'adaptive', defaultEnabled: true, default: 'max', effortPresets: [{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }] },
      },
    },
    {
      id: 'global.anthropic.claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', maxOutputTokens: 64000, contextWindow: 272000, maxContextWindow: 1000000,
      endpoints: ['https://bedrock-runtime.us-west-2.amazonaws.com'],
      capabilities: { image: false, thinking: { mode: 'manual', defaultBudgetTokens: 4000 } },
    },
  ],
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const cards = () => [...host.querySelectorAll('div.rounded.border')]
const chipTexts = (el: Element) => [...el.querySelectorAll('span.rounded')].map((s) => s.textContent)

describe('Settings → provider → Models', () => {
  it('lists one card per model with id, sizes, capabilities and endpoint chips; tags the default', async () => {
    await act(async () => root.render(createElement(ProviderModels, { provider: bedrock })))
    expect(host.textContent).toContain('bedrock-invoke')
    expect(host.textContent).toContain('2026111001')
    expect(host.textContent).toContain('Claude Sonnet 4.6')
    const [fable, sonnet] = cards()
    expect(cards()).toHaveLength(2)

    expect(fable!.textContent).toContain('Claude Fable 5.2')
    expect(fable!.textContent).toContain('global.anthropic.claude-fable-5-2')
    expect(fable!.textContent).not.toContain('settings.models.default ')
    expect(chipTexts(fable!)).toEqual(expect.arrayContaining(['settings.models.cap.image', 'us-east-1', 'us-west-2']))
    // Default endpoint chip highlighted, the other not.
    const region = (card: Element, label: string) => [...card.querySelectorAll<HTMLElement>('span.rounded')].find((s) => s.textContent === label)!
    expect(region(fable!, 'us-east-1').className).toContain('text-[var(--primary)]')
    expect(region(fable!, 'us-west-2').className).not.toContain('text-[var(--primary)]')
    expect(region(fable!, 'us-east-1').title).toContain('https://bedrock-runtime.us-east-1.amazonaws.com')
    // Preset lists: the default emphasized (thinking max, cache 1h), the others not.
    const emphasized = [...fable!.querySelectorAll('span.font-semibold')].map((s) => s.textContent)
    expect(emphasized).toEqual(['max', '1h'])
    expect(fable!.textContent).toContain('low / max')
    expect(fable!.textContent).toContain('5m / 1h')

    // Sonnet: default tag; its own endpoints list wins → only us-west-2 (and it is that model's default).
    expect(chipTexts(sonnet!)).toContain('settings.models.default')
    expect(chipTexts(sonnet!)).toContain('settings.models.cap.textOnly')
    expect(chipTexts(sonnet!).filter((c) => /^(us|eu|ap)-/.test(c ?? ''))).toEqual(['us-west-2'])
    expect(region(sonnet!, 'us-west-2').className).toContain('text-[var(--primary)]')
    // Visualized, not a yaml dump.
    expect(host.querySelector('pre')).toBeNull()
    expect(host.textContent).not.toContain('maxOutputTokens')
  })

  it('collapses and expands', async () => {
    await act(async () => root.render(createElement(ProviderModels, { provider: bedrock })))
    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(cards()).toHaveLength(0)
    await act(async () => { toggle.click() })
    expect(cards()).toHaveLength(2)
  })

  it('copies the model id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await act(async () => root.render(createElement(ProviderModels, { provider: bedrock })))
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'global.anthropic.claude-fable-5-2')!
    await act(async () => { btn.click() })
    expect(writeText).toHaveBeenCalledWith('global.anthropic.claude-fable-5-2')
  })

  it('SettingsMain shows it on a provider page, below the secrets, and not on General', async () => {
    const field = { kind: 'secret', type: 'string', value: null, hasValue: false, source: 'unset', inheritedFromGlobal: false, envMissing: [] }
    vi.spyOn(api.settings, 'getSchema').mockResolvedValue({
      scope: 'global',
      sections: [
        { namespaceId: 'general', source: 'general', displayName: 'General', fields: [{ ...field, key: 'language', kind: 'param' }] },
        { namespaceId: 'aws-bedrock-claude-invoke', source: 'provider', displayName: 'AWS Bedrock Claude (Invoke API)', fields: [{ ...field, key: 'access_key_id' }] },
      ],
      orphans: [],
    } as never)
    vi.spyOn(api, 'health').mockResolvedValue({})
    const models = vi.spyOn(api.agentConfigs, 'models').mockResolvedValue({ providers: [bedrock] })
    await act(async () => root.render(createElement(SettingsMain)))
    expect(models).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('settings.models.title')

    const nav = [...host.querySelectorAll('button')].find((b) => b.textContent === 'AWS Bedrock Claude (Invoke API)')!
    await act(async () => { nav.click() })
    const text = host.textContent ?? ''
    expect(text).toContain('settings.models.title')
    expect(text.indexOf('access_key_id')).toBeLessThan(text.indexOf('settings.models.title'))
    expect(cards()).toHaveLength(2)
  })
})

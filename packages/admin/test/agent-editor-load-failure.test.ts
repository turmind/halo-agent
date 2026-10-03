import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api } from '../src/shared/api-client'
import { AgentEditorWithChat } from '../src/features/agents/agent-management-main'

/**
 * Contract: when the agent editor can't load or parse agent.yaml, the form is
 * replaced by an error + Retry and auto-save stays off — it must never PUT
 * `{}` (or a handful of edited keys) over the real file. Rendered without an
 * I18nProvider, so `t()` returns the raw key.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = {
  id: 'coder', name: 'Coder', description: '', model: '', path: '/home/u/.halo/global/agents/coder',
  scope: 'global' as const, priority: 0,
}

let container: HTMLDivElement
let root: Root
let saveYaml: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.spyOn(api.agentConfigs, 'tools').mockResolvedValue({ tools: [] })
  vi.spyOn(api.agentConfigs, 'getMdAll').mockResolvedValue({ files: {} })
  saveYaml = vi.spyOn(api.agentConfigs, 'saveYaml').mockResolvedValue({ agent: { ...AGENT } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount() {
  await act(async () => {
    root.render(createElement(AgentEditorWithChat, { agent: AGENT, allAgents: [], modelsRegistry: null, onSaved: () => {} }))
  })
  // loadFromDisk awaits getYaml → dynamic import('yaml') → getMdAll; let it settle.
  await vi.waitFor(() => expect(container.textContent).not.toContain('agent.loading'))
}

/** Wait past the 500ms auto-save debounce. */
async function pastDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 650)) })
}

function buttonByText(text: string) {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!el) throw new Error(`no button with text ${text}`)
  return el
}

describe('agent editor: yaml load failure never auto-saves', () => {
  it('getYaml rejects → error + retry shown, saveYaml never called', async () => {
    vi.spyOn(api.agentConfigs, 'getYaml').mockRejectedValue(new Error('500'))
    await mount()
    await pastDebounce()
    expect(saveYaml).not.toHaveBeenCalled()
    expect(container.textContent).toContain('agent.loadFailed')
    expect(container.textContent).not.toContain('agent.basic')
    buttonByText('agent.retry')
  })

  it('unparsable yaml → yamlInvalid shown, saveYaml never called', async () => {
    vi.spyOn(api.agentConfigs, 'getYaml').mockResolvedValue({ yaml: 'name: [unclosed\n' })
    await mount()
    await pastDebounce()
    expect(saveYaml).not.toHaveBeenCalled()
    expect(container.textContent).toContain('agent.yamlInvalid')
    expect(container.textContent).not.toContain('agent.basic')
  })

  it('Retry after a failure loads the form without re-saving', async () => {
    const getYaml = vi.spyOn(api.agentConfigs, 'getYaml')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ yaml: 'name: Coder\n' })
    await mount()
    expect(container.textContent).toContain('agent.loadFailed')

    await act(async () => { buttonByText('agent.retry').click() })
    await vi.waitFor(() => expect(container.textContent).toContain('agent.basic'))
    expect(getYaml).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('agent.loadFailed')
    await pastDebounce()
    expect(saveYaml).not.toHaveBeenCalled()
  })
})

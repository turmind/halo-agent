import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api } from '../src/shared/api-client'
import { useProjectStore } from '../src/shared/stores/project-store'
import { WecomSettings } from '../src/features/wecom/wecom-settings'
import { TelegramSettings } from '../src/features/telegram/telegram-settings'
import { WebSettings } from '../src/features/web/web-settings'
import { WechatSettings } from '../src/features/wechat/wechat-settings'
import { SlackSettings } from '../src/features/slack/slack-settings'

/**
 * Contract: the channel settings pages share one list shell
 * (`features/channels/account-list.tsx`) and add-dialog
 * (`account-form.tsx`), while each page keeps its own fields and `api.<channel>`
 * calls. Rendered without an I18nProvider, so `t()` returns the raw key.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/ws/channels'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  useProjectStore.getState().openFolder(PROJECT)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as { haloConfirm?: unknown }).haloConfirm
})

async function mount(component: () => unknown) {
  await act(async () => { root.render(createElement(component as () => null)) })
}

function button(title: string) {
  const el = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
  if (!el) throw new Error(`no button titled ${title}`)
  return el
}

function buttonByText(text: string) {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!el) throw new Error(`no button with text ${text}`)
  return el
}

/** The input / select that follows the given label text. */
function control<T extends HTMLElement>(label: string): T {
  const el = [...container.querySelectorAll('label')].find((l) => l.textContent === label)
  const input = el?.parentElement?.querySelector<T>('input, select')
  if (!input) throw new Error(`no control for ${label}`)
  return input
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const wecomAccount = {
  accountId: 'acc1', botId: 'wecombot_1', workspacePath: '/ws/a', workspaceMissing: false,
  label: 'Ops Bot', enabled: 1, accessLevel: 'workspace' as const, language: 'zh', createdAt: 0, updatedAt: 0,
}

describe('channel settings: wecom (shared list shell + add dialog)', () => {
  it('renders the account row with the channel detail line and access badge', async () => {
    vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({
      accounts: [wecomAccount, { ...wecomAccount, accountId: 'acc2', botId: 'wecombot_2', label: '', workspaceMissing: true, accessLevel: 'readonly' }],
    })
    await mount(WecomSettings)

    const rows = container.querySelectorAll('li')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Ops Bot')
    expect(rows[0].textContent).toContain('Workspace')
    expect(rows[0].textContent).toContain('bot:wecombot_1 → /ws/a')
    expect(rows[0].textContent).not.toContain('wecom.pathMissing')
    // No label → falls back to the bot id; missing path is flagged.
    expect(rows[1].textContent).toContain('wecombot_2')
    expect(rows[1].textContent).toContain('Readonly')
    expect(rows[1].textContent).toContain('wecom.pathMissing')
  })

  it('shows the empty state when there are no accounts', async () => {
    vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [] })
    await mount(WecomSettings)
    expect(container.textContent).toContain('wecom.empty')
    expect(container.querySelector('li')).toBeNull()
  })

  it('delete asks for confirmation; confirmed → deleteAccount + reload, declined → nothing', async () => {
    const list = vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [wecomAccount] })
    const del = vi.spyOn(api.wecom, 'deleteAccount').mockResolvedValue({ ok: true })
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    ;(window as { haloConfirm?: unknown }).haloConfirm = confirm
    await mount(WecomSettings)
    expect(list).toHaveBeenCalledTimes(1)

    await act(async () => button('wecom.delete').click())
    expect(confirm).toHaveBeenCalledWith('wecom.confirmDelete')
    expect(del).not.toHaveBeenCalled()

    await act(async () => button('wecom.delete').click())
    expect(del).toHaveBeenCalledWith('acc1')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('toggle flips enabled through updateAccount', async () => {
    vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [wecomAccount] })
    const update = vi.spyOn(api.wecom, 'updateAccount').mockResolvedValue({ ok: true })
    await mount(WecomSettings)
    await act(async () => button('wecom.disable').click())
    expect(update).toHaveBeenCalledWith('acc1', { enabled: false })
  })

  it('add dialog: submit is gated on credentials, then calls createAccount with them + shared fields', async () => {
    const list = vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [] })
    const create = vi.spyOn(api.wecom, 'createAccount').mockResolvedValue({ accountId: 'new', botId: 'b' })
    await mount(WecomSettings)

    act(() => buttonByText('wecom.add').click())
    expect(container.textContent).toContain('wecom.addTitle')
    // Workspace defaults to the active project.
    expect(control<HTMLInputElement>('wecom.bindWorkspace').value).toBe(PROJECT)
    // Chat channels offer three levels — no observer.
    expect([...control<HTMLSelectElement>('wecom.accessLevel').options].map((o) => o.value)).toEqual(['readonly', 'workspace', 'full'])

    const submit = buttonByText('wecom.addBtn')
    expect(submit.disabled).toBe(true)
    type(control('wecom.botIdLabel'), 'wecombot_new')
    expect(submit.disabled).toBe(true)
    type(control('wecom.secretLabel'), 's3cret')
    expect(submit.disabled).toBe(false)

    await act(async () => submit.click())
    expect(create).toHaveBeenCalledWith({
      botId: 'wecombot_new', secret: 's3cret',
      workspacePath: PROJECT, label: undefined, accessLevel: 'readonly', language: 'en',
    })
    // Dialog closed, list reloaded.
    expect(container.textContent).not.toContain('wecom.addTitle')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('add dialog shows the create error inline and stays open', async () => {
    vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [] })
    vi.spyOn(api.wecom, 'createAccount').mockRejectedValue(new Error('bad secret'))
    await mount(WecomSettings)
    act(() => buttonByText('wecom.add').click())
    type(control('wecom.botIdLabel'), 'b')
    type(control('wecom.secretLabel'), 's')
    await act(async () => buttonByText('wecom.addBtn').click())
    expect(container.textContent).toContain('bad secret')
    expect(container.textContent).toContain('wecom.addTitle')
  })
})

describe('channel settings: per-channel extras', () => {
  it('telegram edit form carries allowedUsers into updateAccount', async () => {
    vi.spyOn(api.telegram, 'listAccounts').mockResolvedValue({
      accounts: [{
        accountId: 't1', botUsername: 'halo_bot', workspacePath: '/ws/t', workspaceMissing: false, label: '',
        enabled: 1, accessLevel: 'readonly', allowedUsers: '42', language: 'en', createdAt: 0, updatedAt: 0,
      }],
    })
    const update = vi.spyOn(api.telegram, 'updateAccount').mockResolvedValue({ ok: true })
    await mount(TelegramSettings)
    expect(container.textContent).toContain('@halo_bot')
    expect(container.textContent).toContain('tg.whitelist')

    act(() => button('tg.edit').click())
    expect(control<HTMLInputElement>('tg.allowedUsers').value).toBe('42')
    type(control('tg.allowedUsers'), '42,@ann')
    type(control('tg.label'), 'Main')
    await act(async () => buttonByText('tg.save').click())
    expect(update).toHaveBeenCalledWith('t1', {
      label: 'Main', workspacePath: '/ws/t', accessLevel: 'readonly', language: 'en', allowedUsers: '42,@ann',
    })
  })

  it('web offers observer and shows the minted token after create', async () => {
    vi.spyOn(api.web, 'listAccounts').mockResolvedValue({ accounts: [] })
    const create = vi.spyOn(api.web, 'createAccount').mockResolvedValue({ accountId: 'w1', token: 'tok_abcdef', workspacePath: PROJECT })
    await mount(WebSettings)

    act(() => buttonByText('web.add').click())
    expect([...control<HTMLSelectElement>('web.accessLevel').options].map((o) => o.value)).toEqual(['readonly', 'observer', 'workspace', 'full'])
    await act(async () => buttonByText('web.addBtn').click())
    expect(create).toHaveBeenCalledWith({ workspacePath: PROJECT, label: undefined, accessLevel: 'readonly', language: 'en' })
    expect(container.textContent).toContain('web.createSuccess')
    expect(container.textContent).toContain('tok_abcdef')
  })
})

describe('channel settings: observer on a chat channel', () => {
  const observerAccount = { ...wecomAccount, accessLevel: 'observer' as const }

  it('badges an observer account as Observer, not Full', async () => {
    vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [observerAccount] })
    await mount(WecomSettings)
    const badge = [...container.querySelectorAll('li span')].find((el) => el.textContent === 'Observer')
    expect(badge).toBeDefined()
    expect(badge!.className).toContain('bg-teal-500/15')
    expect(container.querySelector('li')!.textContent).not.toContain('Full')
  })

  it('edit form shows observer as a disabled entry and leaves it out of the patch unless changed', async () => {
    vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [observerAccount] })
    const update = vi.spyOn(api.wecom, 'updateAccount').mockResolvedValue({ ok: true })
    await mount(WecomSettings)

    act(() => button('wecom.edit').click())
    const select = control<HTMLSelectElement>('wecom.accessLevel')
    expect(select.value).toBe('observer')
    const observer = [...select.options].find((o) => o.value === 'observer')!
    expect(observer.disabled).toBe(true)

    // Untouched observer → patch without accessLevel (the row keeps it).
    await act(async () => buttonByText('wecom.save').click())
    expect(update).toHaveBeenLastCalledWith('acc1', { label: 'Ops Bot', workspacePath: '/ws/a', language: 'zh' })

    // Picking a real level sends it.
    act(() => button('wecom.edit').click())
    act(() => {
      const sel = control<HTMLSelectElement>('wecom.accessLevel')
      sel.value = 'workspace'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => buttonByText('wecom.save').click())
    expect(update).toHaveBeenLastCalledWith('acc1', { label: 'Ops Bot', workspacePath: '/ws/a', accessLevel: 'workspace', language: 'zh' })
  })

  it('a non-observer chat account gets no observer option', async () => {
    vi.spyOn(api.wecom, 'listAccounts').mockResolvedValue({ accounts: [wecomAccount] })
    await mount(WecomSettings)
    act(() => button('wecom.edit').click())
    expect([...control<HTMLSelectElement>('wecom.accessLevel').options].map((o) => o.value)).toEqual(['readonly', 'workspace', 'full'])
  })
})

describe('channel settings: wechat + token inputs', () => {
  const wx = {
    accountId: 'w1', baseUrl: 'u', userId: 'x', workspacePath: '/ws/gone', label: 'WX',
    enabled: true, accessLevel: 'readonly' as const, language: 'en' as const, createdAt: 0, updatedAt: 0,
  }

  it('wechat flags a missing workspace path', async () => {
    vi.spyOn(api.wechat, 'listAccounts').mockResolvedValue({
      accounts: [{ ...wx, workspaceMissing: true }, { ...wx, accountId: 'w2', workspacePath: '/ws/ok', workspaceMissing: false }],
    } as never)
    await mount(WechatSettings)
    const rows = container.querySelectorAll('li')
    expect(rows[0].textContent).toContain('/ws/gone')
    expect(rows[0].querySelector('span.text-red-400')?.textContent).toBe('wx.pathMissing')
    expect(rows[1].textContent).not.toContain('wx.pathMissing')
  })

  it('slack and telegram token inputs are password fields', async () => {
    vi.spyOn(api.slack, 'listAccounts').mockResolvedValue({ accounts: [] })
    await mount(SlackSettings)
    act(() => buttonByText('slack.add').click())
    expect(control<HTMLInputElement>('slack.botTokenLabel').type).toBe('password')
    expect(control<HTMLInputElement>('slack.appTokenLabel').type).toBe('password')

    vi.spyOn(api.telegram, 'listAccounts').mockResolvedValue({ accounts: [] })
    await mount(TelegramSettings)
    act(() => buttonByText('tg.add').click())
    expect(control<HTMLInputElement>('tg.tokenLabel').type).toBe('password')
  })
})

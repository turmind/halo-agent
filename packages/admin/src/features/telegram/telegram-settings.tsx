'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Power, PowerOff, Edit3, Check, X, Loader2 } from 'lucide-react'
import { api } from '@/shared/api-client'
import { cn, isAbsolutePath, confirmAction } from '@/shared/utils'
import { useProjectStore } from '@/shared/stores/project-store'
import { useT, useI18n, LanguageSelect } from '@/shared/i18n'
import { useChannelBus } from '@/shared/channel-bus'

interface TelegramAccount {
  accountId: string
  botUsername: string
  workspacePath: string
  workspaceMissing: boolean
  label: string
  enabled: number
  accessLevel: 'full' | 'workspace' | 'readonly'
  allowedUsers: string
  language: string
  createdAt: number
  updatedAt: number
}

export function TelegramSettings() {
  const t = useT()
  const [accounts, setAccounts] = useState<TelegramAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api.telegram.listAccounts().then((r) => setAccounts(r.accounts)).catch((err) => {
      console.error('[telegram] list failed:', err)
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => { reload() }, [reload])

  // Sidebar's refresh button bumps the channel bus → re-run reload.
  const channelBusVersion = useChannelBus((s) => s.version)
  useEffect(() => { if (channelBusVersion > 0) reload() }, [channelBusVersion, reload])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--foreground)]">{t('tg.title')}</h2>
          <p className="text-[11px] text-[var(--muted-foreground)]">{t('tg.desc')}</p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('tg.add')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            {t('tg.loading')}
          </div>
        ) : accounts.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--muted-foreground)]">
            {t('tg.empty')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {accounts.map((a) => (
              <AccountRow
                key={a.accountId}
                account={a}
                editing={editingId === a.accountId}
                onEdit={() => setEditingId(a.accountId)}
                onCancelEdit={() => setEditingId(null)}
                onSaved={() => { setEditingId(null); reload() }}
                onDeleted={reload}
                onToggled={reload}
              />
            ))}
          </ul>
        )}
      </div>

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); reload() }}
        />
      )}
    </div>
  )
}

function AccountRow(props: {
  account: TelegramAccount
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSaved: () => void
  onDeleted: () => void
  onToggled: () => void
}) {
  const t = useT()
  const { account, editing, onEdit, onCancelEdit, onSaved, onDeleted, onToggled } = props
  const [label, setLabel] = useState(account.label)
  const [workspacePath, setWorkspacePath] = useState(account.workspacePath)
  const [accessLevel, setAccessLevel] = useState<'full' | 'workspace' | 'readonly'>(account.accessLevel)
  const [allowedUsers, setAllowedUsers] = useState(account.allowedUsers)
  const [language, setLanguage] = useState<'en' | 'zh'>((account.language as 'en' | 'zh') || 'en')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (editing) {
      setLabel(account.label)
      setWorkspacePath(account.workspacePath)
      setAccessLevel(account.accessLevel)
      setAllowedUsers(account.allowedUsers)
      setLanguage((account.language as 'en' | 'zh') || 'en')
    }
  }, [editing, account])

  async function save() {
    setBusy(true)
    try {
      await api.telegram.updateAccount(account.accountId, { label, workspacePath, accessLevel, allowedUsers, language })
      onSaved()
    } catch (err) {
      alert(t('tg.saveFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setBusy(false) }
  }

  async function toggle() {
    setBusy(true)
    try {
      await api.telegram.updateAccount(account.accountId, { enabled: !account.enabled })
      onToggled()
    } catch (err) {
      alert(t('tg.switchFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!(await confirmAction(t('tg.confirmDelete', { name: account.botUsername })))) return
    setBusy(true)
    try {
      await api.telegram.deleteAccount(account.accountId)
      onDeleted()
    } catch (err) {
      alert(t('tg.deleteFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setBusy(false) }
  }

  if (editing) {
    return (
      <li className="px-4 py-3">
        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-[var(--muted-foreground)]">{t('tg.label')}</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs"
              placeholder={t('tg.labelPlaceholder')}
            />
          </div>
          <div>
            <label className="text-[10px] text-[var(--muted-foreground)]">{t('tg.workspace')}</label>
            <input
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 font-mono text-xs"
              placeholder="/home/user/project"
            />
          </div>
          <div>
            <label className="text-[10px] text-[var(--muted-foreground)]">{t('tg.accessLevel')}</label>
            <select
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as 'full' | 'workspace' | 'readonly')}
              className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs"
            >
              <option value="readonly">{t('tg.readonly')}</option>
              <option value="workspace">{t('tg.wsWrite')}</option>
              <option value="full">{t('tg.full')}</option>
            </select>
          </div>
          <LanguageSelect value={language} onChange={setLanguage} />
          <div>
            <label className="text-[10px] text-[var(--muted-foreground)]">{t('tg.allowedUsers')}</label>
            <input
              value={allowedUsers}
              onChange={(e) => setAllowedUsers(e.target.value)}
              className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 font-mono text-xs"
              placeholder="123456789,@username"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || !isAbsolutePath(workspacePath)}
              className="flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
            >
              <Check className="h-3 w-3" /> {t('tg.save')}
            </button>
            <button
              onClick={onCancelEdit}
              disabled={busy}
              className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px]"
            >
              <X className="h-3 w-3" /> {t('tg.cancel')}
            </button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className={cn('h-2 w-2 rounded-full', account.enabled ? 'bg-emerald-500' : 'bg-zinc-500')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--foreground)]">{account.label || `@${account.botUsername}`}</span>
          <span className={cn(
            'rounded px-1.5 py-0.5 text-[9px] font-medium',
            account.accessLevel === 'readonly' ? 'bg-emerald-500/15 text-emerald-300'
              : account.accessLevel === 'workspace' ? 'bg-blue-500/15 text-blue-300'
              : 'bg-amber-500/15 text-amber-300',
          )}>
            {account.accessLevel === 'readonly' ? 'Readonly' : account.accessLevel === 'workspace' ? 'Workspace' : 'Full'}
          </span>
          {account.allowedUsers && (
            <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-300">
              {t('tg.whitelist')}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted-foreground)]">
          @{account.botUsername} → {account.workspacePath}
          {account.workspaceMissing && <span className="ml-1 text-red-400">{t('tg.pathMissing')}</span>}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={toggle}
          disabled={busy}
          title={account.enabled ? t('tg.disable') : t('tg.enable')}
          className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {account.enabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={onEdit}
          disabled={busy}
          title={t('tg.edit')}
          className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <Edit3 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={remove}
          disabled={busy}
          title={t('tg.delete')}
          className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-red-500/20 hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  )
}

function AddDialog(props: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const { lang } = useI18n()
  const { onClose, onDone } = props
  const activeProject = useProjectStore((s) => s.activeProject)
  const [botToken, setBotToken] = useState('')
  const [workspacePath, setWorkspacePath] = useState(activeProject?.path || '')
  const [label, setLabel] = useState('')
  const [accessLevel, setAccessLevel] = useState<'full' | 'workspace' | 'readonly'>('readonly')
  const [allowedUsers, setAllowedUsers] = useState('')
  const [language, setLanguage] = useState(lang)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    setBusy(true)
    try {
      await api.telegram.createAccount({ botToken, workspacePath, label: label || undefined, accessLevel, allowedUsers: allowedUsers || undefined, language })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[420px] rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--foreground)]">{t('tg.addTitle')}</h3>
          <button onClick={onClose} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-[var(--muted-foreground)]">{t('tg.tokenLabel')}</label>
            <input
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 font-mono text-xs"
              placeholder="123456:ABC-DEF..."
            />
          </div>
          <div>
            <label className="text-[11px] text-[var(--muted-foreground)]">{t('tg.bindWorkspace')}</label>
            <input
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 font-mono text-xs"
              placeholder="/home/user/project"
            />
          </div>
          <div>
            <label className="text-[11px] text-[var(--muted-foreground)]">{t('tg.nameOptional')}</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-xs"
              placeholder={t('tg.namePlaceholder')}
            />
          </div>
          <div>
            <label className="text-[11px] text-[var(--muted-foreground)]">{t('tg.accessLevel')}</label>
            <select
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as 'full' | 'workspace' | 'readonly')}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-xs"
            >
              <option value="readonly">{t('tg.readonly')}</option>
              <option value="workspace">{t('tg.wsWrite')}</option>
              <option value="full">{t('tg.full')}</option>
            </select>
          </div>
          <LanguageSelect value={language} onChange={setLanguage} />
          <div>
            <label className="text-[11px] text-[var(--muted-foreground)]">{t('tg.allowedUsersOptional')}</label>
            <input
              value={allowedUsers}
              onChange={(e) => setAllowedUsers(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 font-mono text-xs"
              placeholder={t('tg.allowedUsersHint')}
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs"
            >
              {t('tg.cancel')}
            </button>
            <button
              onClick={submit}
              disabled={busy || !botToken.trim() || !isAbsolutePath(workspacePath)}
              className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {t('tg.addBtn')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

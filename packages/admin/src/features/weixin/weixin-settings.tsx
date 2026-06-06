'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Plus, Trash2, Power, PowerOff, Edit3, Check, X, Loader2, QrCode } from 'lucide-react'
import { api } from '@/shared/api-client'
import { cn, isAbsolutePath, confirmAction } from '@/shared/utils'
import { useProjectStore } from '@/shared/stores/project-store'
import { useT, useI18n, LanguageSelect } from '@/shared/i18n'
import { useChannelBus } from '@/shared/channel-bus'

interface WeixinAccount {
  accountId: string
  baseUrl: string
  userId: string
  workspacePath: string
  label: string
  enabled: boolean
  accessLevel: 'full' | 'workspace' | 'readonly'
  language: 'en' | 'zh'
  createdAt: number
  updatedAt: number
}

interface LoginIntent {
  workspacePath: string
  label: string
  accessLevel: 'full' | 'workspace' | 'readonly'
  language: 'en' | 'zh'
  /** When true, skip the config step and jump straight to QR scanning. */
  skipConfig: boolean
}

export function WeixinSettings() {
  const t = useT()
  const { lang } = useI18n()
  const [accounts, setAccounts] = useState<WeixinAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [loginIntent, setLoginIntent] = useState<LoginIntent | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api.weixin.listAccounts().then((r) => setAccounts(r.accounts)).catch((err) => {
      console.error('[weixin] list failed:', err)
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
          <h2 className="text-sm font-medium text-[var(--foreground)]">{t('wx.title')}</h2>
          <p className="text-[11px] text-[var(--muted-foreground)]">{t('wx.desc')}</p>
        </div>
        <button
          onClick={() => setLoginIntent({ workspacePath: '', label: '', accessLevel: 'readonly', language: lang, skipConfig: false })}
          className="flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('wx.add')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            {t('wx.loading')}
          </div>
        ) : accounts.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--muted-foreground)]">
            {t('wx.empty')}
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
                onRescan={() => setLoginIntent({
                  workspacePath: a.workspacePath,
                  label: a.label,
                  accessLevel: a.accessLevel,
                  language: a.language,
                  skipConfig: true,
                })}
              />
            ))}
          </ul>
        )}
      </div>

      {loginIntent && (
        <LoginDialog
          intent={loginIntent}
          onClose={() => setLoginIntent(null)}
          onDone={() => { setLoginIntent(null); reload() }}
        />
      )}
    </div>
  )
}

function AccountRow(props: {
  account: WeixinAccount
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSaved: () => void
  onDeleted: () => void
  onToggled: () => void
  onRescan: () => void
}) {
  const t = useT()
  const { account, editing, onEdit, onCancelEdit, onSaved, onDeleted, onToggled, onRescan } = props
  const [label, setLabel] = useState(account.label)
  const [workspacePath, setWorkspacePath] = useState(account.workspacePath)
  const [accessLevel, setAccessLevel] = useState<'full' | 'workspace' | 'readonly'>(account.accessLevel)
  const [language, setLanguage] = useState<'en' | 'zh'>(account.language)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (editing) {
      setLabel(account.label)
      setWorkspacePath(account.workspacePath)
      setAccessLevel(account.accessLevel)
      setLanguage(account.language)
    }
  }, [editing, account])

  async function save() {
    setBusy(true)
    try {
      await api.weixin.updateAccount(account.accountId, { label, workspacePath, accessLevel, language })
      onSaved()
    } catch (err) {
      alert(t('wx.saveFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setBusy(false) }
  }

  async function toggle() {
    setBusy(true)
    try {
      await api.weixin.updateAccount(account.accountId, { enabled: !account.enabled })
      onToggled()
    } catch (err) {
      alert(t('wx.switchFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!(await confirmAction(t('wx.confirmDelete', { name: account.label })))) return
    setBusy(true)
    try {
      await api.weixin.deleteAccount(account.accountId)
      onDeleted()
    } catch (err) {
      alert(t('wx.deleteFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setBusy(false) }
  }

  if (editing) {
    return (
      <li className="px-4 py-3">
        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-[var(--muted-foreground)]">{t('wx.label')}</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs"
              placeholder={t('wx.labelPlaceholder')}
            />
          </div>
          <div>
            <label className="text-[10px] text-[var(--muted-foreground)]">{t('wx.workspace')}</label>
            <input
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 font-mono text-xs"
              placeholder="/home/user/project"
            />
          </div>
          <div>
            <label className="text-[10px] text-[var(--muted-foreground)]">{t('wx.accessLevel')}</label>
            <select
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as 'full' | 'workspace' | 'readonly')}
              className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs"
            >
              <option value="readonly">{t('wx.readonly')}</option>
              <option value="workspace">{t('wx.wsWrite')}</option>
              <option value="full">{t('wx.full')}</option>
            </select>
            <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
              {t('wx.readonlyHint')}
            </p>
          </div>
          <LanguageSelect value={language} onChange={setLanguage} />
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || !isAbsolutePath(workspacePath)}
              className="flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
            >
              <Check className="h-3 w-3" /> {t('wx.save')}
            </button>
            <button
              onClick={onCancelEdit}
              disabled={busy}
              className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px]"
            >
              <X className="h-3 w-3" /> {t('wx.cancel')}
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
          <span className="text-xs font-medium text-[var(--foreground)]">{account.label || account.accountId}</span>
          <span className={cn(
            'rounded px-1.5 py-0.5 text-[9px] font-medium',
            account.accessLevel === 'readonly' ? 'bg-emerald-500/15 text-emerald-300'
              : account.accessLevel === 'workspace' ? 'bg-blue-500/15 text-blue-300'
              : 'bg-amber-500/15 text-amber-300',
          )}>
            {account.accessLevel === 'readonly' ? 'Readonly' : account.accessLevel === 'workspace' ? 'Workspace' : 'Full'}
          </span>
          <span className="font-mono text-[10px] text-[var(--muted-foreground)]">{account.accountId}</span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted-foreground)]">{account.workspacePath}</p>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={toggle}
          disabled={busy}
          title={account.enabled ? t('wx.disable') : t('wx.enable')}
          className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {account.enabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={onRescan}
          disabled={busy}
          title={t('wx.rescan')}
          className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <QrCode className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onEdit}
          disabled={busy}
          title={t('wx.edit')}
          className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <Edit3 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={remove}
          disabled={busy}
          title={t('wx.delete')}
          className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-red-500/20 hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  )
}

function LoginDialog(props: { intent: LoginIntent; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const { intent, onClose, onDone } = props
  const activeProject = useProjectStore((s) => s.activeProject)
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'waiting' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState(t('wx.generatingQr'))
  const [workspacePath, setWorkspacePath] = useState(intent.workspacePath || activeProject?.path || '')
  const [label, setLabel] = useState(intent.label || '')
  const [accessLevel, setAccessLevel] = useState<'full' | 'workspace' | 'readonly'>(intent.accessLevel)
  const [language, setLanguage] = useState<'en' | 'zh'>(intent.language)
  const [step, setStep] = useState<'config' | 'scan'>(intent.skipConfig ? 'scan' : 'config')
  const cancelled = useRef(false)

  const isRescan = intent.skipConfig

  useEffect(() => () => { cancelled.current = true }, [])

  // Auto-start scan when opened in rescan mode
  useEffect(() => {
    if (intent.skipConfig) void startScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startScan() {
    if (!isAbsolutePath(workspacePath)) {
      setMessage(t('wx.pathRequired'))
      return
    }
    setStep('scan')
    setStatus('loading')
    setMessage(t('wx.generatingQr'))

    try {
      const { qrcodeUrl, sessionKey: key } = await api.weixin.startLogin()
      if (cancelled.current) return
      if (!qrcodeUrl) {
        setStatus('error')
        setMessage(t('wx.qrFailed'))
        return
      }
      setSessionKey(key)
      const dataUrl = await QRCode.toDataURL(qrcodeUrl, { width: 256, margin: 2 })
      if (cancelled.current) return
      setQrDataUrl(dataUrl)
      setStatus('waiting')
      setMessage(t('wx.scanPrompt'))

      const result = await api.weixin.waitLogin({ sessionKey: key, workspacePath, label: label || undefined, accessLevel, language })
      if (cancelled.current) return
      if (result.connected) {
        setStatus('success')
        setMessage(t('wx.connected', { id: result.accountId ?? '' }))
        setTimeout(onDone, 1200)
      } else {
        setStatus('error')
        setMessage(result.message || t('wx.loginFailed'))
      }
    } catch (err) {
      if (cancelled.current) return
      setStatus('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[400px] rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--foreground)]">{isRescan ? t('wx.rescanBtn') : t('wx.addTitle')}</h3>
          <button onClick={onClose} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {step === 'config' ? (
          <div className="space-y-3">
            <div>
              <label className="text-[11px] text-[var(--muted-foreground)]">{t('wx.bindWorkspace')}</label>
              <input
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 font-mono text-xs"
                placeholder="/home/user/project"
              />
              <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                {t('wx.bindHint')}
              </p>
            </div>
            <div>
              <label className="text-[11px] text-[var(--muted-foreground)]">{t('wx.nameOptional')}</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-xs"
                placeholder={t('wx.namePlaceholder')}
              />
            </div>
            <div>
              <label className="text-[11px] text-[var(--muted-foreground)]">{t('wx.accessLevel')}</label>
              <select
                value={accessLevel}
                onChange={(e) => setAccessLevel(e.target.value as 'full' | 'workspace' | 'readonly')}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-xs"
              >
                <option value="readonly">{t('wx.readonly')}</option>
                <option value="workspace">{t('wx.wsWrite')}</option>
                <option value="full">{t('wx.full')}</option>
              </select>
              <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                {t('wx.readonlyShareHint')}
              </p>
            </div>
            <LanguageSelect value={language} onChange={setLanguage} />
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs"
              >
                {t('wx.cancel')}
              </button>
              <button
                onClick={startScan}
                disabled={!isAbsolutePath(workspacePath)}
                className="rounded bg-[var(--primary)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                {t('wx.nextStep')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt={t('wx.scanTitle')} className="rounded border border-[var(--border)]" />
            ) : (
              <div className="flex h-64 w-64 items-center justify-center rounded border border-[var(--border)] bg-[var(--card)]">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--muted-foreground)]" />
              </div>
            )}
            <p className={cn(
              'text-center text-xs',
              status === 'success' && 'text-emerald-400',
              status === 'error' && 'text-red-400',
              status !== 'success' && status !== 'error' && 'text-[var(--muted-foreground)]',
            )}>
              {message}
            </p>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {t('wx.bindTo')} <code className="text-[var(--foreground)]">{workspacePath}</code>
            </p>
            {status === 'error' && (
              <button
                onClick={() => { setStep('config') }}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs"
              >
                {t('wx.restart')}
              </button>
            )}
          </div>
        )}

        {sessionKey && <input type="hidden" value={sessionKey} readOnly />}
      </div>
    </div>
  )
}

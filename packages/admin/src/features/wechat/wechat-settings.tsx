'use client'

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Loader2, QrCode } from 'lucide-react'
import { api } from '@/shared/api-client'
import { cn, isAbsolutePath } from '@/shared/utils'
import { useProjectStore } from '@/shared/stores/project-store'
import { useT, useI18n } from '@/shared/i18n'
import { ChannelAccountsPage, ChannelAccountRow, RowAction, useChannelAccounts } from '@/features/channels/account-list'
import { AddAccountFields, ChannelDialog, type AccessLevel, type AccountDraft } from '@/features/channels/account-form'

interface WechatAccount {
  accountId: string
  baseUrl: string
  userId: string
  workspacePath: string
  label: string
  enabled: boolean
  accessLevel: AccessLevel
  language: 'en' | 'zh'
  createdAt: number
  updatedAt: number
}

interface LoginIntent {
  workspacePath: string
  label: string
  accessLevel: AccessLevel
  language: 'en' | 'zh'
  /** When true, skip the config step and jump straight to QR scanning. */
  skipConfig: boolean
}

export function WechatSettings() {
  const t = useT()
  const { lang } = useI18n()
  const { accounts, loading, reload } = useChannelAccounts<WechatAccount>('wechat', api.wechat.listAccounts)
  const [loginIntent, setLoginIntent] = useState<LoginIntent | null>(null)

  return (
    <ChannelAccountsPage
      ns="wx"
      accounts={accounts}
      loading={loading}
      reload={reload}
      onAdd={() => setLoginIntent({ workspacePath: '', label: '', accessLevel: 'readonly', language: lang, skipConfig: false })}
      renderRow={(a, row) => (
        <ChannelAccountRow
          {...row}
          ns="wx"
          account={a}
          title={a.label || a.accountId}
          deleteName={a.label}
          titleExtra={<span className="font-mono text-[10px] text-[var(--muted-foreground)]">{a.accountId}</span>}
          detail={a.workspacePath}
          accessHint={t('wx.readonlyHint')}
          actions={(busy) => (
            <RowAction
              onClick={() => setLoginIntent({
                workspacePath: a.workspacePath,
                label: a.label,
                accessLevel: a.accessLevel,
                language: a.language,
                skipConfig: true,
              })}
              disabled={busy}
              title={t('wx.rescan')}
              icon={QrCode}
            />
          )}
          save={(d) => api.wechat.updateAccount(a.accountId, d)}
          setEnabled={(enabled) => api.wechat.updateAccount(a.accountId, { enabled })}
          remove={() => api.wechat.deleteAccount(a.accountId)}
        />
      )}
    >
      {loginIntent && (
        <LoginDialog
          intent={loginIntent}
          onClose={() => setLoginIntent(null)}
          onDone={() => { setLoginIntent(null); reload() }}
        />
      )}
    </ChannelAccountsPage>
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
  const [draft, setDraft] = useState<AccountDraft>({
    workspacePath: intent.workspacePath || activeProject?.path || '',
    label: intent.label || '',
    accessLevel: intent.accessLevel,
    language: intent.language,
  })
  const { workspacePath, label, accessLevel, language } = draft
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
      const { qrcodeUrl, sessionKey: key } = await api.wechat.startLogin()
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

      const result = await api.wechat.waitLogin({ sessionKey: key, workspacePath, label: label || undefined, accessLevel, language })
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
    <ChannelDialog width="w-[400px]" title={isRescan ? t('wx.rescanBtn') : t('wx.addTitle')} onClose={onClose}>
      {step === 'config' ? (
        <div className="space-y-3">
          <AddAccountFields
            ns="wx"
            value={draft}
            onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
            workspaceHint={t('wx.bindHint')}
            accessHint={t('wx.readonlyShareHint')}
          />
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
    </ChannelDialog>
  )
}

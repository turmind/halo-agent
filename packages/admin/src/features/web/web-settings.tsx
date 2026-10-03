'use client'

import { useState } from 'react'
import { Copy } from 'lucide-react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { ChannelAccountsPage, ChannelAccountRow, useChannelAccounts } from '@/features/channels/account-list'
import { ChannelAddDialog, ChannelDialog, type AccessLevel } from '@/features/channels/account-form'

interface WebAccount {
  accountId: string
  token: string
  workspacePath: string
  workspaceMissing: boolean
  label: string
  enabled: number
  accessLevel: AccessLevel
  language?: 'en' | 'zh'
  createdAt: number
  updatedAt: number
}

export function WebSettings() {
  const { accounts, loading, reload } = useChannelAccounts<WebAccount>('web', api.web.listAccounts)
  const [adding, setAdding] = useState(false)

  return (
    <ChannelAccountsPage
      ns="web"
      accounts={accounts}
      loading={loading}
      reload={reload}
      onAdd={() => setAdding(true)}
      renderRow={(a, row) => (
        <ChannelAccountRow
          {...row}
          ns="web"
          account={a}
          // Web tokens also mint the dashboard-only `observer` level.
          observer
          title={a.label || a.accountId}
          detail={a.workspacePath}
          workspaceMissing={a.workspaceMissing}
          footer={<TokenLine token={a.token} />}
          save={(d) => api.web.updateAccount(a.accountId, d)}
          setEnabled={(enabled) => api.web.updateAccount(a.accountId, { enabled })}
          remove={() => api.web.deleteAccount(a.accountId)}
        />
      )}
    >
      {adding && <AddDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
    </ChannelAccountsPage>
  )
}

function TokenLine(props: { token: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)

  function copyToken() {
    navigator.clipboard.writeText(props.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="rounded bg-[var(--secondary)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--muted-foreground)]">
        {props.token.slice(0, 12)}...
      </code>
      <button onClick={copyToken} className="text-[10px] text-[var(--primary)] hover:underline">
        {copied ? t('web.copied') : t('web.copyToken')}
      </button>
    </div>
  )
}

function AddDialog(props: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const { onClose, onDone } = props
  const [result, setResult] = useState<{ token: string } | null>(null)

  if (result) {
    return (
      <ChannelDialog width="w-[420px]" onClose={onDone}>
        <h3 className="mb-3 text-sm font-medium text-[var(--foreground)]">{t('web.createSuccess')}</h3>
        <p className="mb-2 text-xs text-[var(--muted-foreground)]">{t('web.tokenNotice')}</p>
        <div className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--card)] p-2">
          <code className="flex-1 break-all font-mono text-xs text-[var(--foreground)]">{result.token}</code>
          <button
            onClick={() => navigator.clipboard.writeText(result.token)}
            className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onDone} className="rounded bg-[var(--primary)] px-3 py-1.5 text-xs text-white">
            {t('web.done')}
          </button>
        </div>
      </ChannelDialog>
    )
  }

  return (
    <ChannelAddDialog
      ns="web"
      width="w-[420px]"
      observer
      onClose={onClose}
      create={(f) => api.web.createAccount(f)}
      onDone={(res) => setResult({ token: res.token })}
    />
  )
}

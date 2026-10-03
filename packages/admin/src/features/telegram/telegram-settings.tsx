'use client'

import { useState } from 'react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { ChannelAccountsPage, ChannelAccountRow, useChannelAccounts } from '@/features/channels/account-list'
import { ChannelAddDialog, Field, TextInput, type AccessLevel } from '@/features/channels/account-form'

interface TelegramAccount {
  accountId: string
  botUsername: string
  workspacePath: string
  workspaceMissing: boolean
  label: string
  enabled: number
  accessLevel: AccessLevel
  allowedUsers: string
  language: string
  createdAt: number
  updatedAt: number
}

export function TelegramSettings() {
  const t = useT()
  const { accounts, loading, reload } = useChannelAccounts<TelegramAccount>('telegram', api.telegram.listAccounts)
  const [adding, setAdding] = useState(false)

  return (
    <ChannelAccountsPage
      ns="tg"
      accounts={accounts}
      loading={loading}
      reload={reload}
      onAdd={() => setAdding(true)}
      renderRow={(a, row) => (
        <ChannelAccountRow
          {...row}
          ns="tg"
          account={a}
          title={a.label || `@${a.botUsername}`}
          deleteName={a.botUsername}
          titleExtra={a.allowedUsers && (
            <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-300">
              {t('tg.whitelist')}
            </span>
          )}
          detail={<>@{a.botUsername} → {a.workspacePath}</>}
          workspaceMissing={a.workspaceMissing}
          extraDraft={{ allowedUsers: a.allowedUsers }}
          editExtra={(d, set) => (
            <Field compact label={t('tg.allowedUsers')}>
              <TextInput compact mono value={d.allowedUsers} onChange={(allowedUsers) => set({ allowedUsers })} placeholder="123456789,@username" />
            </Field>
          )}
          save={(d) => api.telegram.updateAccount(a.accountId, d)}
          setEnabled={(enabled) => api.telegram.updateAccount(a.accountId, { enabled })}
          remove={() => api.telegram.deleteAccount(a.accountId)}
        />
      )}
    >
      {adding && <AddDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
    </ChannelAccountsPage>
  )
}

function AddDialog(props: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [botToken, setBotToken] = useState('')
  const [allowedUsers, setAllowedUsers] = useState('')

  return (
    <ChannelAddDialog
      ns="tg"
      width="w-[420px]"
      onClose={props.onClose}
      onDone={props.onDone}
      canSubmit={!!botToken.trim()}
      create={(f) => api.telegram.createAccount({ botToken, ...f, allowedUsers: allowedUsers || undefined })}
      extraFields={(
        <Field label={t('tg.allowedUsersOptional')}>
          <TextInput mono value={allowedUsers} onChange={setAllowedUsers} placeholder={t('tg.allowedUsersHint')} />
        </Field>
      )}
    >
      <Field label={t('tg.tokenLabel')}>
        <TextInput mono type="password" value={botToken} onChange={setBotToken} placeholder="123456:ABC-DEF..." />
      </Field>
    </ChannelAddDialog>
  )
}

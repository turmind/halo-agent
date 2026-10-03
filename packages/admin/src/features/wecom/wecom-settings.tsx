'use client'

import { useState } from 'react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { ChannelAccountsPage, ChannelAccountRow, useChannelAccounts } from '@/features/channels/account-list'
import { ChannelAddDialog, Field, TextInput, type AccessLevel } from '@/features/channels/account-form'

interface WecomAccount {
  accountId: string
  botId: string
  workspacePath: string
  workspaceMissing: boolean
  label: string
  enabled: number
  accessLevel: AccessLevel
  language: string
  createdAt: number
  updatedAt: number
}

export function WecomSettings() {
  const { accounts, loading, reload } = useChannelAccounts<WecomAccount>('wecom', api.wecom.listAccounts)
  const [adding, setAdding] = useState(false)

  return (
    <ChannelAccountsPage
      ns="wecom"
      accounts={accounts}
      loading={loading}
      reload={reload}
      onAdd={() => setAdding(true)}
      renderRow={(a, row) => (
        <ChannelAccountRow
          {...row}
          ns="wecom"
          account={a}
          title={a.label || a.botId}
          deleteName={a.botId}
          detail={<>bot:{a.botId} → {a.workspacePath}</>}
          workspaceMissing={a.workspaceMissing}
          save={(d) => api.wecom.updateAccount(a.accountId, d)}
          setEnabled={(enabled) => api.wecom.updateAccount(a.accountId, { enabled })}
          remove={() => api.wecom.deleteAccount(a.accountId)}
        />
      )}
    >
      {adding && <AddDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
    </ChannelAccountsPage>
  )
}

function AddDialog(props: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [botId, setBotId] = useState('')
  const [secret, setSecret] = useState('')

  return (
    <ChannelAddDialog
      ns="wecom"
      width="w-[480px]"
      onClose={props.onClose}
      onDone={props.onDone}
      canSubmit={!!botId.trim() && !!secret.trim()}
      create={(f) => api.wecom.createAccount({ botId, secret, ...f })}
    >
      <Field label={t('wecom.botIdLabel')}>
        <TextInput mono value={botId} onChange={setBotId} placeholder="wecombot_xxxxxxx" />
      </Field>
      <Field label={t('wecom.secretLabel')}>
        <TextInput mono type="password" value={secret} onChange={setSecret} placeholder="****************" />
      </Field>
    </ChannelAddDialog>
  )
}

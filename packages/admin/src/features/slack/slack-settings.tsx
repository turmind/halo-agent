'use client'

import { useState } from 'react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { ChannelAccountsPage, ChannelAccountRow, useChannelAccounts } from '@/features/channels/account-list'
import { ChannelAddDialog, Field, TextInput, type AccessLevel } from '@/features/channels/account-form'

interface SlackAccount {
  accountId: string
  botUserId: string
  teamId: string
  workspacePath: string
  workspaceMissing: boolean
  label: string
  enabled: number
  accessLevel: AccessLevel
  language: string
  createdAt: number
  updatedAt: number
}

export function SlackSettings() {
  const { accounts, loading, reload } = useChannelAccounts<SlackAccount>('slack', api.slack.listAccounts)
  const [adding, setAdding] = useState(false)

  return (
    <ChannelAccountsPage
      ns="slack"
      accounts={accounts}
      loading={loading}
      reload={reload}
      onAdd={() => setAdding(true)}
      renderRow={(a, row) => (
        <ChannelAccountRow
          {...row}
          ns="slack"
          account={a}
          title={a.label || a.teamId}
          deleteName={a.teamId}
          detail={<>team:{a.teamId} bot:{a.botUserId} → {a.workspacePath}</>}
          workspaceMissing={a.workspaceMissing}
          save={(d) => api.slack.updateAccount(a.accountId, d)}
          setEnabled={(enabled) => api.slack.updateAccount(a.accountId, { enabled })}
          remove={() => api.slack.deleteAccount(a.accountId)}
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
  const [appToken, setAppToken] = useState('')

  return (
    <ChannelAddDialog
      ns="slack"
      width="w-[480px]"
      onClose={props.onClose}
      onDone={props.onDone}
      canSubmit={!!botToken.trim() && !!appToken.trim()}
      create={(f) => api.slack.createAccount({ botToken, appToken, ...f })}
    >
      <Field label={t('slack.botTokenLabel')} hint={t('slack.botTokenHint')}>
        <TextInput mono value={botToken} onChange={setBotToken} placeholder="xoxb-..." />
      </Field>
      <Field label={t('slack.appTokenLabel')} hint={t('slack.appTokenHint')}>
        <TextInput mono value={appToken} onChange={setAppToken} placeholder="xapp-..." />
      </Field>
    </ChannelAddDialog>
  )
}

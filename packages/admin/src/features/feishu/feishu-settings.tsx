'use client'

import { useState } from 'react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { ChannelAccountsPage, ChannelAccountRow, useChannelAccounts } from '@/features/channels/account-list'
import { ChannelAddDialog, Field, TextInput, type AccessLevel } from '@/features/channels/account-form'

interface FeishuAccount {
  accountId: string
  appId: string
  botOpenId: string
  hasEncryptKey: boolean
  workspacePath: string
  workspaceMissing: boolean
  label: string
  enabled: number
  accessLevel: AccessLevel
  language: string
  createdAt: number
  updatedAt: number
}

export function FeishuSettings() {
  const { accounts, loading, reload } = useChannelAccounts<FeishuAccount>('feishu', api.feishu.listAccounts)
  const [adding, setAdding] = useState(false)

  return (
    <ChannelAccountsPage
      ns="feishu"
      accounts={accounts}
      loading={loading}
      reload={reload}
      onAdd={() => setAdding(true)}
      renderRow={(a, row) => (
        <ChannelAccountRow
          {...row}
          ns="feishu"
          account={a}
          title={a.label || a.appId}
          deleteName={a.appId}
          detail={<>app:{a.appId} bot:{a.botOpenId} → {a.workspacePath}</>}
          workspaceMissing={a.workspaceMissing}
          save={(d) => api.feishu.updateAccount(a.accountId, d)}
          setEnabled={(enabled) => api.feishu.updateAccount(a.accountId, { enabled })}
          remove={() => api.feishu.deleteAccount(a.accountId)}
        />
      )}
    >
      {adding && <AddDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
    </ChannelAccountsPage>
  )
}

function AddDialog(props: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [verificationToken, setVerificationToken] = useState('')
  const [encryptKey, setEncryptKey] = useState('')

  return (
    <ChannelAddDialog
      ns="feishu"
      width="w-[480px]"
      onClose={props.onClose}
      onDone={props.onDone}
      canSubmit={!!appId.trim() && !!appSecret.trim()}
      create={(f) => api.feishu.createAccount({
        appId, appSecret,
        verificationToken: verificationToken || undefined,
        encryptKey: encryptKey || undefined,
        ...f,
      })}
    >
      <Field label={t('feishu.appIdLabel')}>
        <TextInput mono value={appId} onChange={setAppId} placeholder="cli_xxxxxxx" />
      </Field>
      <Field label={t('feishu.appSecretLabel')}>
        <TextInput mono type="password" value={appSecret} onChange={setAppSecret} placeholder="****************" />
      </Field>
      <Field label={t('feishu.verificationTokenLabel')}>
        <TextInput mono value={verificationToken} onChange={setVerificationToken} placeholder="" />
      </Field>
      <Field label={t('feishu.encryptKeyLabel')}>
        <TextInput mono type="password" value={encryptKey} onChange={setEncryptKey} placeholder="" />
      </Field>
    </ChannelAddDialog>
  )
}

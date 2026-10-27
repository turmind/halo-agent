'use client'

import { useEffect, useState } from 'react'
import { Copy, Loader2, Trash2 } from 'lucide-react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { cn, confirmAction, isAbsolutePath } from '@/shared/utils'
import { wsClient } from '@/shared/ws-client'
import { onWsReconnect } from '@/shared/ws-reconnect'
import { useProjectStore } from '@/shared/stores/project-store'
import { ChannelAccountsPage, RowAction, useChannelAccounts } from '@/features/channels/account-list'
import { ChannelDialog, Field, TextInput } from '@/features/channels/account-form'
import { TokenLine } from '@/features/web/web-settings'

type NodeAccount = Awaited<ReturnType<typeof api.nodes.listAccounts>>['accounts'][number]
type Online = NonNullable<NodeAccount['online']>

/**
 * Linked machines (`halo node`): pairing tokens per workspace + live online
 * state. Online starts from the list response, then follows `nodes:changed`
 * pushes (full snapshots); a WS reconnect re-fetches the frames it may have
 * missed. No polling.
 */
export function NodeSettings() {
  const { accounts, loading, reload } = useChannelAccounts<NodeAccount>('nodes', api.nodes.listAccounts)
  // Latest pushed snapshot; null until the first push and again after a WS
  // reconnect, when the re-fetched list is the truth.
  const [pushed, setPushed] = useState<Map<string, Online> | null>(null)
  const [adding, setAdding] = useState(false)
  const online = pushed ?? new Map(accounts.flatMap((a) => (a.online ? [[a.accountId, a.online] as const] : [])))

  useEffect(() => {
    const offFrame = wsClient.on('nodes:changed', (f) => {
      setPushed(new Map(f.online.map(({ accountId, ...o }) => [accountId, o])))
    })
    const offReconnect = onWsReconnect(wsClient, () => { setPushed(null); reload() })
    return () => { offFrame(); offReconnect() }
  }, [reload])

  return (
    <ChannelAccountsPage
      ns="nodes"
      accounts={accounts}
      loading={loading}
      reload={reload}
      onAdd={() => setAdding(true)}
      renderRow={(a) => <NodeRow account={a} online={online.get(a.accountId)} onChanged={reload} />}
    >
      {adding && <AddDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
    </ChannelAccountsPage>
  )
}

function NodeRow(props: { account: NodeAccount; online?: Online; onChanged: () => void }) {
  const t = useT()
  const { account: a, online } = props
  const [busy, setBusy] = useState(false)

  async function remove() {
    if (!(await confirmAction(t('nodes.confirmDelete', { name: a.name })))) return
    setBusy(true)
    try {
      await api.nodes.deleteAccount(a.accountId)
      props.onChanged()
    } catch (err) {
      alert(t('nodes.deleteFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setBusy(false) }
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div
        className={cn('h-2 w-2 rounded-full', online ? 'bg-emerald-500' : 'bg-[var(--muted-foreground)]')}
        title={online ? t('nodes.online') : t('nodes.offline')}
      />
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium text-[var(--foreground)]">{a.name}</span>
        <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted-foreground)]">
          {a.workspacePath}
          {a.workspaceMissing && <span className="ml-1 text-red-400">{t('nodes.pathMissing')}</span>}
        </p>
        <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">
          {online
            ? [online.root ?? t('nodes.wholeMachine'), online.shell ? t('nodes.shellOn') : t('nodes.shellOff'), online.os].join(' · ')
            : t('nodes.offline')}
        </p>
        <TokenLine token={a.token} />
      </div>
      <RowAction onClick={remove} disabled={busy} title={t('nodes.delete')} icon={Trash2} danger />
    </li>
  )
}

function AddDialog(props: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const { onClose, onDone } = props
  const activeProject = useProjectStore((s) => s.activeProject)
  const [workspacePath, setWorkspacePath] = useState(activeProject?.path || '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState<string | null>(null)

  async function submit() {
    setError('')
    setBusy(true)
    try {
      setToken((await api.nodes.createAccount({ workspacePath, name })).token)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  if (token) {
    const command = `HALO_NODE_TOKEN=${token} halo node --server ${location.origin} --root <folder>`
    return (
      <ChannelDialog width="w-[480px]" onClose={onDone}>
        <h3 className="mb-3 text-sm font-medium text-[var(--foreground)]">{t('nodes.createSuccess')}</h3>
        <p className="mb-2 text-xs text-[var(--muted-foreground)]">{t('nodes.commandNotice')}</p>
        <div className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--card)] p-2">
          <code className="flex-1 break-all font-mono text-xs text-[var(--foreground)]">{command}</code>
          <button
            onClick={() => navigator.clipboard.writeText(command)}
            className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-2 text-[10px] text-[var(--muted-foreground)]">{t('nodes.commandHint')}</p>
        <div className="mt-4 flex justify-end">
          <button onClick={onDone} className="rounded bg-[var(--primary)] px-3 py-1.5 text-xs text-white">
            {t('nodes.done')}
          </button>
        </div>
      </ChannelDialog>
    )
  }

  return (
    <ChannelDialog width="w-[420px]" title={t('nodes.addTitle')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('nodes.bindWorkspace')}>
          <TextInput mono value={workspacePath} onChange={setWorkspacePath} placeholder="/home/user/project" />
        </Field>
        <Field label={t('nodes.name')} hint={t('nodes.nameHint')}>
          <TextInput mono value={name} onChange={setName} placeholder="mbp" />
        </Field>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded border border-[var(--border)] px-3 py-1.5 text-xs">
            {t('nodes.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={busy || !name || !isAbsolutePath(workspacePath)}
            className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('nodes.addBtn')}
          </button>
        </div>
      </div>
    </ChannelDialog>
  )
}

'use client'

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Plus, Trash2, Power, PowerOff, Edit3, Check, X, Loader2, type LucideIcon } from 'lucide-react'
import { cn, isAbsolutePath, confirmAction } from '@/shared/utils'
import { useT, LanguageSelect, type Lang } from '@/shared/i18n'
import { useChannelBus } from '@/shared/channel-bus'
import { Field, TextInput, AccessLevelSelect, type AccessLevel, type AccountDraft } from './account-form'

/**
 * Account list shell shared by the channel settings pages: fetch + refresh,
 * header / loading / empty states, and the account row (status, actions,
 * inline edit form). Strings come from the channel's i18n namespace `ns`:
 * title, desc, add, loading, empty, label, labelPlaceholder, workspace,
 * accessLevel, save, cancel, pathMissing, enable, disable, edit, delete,
 * confirmDelete, saveFailed, switchFailed, deleteFailed.
 */

/** `list` must be a stable reference (e.g. `api.wecom.listAccounts`). */
export function useChannelAccounts<A>(tag: string, list: () => Promise<{ accounts: A[] }>) {
  const [accounts, setAccounts] = useState<A[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    list().then((r) => setAccounts(r.accounts)).catch((err) => {
      console.error(`[${tag}] list failed:`, err)
    }).finally(() => setLoading(false))
  }, [tag, list])

  useEffect(() => { reload() }, [reload])

  // Sidebar's refresh button bumps the channel bus → re-run reload.
  const channelBusVersion = useChannelBus((s) => s.version)
  useEffect(() => { if (channelBusVersion > 0) reload() }, [channelBusVersion, reload])

  return { accounts, loading, reload }
}

/** Per-row wiring the page hands to `renderRow`. */
export interface AccountRowState {
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSaved: () => void
  /** Toggled or deleted — reload the list. */
  onChanged: () => void
}

export function ChannelAccountsPage<A extends { accountId: string }>(props: {
  ns: string
  accounts: A[]
  loading: boolean
  reload: () => void
  onAdd: () => void
  renderRow: (account: A, row: AccountRowState) => ReactNode
  /** The add dialog, when open. */
  children?: ReactNode
}) {
  const t = useT()
  const { ns, accounts, loading, reload } = props
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--foreground)]">{t(`${ns}.title`)}</h2>
          <p className="text-[11px] text-[var(--muted-foreground)]">{t(`${ns}.desc`)}</p>
        </div>
        <button
          onClick={props.onAdd}
          className="flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t(`${ns}.add`)}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            {t(`${ns}.loading`)}
          </div>
        ) : accounts.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--muted-foreground)]">
            {t(`${ns}.empty`)}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {accounts.map((a) => (
              <Fragment key={a.accountId}>
                {props.renderRow(a, {
                  editing: editingId === a.accountId,
                  onEdit: () => setEditingId(a.accountId),
                  onCancelEdit: () => setEditingId(null),
                  onSaved: () => { setEditingId(null); reload() },
                  onChanged: reload,
                })}
              </Fragment>
            ))}
          </ul>
        )}
      </div>

      {props.children}
    </div>
  )
}

export function RowAction(props: { title: string; icon: LucideIcon; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  const Icon = props.icon
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={cn(
        'rounded p-1.5 text-[var(--muted-foreground)]',
        props.danger ? 'hover:bg-red-500/20 hover:text-red-400' : 'hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

/** Fields the shared row reads; each channel's account type adds its own. */
export interface ChannelAccount {
  accountId: string
  workspacePath: string
  label: string
  enabled: number | boolean
  accessLevel: AccessLevel
  language?: string
}

const ACCESS_BADGE: Record<AccessLevel, { text: string; className: string }> = {
  readonly: { text: 'Readonly', className: 'bg-emerald-500/15 text-emerald-300' },
  observer: { text: 'Observer', className: 'bg-teal-500/15 text-teal-300' },
  workspace: { text: 'Workspace', className: 'bg-blue-500/15 text-blue-300' },
  full: { text: 'Full', className: 'bg-amber-500/15 text-amber-300' },
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

type RowProps<X> = AccountRowState & {
  ns: string
  account: ChannelAccount
  /** Bold name, typically `label || <channel id>`. */
  title: string
  /** `{name}` in the `<ns>.confirmDelete` prompt. */
  deleteName?: string
  /** Monospace line under the name. */
  detail: ReactNode
  /** Appends `<ns>.pathMissing` to the detail line. */
  workspaceMissing?: boolean
  /** After the access badge on the name line. */
  titleExtra?: ReactNode
  /** Below the detail line. */
  footer?: ReactNode
  /** Extra action buttons, between enable/disable and edit. */
  actions?: (busy: boolean) => ReactNode
  /** Offers the web-only `observer` level. */
  observer?: boolean
  /** Edit form: hint under the access level select. */
  accessHint?: string
  /** Edit form: initial values of the channel's own extra fields. */
  extraDraft?: X
  /** Edit form: the channel's own fields, after the language select. */
  editExtra?: (draft: X, set: (patch: Partial<X>) => void) => ReactNode
  /** `accessLevel` is left out when an untouched `observer` can't be stored. */
  save: (draft: Omit<AccountDraft & X, 'accessLevel'> & { accessLevel?: AccessLevel }) => Promise<unknown>
  setEnabled: (enabled: boolean) => Promise<unknown>
  remove: () => Promise<unknown>
}

/**
 * One account: status dot, name + access badge, `detail` line, actions
 * (enable/disable, edit, delete), or the inline edit form while `editing`.
 * The channel passes its own API calls (`save` / `setEnabled` / `remove`).
 */
export function ChannelAccountRow<X extends object = Record<never, never>>(props: RowProps<X>) {
  const t = useT()
  const { ns, account, onEdit, onChanged } = props
  const [busy, setBusy] = useState(false)

  if (props.editing) return <AccountEditForm {...props} />

  async function run(action: () => Promise<unknown>, errorKey: string) {
    setBusy(true)
    try {
      await action()
      onChanged()
    } catch (err) {
      alert(t(`${ns}.${errorKey}`, { error: errorText(err) }))
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!(await confirmAction(t(`${ns}.confirmDelete`, { name: props.deleteName ?? '' })))) return
    await run(props.remove, 'deleteFailed')
  }

  const badge = ACCESS_BADGE[account.accessLevel]
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className={cn('h-2 w-2 rounded-full', account.enabled ? 'bg-emerald-500' : 'bg-[var(--muted-foreground)]')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--foreground)]">{props.title}</span>
          <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium', badge.className)}>
            {badge.text}
          </span>
          {props.titleExtra}
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted-foreground)]">
          {props.detail}
          {props.workspaceMissing && <span className="ml-1 text-red-400">{t(`${ns}.pathMissing`)}</span>}
        </p>
        {props.footer}
      </div>
      <div className="flex items-center gap-1">
        <RowAction
          onClick={() => run(() => props.setEnabled(!account.enabled), 'switchFailed')}
          disabled={busy}
          title={account.enabled ? t(`${ns}.disable`) : t(`${ns}.enable`)}
          icon={account.enabled ? Power : PowerOff}
        />
        {props.actions?.(busy)}
        <RowAction onClick={onEdit} disabled={busy} title={t(`${ns}.edit`)} icon={Edit3} />
        <RowAction onClick={remove} disabled={busy} title={t(`${ns}.delete`)} icon={Trash2} danger />
      </div>
    </li>
  )
}

/** Mounted only while editing, so every edit starts from the account's
 *  current values. */
function AccountEditForm<X extends object>(props: RowProps<X>) {
  const t = useT()
  const { ns, account } = props
  const seed = (): AccountDraft & X => ({
    label: account.label,
    workspacePath: account.workspacePath,
    accessLevel: account.accessLevel,
    language: (account.language as Lang) || 'en',
    ...(props.extraDraft as X),
  })
  const [draft, setDraft] = useState(seed)
  // A list reload mid-edit hands in a fresh account object — re-seed, as
  // the per-channel rows' `[editing, account]` effect used to.
  const [seededFrom, setSeededFrom] = useState(account)
  if (seededFrom !== account) {
    setSeededFrom(account)
    setDraft(seed())
  }
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<AccountDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setExtra = (patch: Partial<X>) => setDraft((d) => ({ ...d, ...patch }))

  async function save() {
    setBusy(true)
    // Chat channels' routes reject `observer`, but an older row can still hold
    // it: left unchanged, it stays out of the patch and the row keeps it.
    const { accessLevel, ...rest } = draft
    try {
      await props.save(accessLevel === 'observer' && !props.observer ? rest : draft)
      props.onSaved()
    } catch (err) {
      alert(t(`${ns}.saveFailed`, { error: errorText(err) }))
    } finally { setBusy(false) }
  }

  return (
    <li className="px-4 py-3">
      <div className="space-y-2">
        <Field compact label={t(`${ns}.label`)}>
          <TextInput compact value={draft.label} onChange={(label) => set({ label })} placeholder={t(`${ns}.labelPlaceholder`)} />
        </Field>
        <Field compact label={t(`${ns}.workspace`)}>
          <TextInput compact mono value={draft.workspacePath} onChange={(workspacePath) => set({ workspacePath })} placeholder="/home/user/project" />
        </Field>
        <Field compact label={t(`${ns}.accessLevel`)} hint={props.accessHint}>
          <AccessLevelSelect compact ns={ns} value={draft.accessLevel} onChange={(accessLevel) => set({ accessLevel })} observer={props.observer} />
        </Field>
        <LanguageSelect value={draft.language} onChange={(language) => set({ language })} />
        {props.editExtra?.(draft, setExtra)}
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={busy || !isAbsolutePath(draft.workspacePath)}
            className="flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
          >
            <Check className="h-3 w-3" /> {t(`${ns}.save`)}
          </button>
          <button
            onClick={props.onCancelEdit}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px]"
          >
            <X className="h-3 w-3" /> {t(`${ns}.cancel`)}
          </button>
        </div>
      </div>
    </li>
  )
}

'use client'

import { useState, type ReactNode } from 'react'
import { X, Loader2 } from 'lucide-react'
import { cn, isAbsolutePath } from '@/shared/utils'
import { useProjectStore } from '@/shared/stores/project-store'
import { useT, useI18n, LanguageSelect, type Lang } from '@/shared/i18n'

/**
 * Form pieces shared by the channel settings pages. Every i18n string is read
 * from the channel's own namespace (`ns` = 'wecom' / 'tg' / 'wx' …) — the
 * channels word their copy differently, so the keys stay per channel. Keys
 * read here: bindWorkspace, nameOptional, namePlaceholder, accessLevel,
 * readonly, wsWrite, full (+ observer when offered), addTitle, cancel, addBtn.
 */

export type AccessLevel = 'full' | 'workspace' | 'readonly' | 'observer'

/** The settings every channel account carries: edited in the row's inline
 *  form and collected by every add dialog. */
export interface AccountDraft {
  workspacePath: string
  label: string
  accessLevel: AccessLevel
  language: Lang
}

/** `compact` = the inline edit form inside an account row; default = dialog. */
function controlClass(compact?: boolean, mono?: boolean) {
  return cn(
    compact ? 'mt-0.5' : 'mt-1',
    'w-full rounded border border-[var(--border)] bg-[var(--card)] px-2',
    compact ? 'py-1' : 'py-1.5',
    mono && 'font-mono',
    'text-xs',
  )
}

export function Field(props: { label: string; hint?: string; compact?: boolean; children: ReactNode }) {
  return (
    <div>
      <label className={cn(props.compact ? 'text-[10px]' : 'text-[11px]', 'text-[var(--muted-foreground)]')}>{props.label}</label>
      {props.children}
      {props.hint && <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">{props.hint}</p>}
    </div>
  )
}

export function TextInput(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'password'
  mono?: boolean
  compact?: boolean
}) {
  return (
    <input
      type={props.type}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className={controlClass(props.compact, props.mono)}
      placeholder={props.placeholder}
    />
  )
}

/** `observer` is a web-only level (dashboard / metrics tokens); the chat
 *  channels' routes reject it, so their forms offer three levels — plus a
 *  disabled Observer entry when an older account already holds it. */
export function AccessLevelSelect(props: {
  ns: string
  value: AccessLevel
  onChange: (value: AccessLevel) => void
  observer?: boolean
  compact?: boolean
}) {
  const t = useT()
  const { ns } = props
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as AccessLevel)}
      className={controlClass(props.compact)}
    >
      <option value="readonly">{t(`${ns}.readonly`)}</option>
      {props.observer
        ? <option value="observer">{t(`${ns}.observer`)}</option>
        : props.value === 'observer' && <option value="observer" disabled>{t('channels.observerAdminOnly')}</option>}
      <option value="workspace">{t(`${ns}.wsWrite`)}</option>
      <option value="full">{t(`${ns}.full`)}</option>
    </select>
  )
}

/** Modal frame. Without `title` the caller renders its own heading. */
export function ChannelDialog(props: { width: string; title?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={props.onClose}>
      <div
        className={cn(props.width, 'max-h-[90vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl')}
        onClick={(e) => e.stopPropagation()}
      >
        {props.title && (
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--foreground)]">{props.title}</h3>
            <button onClick={props.onClose} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {props.children}
      </div>
    </div>
  )
}

/** Workspace / name / access level / language block of an add dialog. */
export function AddAccountFields(props: {
  ns: string
  value: AccountDraft
  onChange: (patch: Partial<AccountDraft>) => void
  observer?: boolean
  workspaceHint?: string
  accessHint?: string
}) {
  const t = useT()
  const { ns, value, onChange } = props
  return (
    <>
      <Field label={t(`${ns}.bindWorkspace`)} hint={props.workspaceHint}>
        <TextInput mono value={value.workspacePath} onChange={(workspacePath) => onChange({ workspacePath })} placeholder="/home/user/project" />
      </Field>
      <Field label={t(`${ns}.nameOptional`)}>
        <TextInput value={value.label} onChange={(label) => onChange({ label })} placeholder={t(`${ns}.namePlaceholder`)} />
      </Field>
      <Field label={t(`${ns}.accessLevel`)} hint={props.accessHint}>
        <AccessLevelSelect ns={ns} value={value.accessLevel} onChange={(accessLevel) => onChange({ accessLevel })} observer={props.observer} />
      </Field>
      <LanguageSelect value={value.language} onChange={(language) => onChange({ language })} />
    </>
  )
}

export type NewAccountFields = Omit<AccountDraft, 'label'> & { label?: string }

/**
 * Add-account dialog: channel credential inputs (`children`) on top, the
 * shared fields below, then `extraFields`. `create` makes the channel's API
 * call; a throw is shown inline, a result goes to `onDone`.
 */
export function ChannelAddDialog<R>(props: {
  ns: string
  width: string
  onClose: () => void
  create: (fields: NewAccountFields) => Promise<R>
  onDone: (result: R) => void
  /** The channel's required inputs are filled. */
  canSubmit?: boolean
  observer?: boolean
  children?: ReactNode
  extraFields?: ReactNode
}) {
  const t = useT()
  const { lang } = useI18n()
  const { ns, onClose, canSubmit = true } = props
  const activeProject = useProjectStore((s) => s.activeProject)
  const [draft, setDraft] = useState<AccountDraft>({
    workspacePath: activeProject?.path || '',
    label: '',
    accessLevel: 'readonly',
    language: lang,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    setBusy(true)
    try {
      props.onDone(await props.create({ ...draft, label: draft.label || undefined }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <ChannelDialog width={props.width} title={t(`${ns}.addTitle`)} onClose={onClose}>
      <div className="space-y-3">
        {props.children}
        <AddAccountFields ns={ns} value={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} observer={props.observer} />
        {props.extraFields}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-xs"
          >
            {t(`${ns}.cancel`)}
          </button>
          <button
            onClick={submit}
            disabled={busy || !canSubmit || !isAbsolutePath(draft.workspacePath)}
            className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {t(`${ns}.addBtn`)}
          </button>
        </div>
      </div>
    </ChannelDialog>
  )
}

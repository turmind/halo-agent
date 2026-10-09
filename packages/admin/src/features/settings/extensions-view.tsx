'use client'

import { useRef, useState, useSyncExternalStore } from 'react'
import { Upload, Trash2, AlertTriangle } from 'lucide-react'
import { api } from '@/shared/api-client'
import { useI18n } from '@/shared/i18n'
import { confirmAction } from '@/shared/utils'
import { getExtensionsSnapshot, platformLabels, runsHere, subscribe } from '@/features/editor/previews/registry'

/**
 * Settings → Extensions: the installed canvas preview extensions
 * (~/.halo/global/extensions/), upload a zip, uninstall. The list is the
 * preview registry's snapshot — seeded on page load and pushed on every
 * `extension:changed` — so install / remove here never re-fetch: the
 * server's dir watcher broadcasts and the row appears / disappears on its
 * own. Directories the scanner refused show as red rows so they can still
 * be removed.
 */
export function ExtensionsView() {
  const { t } = useI18n()
  const snapshot = useSyncExternalStore(subscribe, getExtensionsSnapshot, getExtensionsSnapshot)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUpload(file: File) {
    setBusy(true)
    setError(null)
    try {
      await api.extensions.install(file)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(id: string, name: string) {
    if (!(await confirmAction(t('settings.extensions.confirmRemove', { name })))) return
    setBusy(true)
    setError(null)
    try {
      await api.extensions.remove(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const empty = snapshot.extensions.length === 0 && snapshot.errors.length === 0
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--foreground)]">{t('settings.extensions.title')}</h2>
          <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{t('settings.extensions.intro')}</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // allow re-selecting the same zip after a failure
            if (file) void handleUpload(file)
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90 disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          {busy ? t('settings.extensions.working') : t('settings.extensions.upload')}
        </button>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      {empty ? (
        <p className="text-xs text-[var(--muted-foreground)]">{t('settings.extensions.empty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)]">
          {snapshot.extensions.map((ext) => (
            <li key={ext.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-medium text-[var(--foreground)]">{ext.name}</span>
                  <code className="text-[10px] text-[var(--muted-foreground)]">{ext.id}@{ext.version}</code>
                  {ext.platforms && (
                    <span className="shrink-0 rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                      {platformLabels(ext.platforms, t)}
                    </span>
                  )}
                  {!runsHere(ext) && (
                    <span className="shrink-0 rounded bg-[var(--secondary)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                      {t('settings.extensions.unsupportedHere')}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">
                  {ext.extensions.join(' ')}
                  {ext.priority === 'option' && ` · ${t('settings.extensions.optionOnly')}`}
                  {ext.bundle && ` · ${t('settings.extensions.bundle')}`}
                  {ext.capabilities.includes('save') && ` · ${t('settings.extensions.canSave')}`}
                  {ext.capabilities.includes('media') && ` · ${t('settings.extensions.media')}`}
                  {ext.capabilities.includes('fs-read') && ` · ${t('settings.extensions.fsRead')}`}
                  {ext.description && ` — ${ext.description}`}
                </p>
              </div>
              <RemoveButton disabled={busy} onClick={() => handleRemove(ext.id, ext.name)} label={t('settings.extensions.remove')} />
            </li>
          ))}
          {snapshot.errors.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
              <div className="min-w-0 flex-1">
                <code className="text-xs text-red-400">{e.id}</code>
                <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">{e.error}</p>
              </div>
              <RemoveButton disabled={busy} onClick={() => handleRemove(e.id, e.id)} label={t('settings.extensions.remove')} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RemoveButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
    >
      <Trash2 className="h-3 w-3" />
      {label}
    </button>
  )
}

'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, extractApiError, type ModelsSyncResult } from '@/shared/api-client'
import { useI18n } from '@/shared/i18n'
import { cn } from '@/shared/utils'

type Dialog =
  | { kind: 'confirm'; result: ModelsSyncResult }
  | { kind: 'done'; result: ModelsSyncResult }
  | { kind: 'error'; message: string }

/**
 * Settings → Model Providers → "Sync latest models": POST /api/models/update
 * installs the hub's newest models-v* release (same plan as `/extension
 * models`). A plan that adds an endpoint comes back `needsConfirm` with nothing
 * written — the dialog lists the changes and the confirmed retry writes. The
 * provider list refreshes from the `models:changed` push, not from here.
 */
export function ModelsSync() {
  const { t } = useI18n()
  const [syncing, setSyncing] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)

  async function sync(confirm: boolean) {
    setDialog(null)
    setSyncing(true)
    try {
      const result = await api.updates.syncModels(confirm)
      setDialog({ kind: result.needsConfirm ? 'confirm' : 'done', result })
    } catch (err) {
      console.error('[Settings] model sync failed:', err)
      setDialog({ kind: 'error', message: extractApiError(err) })
    } finally {
      setSyncing(false)
    }
  }

  const close = () => setDialog(null)
  const button = 'rounded px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--accent)]'

  return (
    <>
      <button
        onClick={() => sync(false)}
        disabled={syncing}
        className="flex w-full cursor-pointer items-center gap-2 py-1.5 pl-6 pr-3 text-[11px] text-[var(--foreground)]/80 transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:cursor-default disabled:opacity-50"
      >
        <RefreshCw className={cn('h-3 w-3 shrink-0', syncing && 'animate-spin')} />
        <span className="truncate">{syncing ? t('settings.models.syncing') : t('settings.models.sync')}</span>
      </button>

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
          <div className="flex max-h-[80vh] w-[560px] max-w-full flex-col overflow-hidden rounded border border-[var(--border)] bg-[var(--background)]" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-[var(--border)] px-3 py-2 text-xs font-medium">
              {dialog.kind === 'confirm' ? t('settings.models.confirmTitle')
                : dialog.kind === 'done' ? t('settings.models.doneTitle', { release: dialog.result.release })
                : t('settings.models.errorTitle')}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3 text-[11px]">
              {dialog.kind === 'error' && <p className="break-words text-red-400">{dialog.message}</p>}

              {dialog.kind === 'confirm' && (
                <>
                  <p className="mb-2 text-[var(--muted-foreground)]">{t('settings.models.confirmIntro', { release: dialog.result.release, hub: dialog.result.hub })}</p>
                  <ul className="space-y-2">
                    {dialog.result.entries.filter((e) => e.needsConfirm).map((e) => (
                      <li key={e.file}>
                        <span className="font-medium">{e.id ?? e.file}</span>
                        {e.endpointChanges.map((c) => <p key={c} className="break-all pl-3 font-mono text-[10px] text-[var(--muted-foreground)]">{c}</p>)}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {dialog.kind === 'done' && (
                <>
                  {dialog.result.summary && <p className="mb-2 font-mono text-[10px] text-[var(--muted-foreground)]">{dialog.result.summary}</p>}
                  <ul className="space-y-1">
                    {dialog.result.entries.map((e) => (
                      <li key={e.file} className="flex gap-2">
                        <span className="min-w-0 truncate font-medium">{e.id ?? e.file}</span>
                        <span className={cn('shrink-0', e.action === 'install' ? 'text-emerald-400' : e.action === 'refuse' ? 'text-red-400' : 'text-[var(--muted-foreground)]')}>
                          {t(`settings.models.action.${e.action}`)}
                        </span>
                        {e.reason && <span className="min-w-0 break-words text-[var(--muted-foreground)]">{e.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
              {dialog.kind === 'confirm' ? (
                <>
                  <button onClick={close} className={button}>{t('settings.models.cancel')}</button>
                  <button onClick={() => sync(true)} className="rounded bg-[var(--primary)] px-2 py-0.5 text-[11px] text-[var(--primary-foreground)] hover:opacity-90">
                    {t('settings.models.install')}
                  </button>
                </>
              ) : (
                <button onClick={close} className={button}>{t('settings.models.close')}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

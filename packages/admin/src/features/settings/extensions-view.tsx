'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Upload, Trash2, AlertTriangle, ToggleLeft, ToggleRight, RefreshCw, ArrowUpCircle } from 'lucide-react'
import type { ExtensionUpdateEntry, ExtensionsUpdateStatus } from '@turmind/halo-core/protocol'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { useI18n } from '@/shared/i18n'
import { cn, confirmAction } from '@/shared/utils'
import { getExtensionsSnapshot, platformLabels, runsHere, subscribe } from '@/features/editor/previews/registry'
import { newerStatus } from './update-status'

/**
 * Settings → Extensions: the installed canvas preview extensions
 * (~/.halo/global/extensions/), upload a zip, switch on / off, uninstall.
 * The list is the preview registry's snapshot — seeded on page load and
 * pushed on every `extension:changed` — so install / switch / remove here
 * never re-fetch: the server broadcasts and the row changes on its own.
 * Switched-off extensions are listed (dimmed, "Off") among the others by id
 * — this is the only place they show. Directories the scanner refused show
 * as red rows so they can still be removed.
 *
 * Updates: mounting asks `GET /updates?scope=extensions` (the server answers
 * from its 24 h cache and checks only when stale); 检查更新 forces one (60 s
 * server cooldown). Results arrive as `updates:changed` — no polling. Each
 * row shows its verdict; 更新 asks the server to install what update.json
 * names (it re-reads and re-judges, the client sends nothing but the id).
 */
export function ExtensionsView() {
  const { t } = useI18n()
  const snapshot = useSyncExternalStore(subscribe, getExtensionsSnapshot, getExtensionsSnapshot)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updates, setUpdates] = useState<ExtensionsUpdateStatus | null>(null)

  useEffect(() => {
    const off = wsClient.on('updates:changed', (frame) => { if (frame.scope === 'extensions') setUpdates((prev) => newerStatus(prev, frame.status)) })
    api.updates.extensions()
      .then((next) => setUpdates((prev) => newerStatus(prev, next)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    return off
  }, [])

  function handleCheck() {
    setError(null)
    api.updates.checkExtensions()
      .then((next) => setUpdates((prev) => newerStatus(prev, next)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  async function handleUpdate(id: string) {
    setBusy(true)
    setError(null)
    try {
      await api.extensions.update(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

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

  async function handleSetEnabled(id: string, enabled: boolean) {
    setBusy(true)
    setError(null)
    try {
      await api.extensions.setEnabled(id, enabled)
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

  // On and off in one id-sorted list, each with its update verdict — only one
  // judged against the version shown (the `extension:changed` push of an
  // update lands just before the re-judged `updates:changed`).
  const rows = useMemo(() => {
    const updateOf = new Map((updates?.extensions ?? []).map((u) => [`${u.id}@${u.installed}`, u]))
    return [
      ...snapshot.extensions.map((ext) => ({ ext, off: false })),
      ...snapshot.disabled.map((ext) => ({ ext, off: true })),
    ].sort((a, b) => a.ext.id.localeCompare(b.ext.id)).map((r) => ({ ...r, update: updateOf.get(`${r.ext.id}@${r.ext.version}`) }))
  }, [snapshot, updates])
  const empty = rows.length === 0 && snapshot.errors.length === 0
  const checking = updates?.checking ?? false
  // Header verdict after "Last checked", from the same version-matched
  // entries the rows show: N available, or all current; anything else
  // (unknown, not-found, unreachable, needs-halo…) says nothing — those rows
  // carry their own grey line, and "all up to date" would mislead.
  const available = rows.filter((r) => r.update?.state === 'available').length
  const summary = checking ? null
    : available > 0 ? t(available === 1 ? 'settings.extensions.updateAvailable' : 'settings.extensions.updatesAvailable', { n: available })
    : rows.length > 0 && rows.every((r) => r.update?.state === 'current') ? t('settings.extensions.allCurrent')
    : null
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
        <div className="flex shrink-0 items-center gap-2">
          {updates?.checkedAt != null && (
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {t('settings.extensions.lastChecked', { time: new Date(updates.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) })}
              {summary && ` · ${summary}`}
            </span>
          )}
          <button
            onClick={handleCheck}
            disabled={checking}
            className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--secondary)] disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
            {checking ? t('settings.update.checking') : t('settings.update.check')}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="flex shrink-0 items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90 disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            {busy ? t('settings.extensions.working') : t('settings.extensions.upload')}
          </button>
        </div>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      {empty ? (
        <p className="text-xs text-[var(--muted-foreground)]">{t('settings.extensions.empty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)]">
          {rows.map(({ ext, off, update }) => (
            <li key={ext.id} className="flex items-center gap-3 px-3 py-2">
              <div className={cn('min-w-0 flex-1', off && 'opacity-50')}>
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-medium text-[var(--foreground)]">{ext.name}</span>
                  <code className="text-[10px] text-[var(--muted-foreground)]">{ext.id}@{ext.version}</code>
                  {off && (
                    <span className="shrink-0 rounded bg-[var(--secondary)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                      {t('settings.extensions.off')}
                    </span>
                  )}
                  {ext.platforms && (
                    <span className="shrink-0 rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                      {platformLabels(ext.platforms, t)}
                    </span>
                  )}
                  {ext.activity && (
                    <span className="shrink-0 rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                      {t('settings.extensions.activity')}
                    </span>
                  )}
                  {ext.chatbar && (
                    <span className="shrink-0 rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                      {t('settings.extensions.chatbar')}
                    </span>
                  )}
                  {!runsHere(ext) && (
                    <span className="shrink-0 rounded bg-[var(--secondary)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                      {t('settings.extensions.unsupportedHere')}
                    </span>
                  )}
                </div>
                {/* An activity / chat-bar-only extension opens no files: no suffix line
                    (its description, if any, still shows). */}
                {ext.extensions.length > 0 ? (
                  <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">
                    {ext.extensions.join(' ')}
                    {ext.priority === 'option' && ` · ${t('settings.extensions.optionOnly')}`}
                    {ext.bundle && ` · ${t('settings.extensions.bundle')}`}
                    {ext.capabilities.includes('save') && ` · ${t('settings.extensions.canSave')}`}
                    {ext.capabilities.includes('media') && ` · ${t('settings.extensions.media')}`}
                    {ext.capabilities.includes('fs-read') && ` · ${t('settings.extensions.fsRead')}`}
                    {ext.description && ` — ${ext.description}`}
                  </p>
                ) : ext.description && (
                  <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">{ext.description}</p>
                )}
                {update && <UpdateLine entry={update} />}
              </div>
              {update?.state === 'available' && (
                <button
                  onClick={() => handleUpdate(ext.id)}
                  disabled={busy}
                  className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[10px] text-blue-500 hover:bg-blue-500/10 disabled:opacity-50"
                >
                  <ArrowUpCircle className="h-3 w-3" />
                  {t('settings.extensions.update')}
                </button>
              )}
              <button
                role="switch"
                aria-checked={!off}
                onClick={() => handleSetEnabled(ext.id, off)}
                disabled={busy}
                title={t(off ? 'settings.extensions.enable' : 'settings.extensions.disable')}
                aria-label={t(off ? 'settings.extensions.enable' : 'settings.extensions.disable')}
                className="shrink-0 cursor-pointer rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] disabled:opacity-50"
              >
                {off ? <ToggleLeft className="h-4.5 w-4.5" /> : <ToggleRight className="h-4.5 w-4.5 text-blue-500" />}
              </button>
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

/** The row's update verdict. `current` and `unknown` say nothing. */
function UpdateLine({ entry }: { entry: ExtensionUpdateEntry }) {
  const { t } = useI18n()
  const muted = 'mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]'
  switch (entry.state) {
    case 'available':
      return <p className="mt-0.5 truncate text-[10px] text-blue-500">{t('settings.extensions.latest', { version: entry.latest ?? '' })}</p>
    case 'needs-halo':
      return <p className={muted}>{t('settings.extensions.needsHalo', { version: entry.latest ?? '', minHalo: entry.minHalo ?? '' })}</p>
    case 'not-found':
      return <p className={muted}>{t('settings.extensions.notFound')}</p>
    case 'no-source':
      return <p className={muted}>{t('settings.extensions.noSource')}</p>
    case 'invalid':
    case 'refused':
    case 'unreachable':
      return <p className={muted} title={entry.error}>{t(`settings.extensions.${entry.state}`, { error: entry.error ?? '' })}</p>
    default:
      return null
  }
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

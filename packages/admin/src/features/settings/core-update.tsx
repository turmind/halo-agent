'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Copy, Check } from 'lucide-react'
import type { CoreUpdateStatus } from '@turmind/halo-core/protocol'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { useI18n } from '@/shared/i18n'
import { currentPlatform } from '@/features/editor/previews/registry'

const UPGRADE_COMMAND = 'halo upgrade && halo server restart'
const RELEASES_URL = 'https://github.com/turmind/halo-agent/releases'

/**
 * Settings sidebar foot: "Halo v<version>" + 检查更新 — notify only, never
 * upgrades (design: .halo/docs/design/canvas-extensions.md).
 *
 * Mounting it (= opening Settings) asks `GET /updates?scope=core`; the server
 * answers from its 24 h cache and starts a check only when that is stale. The
 * button forces one (server-side 60 s cooldown). A started check reports
 * `checking`; its result arrives as `updates:changed` — no polling here.
 */
export function CoreUpdate({ version }: { version: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<CoreUpdateStatus | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const off = wsClient.on('updates:changed', (frame) => { if (frame.scope === 'core') setStatus(frame.status) })
    api.updates.core()
      .then(setStatus)
      .catch((err) => setRequestError(err instanceof Error ? err.message : String(err)))
    return off
  }, [])

  function check() {
    setRequestError(null)
    api.updates.checkCore()
      .then(setStatus)
      .catch((err) => setRequestError(err instanceof Error ? err.message : String(err)))
  }

  function copy() {
    navigator.clipboard.writeText(UPGRADE_COMMAND).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }).catch(() => {})
  }

  const checking = status?.checking ?? false
  const desktop = currentPlatform() !== 'web'
  const error = requestError ?? (status?.state === 'error' ? status.error ?? '' : null)

  return (
    <div className="shrink-0 space-y-1 border-t border-[var(--border)] px-3 py-2 text-[10px] text-[var(--muted-foreground)]">
      <div className="flex items-center gap-2">
        <span className="truncate">Halo v{version}</span>
        <div className="flex-1" />
        {status?.state !== 'dev' && (
          <button
            onClick={check}
            disabled={checking}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
            {checking ? t('settings.update.checking') : t('settings.update.check')}
          </button>
        )}
      </div>

      {status?.state === 'dev' && <p>{t('settings.update.dev')}</p>}

      {status?.state === 'current' && status.latest && <p>{t('settings.update.current', { version: status.latest })}</p>}

      {status?.state === 'available' && status.latest && (
        <div className="space-y-1">
          <p className="font-medium text-[var(--foreground)]">{t('settings.update.available', { version: status.latest })}</p>
          {desktop ? (
            <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="text-[var(--primary)] hover:underline">
              {t('settings.update.download')}
            </a>
          ) : (
            <>
              <div className="flex items-center gap-1 rounded bg-[var(--secondary)] px-1.5 py-1">
                <code className="min-w-0 flex-1 truncate text-[var(--foreground)]">{UPGRADE_COMMAND}</code>
                <button onClick={copy} title={t('settings.update.copy')} className="shrink-0 hover:text-[var(--foreground)]">
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
              <p>{t('settings.update.sudoHint')}</p>
              <a href={`${RELEASES_URL}/tag/v${status.latest}`} target="_blank" rel="noreferrer" className="text-[var(--primary)] hover:underline">
                {t('settings.update.notes')}
              </a>
            </>
          )}
        </div>
      )}

      {error !== null && <p className="truncate" title={error}>{t('settings.update.error', { error })}</p>}
    </div>
  )
}

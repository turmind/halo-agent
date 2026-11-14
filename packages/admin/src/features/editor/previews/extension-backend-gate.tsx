'use client'

import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { ShieldAlert } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useI18n } from '@/shared/i18n'
import { openSettingsSection } from '@/features/settings/settings-nav'

/**
 * The admin half of the backend confirmation gate (server
 * extensions/backend.ts is the other): none of an extension's pages — file
 * preview, activity page, chat-bar panel — is loaded while its manifest
 * `backend` is unconfirmed. Its iframe would run same-origin with the admin
 * cookie and could POST its own confirm-backend; not loading it is what keeps
 * the confirmation the admin's. The host renders this notice in its place,
 * with a way to Settings → Extensions. Icons (activity bar, chat bar) still
 * show: they are CSS masks over the image, no script runs.
 *
 * Checked when a host (re)loads its iframe: one already running stays until
 * it reloads (it was confirmed when it loaded).
 */
export function backendPending(info: ExtensionInfo): boolean {
  return !!info.backend && info.backend.confirmed !== true
}

export function BackendPendingNotice({ info, compact = false }: { info: ExtensionInfo; compact?: boolean }) {
  const { t } = useI18n()
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center overflow-auto text-center', compact ? 'gap-2 p-2' : 'gap-3 p-8')}>
      <ShieldAlert className={cn('shrink-0 text-amber-500', compact ? 'h-4 w-4' : 'h-6 w-6')} />
      <p className={cn('text-[var(--foreground)]', compact ? 'text-xs' : 'text-sm')}>{t('editor.extension.backendPending', { name: info.name })}</p>
      <button
        onClick={() => openSettingsSection('__extensions')}
        className="inline-flex items-center rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90"
      >
        {t('editor.extension.openExtensionSettings')}
      </button>
    </div>
  )
}

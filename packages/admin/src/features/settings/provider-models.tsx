'use client'

import { useState } from 'react'
import { AudioLines, Brain, Check, ChevronRight, Copy, Image as ImageIcon, MapPin, Video, Zap } from 'lucide-react'
import type { api } from '@/shared/api-client'
import { useI18n } from '@/shared/i18n'
import { cn } from '@/shared/utils'
import { formatTokens, modelEndpointChips } from './model-browse'

type Provider = Awaited<ReturnType<typeof api.agentConfigs.models>>['providers'][number]
type Model = Provider['models'][number]

const CHIP = 'inline-flex items-center gap-1 rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[10px] text-[var(--foreground)]/80'

/** `low / medium / high` with the default one emphasized (only when there is a choice). */
function Presets({ presets, value }: { presets: Array<{ value: string }> | undefined; value?: string }) {
  const list = presets ?? []
  return (
    <span>
      {list.map((p, i) => (
        <span key={p.value}>
          {i > 0 && ' / '}
          <span className={cn(list.length > 1 && p.value === value && 'font-semibold text-[var(--primary)]')}>{p.value}</span>
        </span>
      ))}
    </span>
  )
}

/**
 * Settings → a model provider's page, below its credentials: read-only view of
 * the provider config in effect (`/agent-configs/models`, bundled or hub copy
 * merged by revision) — one card per model with context / output size,
 * capabilities and the endpoints (AWS region or host) it is served on.
 * Re-fetched by the parent on `models:changed`.
 */
export function ProviderModels({ provider }: { provider: Provider }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  const defaultId = provider.defaultModelId ?? provider.models[0]?.id
  const defaultModel = provider.models.find((m) => m.id === defaultId)
  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {t('settings.models.title')}
        <span className="rounded bg-[var(--card)] px-1 py-0 text-[9px] font-normal normal-case">{provider.models.length}</span>
      </button>
      {open && (
        <>
          <p className="text-[10px] text-[var(--muted-foreground)]">
            {provider.runtime && <>{t('settings.models.runtime')}: <code className="text-[var(--foreground)]">{provider.runtime}</code></>}
            {provider.revision != null && <>{' · '}{t('settings.models.revision')}: <code className="text-[var(--foreground)]">{provider.revision}</code></>}
            {defaultModel && <>{' · '}{t('settings.models.defaultModel')}: <span className="text-[var(--foreground)]">{defaultModel.displayName ?? defaultModel.id}</span></>}
          </p>
          <p className="text-[10px] text-[var(--muted-foreground)]">{t('settings.models.readonlyHint')}</p>
          <div className="space-y-2">
            {provider.models.map((m) => <ModelCard key={m.id} provider={provider} model={m} isDefault={m.id === defaultId} />)}
          </div>
        </>
      )}
    </div>
  )
}

function ModelCard({ provider, model, isDefault }: { provider: Provider; model: Model; isDefault: boolean }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const caps = model.capabilities ?? {}
  const chips = modelEndpointChips(provider, model)
  const thinking = caps.thinking
  const copy = () => {
    navigator.clipboard.writeText(model.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  const context = model.contextWindow != null
    ? model.maxContextWindow != null && model.maxContextWindow !== model.contextWindow
      ? t('settings.models.contextMax', { value: formatTokens(model.contextWindow), max: formatTokens(model.maxContextWindow) })
      : t('settings.models.context', { value: formatTokens(model.contextWindow) })
    : null
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-medium text-[var(--foreground)]">{model.displayName ?? model.id}</span>
        {isDefault && (
          <span className="rounded bg-[var(--primary)]/20 px-1.5 py-px text-[9px] font-medium text-[var(--primary)]">{t('settings.models.default')}</span>
        )}
        <span className="ml-auto flex flex-wrap gap-x-3 text-[10px] text-[var(--muted-foreground)]">
          {context && (
            <span title={model.compressAt != null ? t('settings.models.compressAt', { pct: `${Math.round(model.compressAt * 100)}%` }) : undefined}>
              {context}
            </span>
          )}
          {model.maxOutputTokens != null && <span>{t('settings.models.output', { value: formatTokens(model.maxOutputTokens) })}</span>}
        </span>
      </div>
      <button
        onClick={copy}
        title={t('settings.models.copyId')}
        className="mt-0.5 flex max-w-full cursor-pointer items-center gap-1 font-mono text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <span className="truncate">{model.id}</span>
        {copied ? <Check className="h-2.5 w-2.5 shrink-0" /> : <Copy className="h-2.5 w-2.5 shrink-0" />}
      </button>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {caps.image && <span className={CHIP}><ImageIcon className="h-2.5 w-2.5" />{t('settings.models.cap.image')}</span>}
        {caps.video && <span className={CHIP}><Video className="h-2.5 w-2.5" />{t('settings.models.cap.video')}</span>}
        {caps.audio && <span className={CHIP}><AudioLines className="h-2.5 w-2.5" />{t('settings.models.cap.audio')}</span>}
        {!caps.image && !caps.video && !caps.audio && <span className={CHIP}>{t('settings.models.cap.textOnly')}</span>}
        {thinking && (
          <span className={CHIP} title={thinking.mode !== 'manual' && thinking.default ? t('settings.models.cap.defaultValue', { value: thinking.default }) : undefined}>
            <Brain className="h-2.5 w-2.5" />
            {thinking.mode === 'manual'
              ? t('settings.models.cap.thinkingBudget', { budget: formatTokens(thinking.defaultBudgetTokens ?? 8192) })
              : <>{t('settings.models.cap.thinking')} <Presets presets={thinking.effortPresets} value={thinking.default} /></>}
            {thinking.defaultEnabled && <span className="text-[var(--muted-foreground)]">· {t('settings.models.cap.onByDefault')}</span>}
          </span>
        )}
        {caps.promptCaching && (
          <span className={CHIP} title={caps.promptCaching.default ? t('settings.models.cap.defaultValue', { value: caps.promptCaching.default }) : undefined}>
            <Zap className="h-2.5 w-2.5" />
            {t('settings.models.cap.cache')} <Presets presets={caps.promptCaching.ttlPresets} value={caps.promptCaching.default} />
          </span>
        )}
        {caps.verbosity && (
          <span className={CHIP} title={caps.verbosity.default ? t('settings.models.cap.defaultValue', { value: caps.verbosity.default }) : undefined}>
            {t('settings.models.cap.verbosity')} <Presets presets={caps.verbosity.presets} value={caps.verbosity.default} />
          </span>
        )}
      </div>

      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1" title={t('settings.models.endpoints')}>
          <MapPin className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
          {chips.map((c) => (
            <span
              key={c.label}
              title={`${c.isDefault ? `${t('settings.models.defaultEndpoint')}: ` : ''}${c.urls.join('\n')}`}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px]',
                !c.region && 'font-mono',
                c.isDefault
                  ? 'bg-[var(--primary)]/20 font-medium text-[var(--primary)]'
                  : 'bg-[var(--secondary)] text-[var(--foreground)]/80',
              )}
            >
              {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

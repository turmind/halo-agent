'use client'

import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { Combobox } from '@/shared/components/combobox'

const DEFAULT_CAPABILITIES: ModelEntry['capabilities'] = {
  // image/video/audio are intentionally undefined here (not false). The
  // form treats `undefined` as "user gets to pick" (renders editable
  // checkboxes); a manifest with image:false treats it as "locked off".
  promptCaching: { ttlPresets: [{ value: '5m', label: '5min' }, { value: '1h', label: '1hour' }] },
  thinking: { effortPresets: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }] },
  // Custom / unlisted models get the full set of knobs (same philosophy as the
  // modality toggles below — custom = user's responsibility, maximum
  // flexibility). No `default` so an untouched control stays unset and writes
  // nothing; the user opts in. Listed models instead use their own yaml
  // `capabilities.verbosity` (with its verified default).
  verbosity: { presets: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
}

/**
 * Compute thinking + promptCaching values for a model, given the previous
 * model config. Three rules:
 *   - Drop fields the new model doesn't declare (e.g. switching to a provider
 *     without ttlPresets clears any stale promptCaching).
 *   - Carry over the user's previous value when it's still valid for the new
 *     model (so flipping models doesn't reset their choice).
 *   - Otherwise apply the new model's yaml-declared default
 *     (`promptCaching.default`, `thinking.default`, `thinking.defaultEnabled`,
 *     `thinking.defaultBudgetTokens`), falling back to the first preset.
 *
 * Used by both the provider switch and the model id switch — the migration
 * rules don't depend on which axis the user changed.
 */
function buildCapabilityDefaults(
  newModel: ModelEntry | undefined,
  prev: Record<string, unknown>,
): { thinking?: Record<string, unknown>; promptCaching?: string | boolean; verbosity?: string } {
  const caps = newModel?.capabilities
  const result: { thinking?: Record<string, unknown>; promptCaching?: string | boolean; verbosity?: string } = {}

  // Thinking
  //   - User had it on → keep it on, migrate effort/budget to new model's vocabulary
  //   - User had it off → respect that, even if new model declares `defaultEnabled: true`
  //     (defaultEnabled is for *new* agents, not for switching an existing one)
  //   - Field absent (never touched) → use new model's defaultEnabled
  const thinkingCap = caps?.thinking
  const prevThinking = prev.thinking as Record<string, unknown> | undefined
  if (thinkingCap || prevThinking) {
    const mode = thinkingCap?.mode ?? 'adaptive'
    const enabled = prevThinking
      ? !!prevThinking.enabled
      : !!thinkingCap?.defaultEnabled
    if (enabled) {
      if (mode === 'manual') {
        const oldBudget = prevThinking?.budget_tokens as number | undefined
        const budget = oldBudget ?? thinkingCap?.defaultBudgetTokens ?? 8192
        result.thinking = { enabled: true, budget_tokens: budget }
      } else {
        const presets = thinkingCap?.effortPresets
        const oldEffort = (prevThinking?.effort ?? prevThinking?.budget) as string | undefined
        const stillValid = oldEffort && presets?.some((p) => p.value === oldEffort)
        const defaultEffort = thinkingCap?.default ?? presets?.[0]?.value ?? 'medium'
        result.thinking = { enabled: true, effort: stillValid ? oldEffort : defaultEffort }
      }
    } else {
      result.thinking = undefined
    }
  }

  // Prompt caching
  //   - Provider doesn't expose it (no ttlPresets) → clear (DeepSeek/Kimi).
  //   - User had a value valid on the new model → keep it.
  //   - User had a value the new model doesn't support → user wants caching,
  //     migrate to the new model's default ttl.
  //   - User had nothing → respect new model's `defaultEnabled` (default true,
  //     since caching is almost always a win for agent runs).
  const cachingCap = caps?.promptCaching
  const ttlPresets = cachingCap?.ttlPresets
  if (!ttlPresets?.length) {
    result.promptCaching = undefined
  } else {
    const prevCaching = prev.promptCaching
    const oldVal = typeof prevCaching === 'string' ? prevCaching : undefined
    const stillValid = oldVal && ttlPresets.some((p) => p.value === oldVal)
    if (stillValid) {
      result.promptCaching = oldVal
    } else if (oldVal) {
      // User had it on, just on an unsupported ttl — migrate to new default.
      result.promptCaching = cachingCap?.default ?? ttlPresets[0].value
    } else {
      const enabled = cachingCap?.defaultEnabled ?? true
      result.promptCaching = enabled ? (cachingCap?.default ?? ttlPresets[0].value) : undefined
    }
  }

  // Verbosity (OpenAI Responses output length).
  //   - Model doesn't declare verbosity → clear (control hidden).
  //   - Model declares it: default-CHECKED reflects whether the model "has" the
  //     param — i.e. the registry provides a `default`. Keep the user's prior
  //     value if still valid; else seed the registry default; if the registry
  //     has presets but no default, leave unset (custom models — user opts in).
  const verbosityCap = caps?.verbosity
  const vPresets = verbosityCap?.presets
  const oldV = typeof prev.verbosity === 'string' ? prev.verbosity : undefined
  if (!vPresets?.length) {
    result.verbosity = undefined
  } else if (oldV && vPresets.some((p) => p.value === oldV)) {
    result.verbosity = oldV
  } else {
    result.verbosity = verbosityCap?.default ?? undefined
  }

  return result
}

const INPUT_CLS = 'h-7 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]'
const SELECT_CLS = 'h-7 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)] appearance-none cursor-pointer'
const LABEL_CLS = 'text-[11px] font-medium text-[var(--foreground)]'
const DESC_CLS = 'text-[10px] text-[var(--muted-foreground)]'

/**
 * One capability row: a checkbox that enables/disables the capability, plus an
 * editable dropdown (Combobox) for its value when enabled. Unchecking calls
 * `onChange(undefined)` — the caller removes the field from agent.yaml, so an
 * unchecked capability is simply not sent. Used for prompt caching / verbosity /
 * thinking-effort so they all behave identically.
 *
 * `enabled` = whether the field is present (checkbox state).
 * `value`   = current value shown in the dropdown (caller resolves the default).
 * `onChange(v)` — `v=string` writes that value; `v=undefined` removes the field.
 */
function CapabilityControl({
  label, enabled, value, defaultValue, presets, onChange,
}: {
  label: string
  enabled: boolean
  value: string
  defaultValue: string
  presets: Array<{ value: string; label: string }>
  onChange: (next: string | undefined) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? (value || defaultValue) : undefined)}
          className="rounded border-[var(--border)] bg-[var(--card)] text-[var(--primary)] focus:ring-[var(--primary)] h-3.5 w-3.5 cursor-pointer"
        />
        <span className={LABEL_CLS}>{label}</span>
      </label>
      {enabled && (
        <Combobox
          value={value || defaultValue}
          presets={presets.map((p) => ({ id: p.value, label: p.label }))}
          onCommit={(next) => onChange(next || undefined)}
          minWidth={110}
          className="h-7"
        />
      )}
    </div>
  )
}

type ModelEntry = {
  id: string
  displayName?: string
  maxOutputTokens?: number
  capabilities?: {
    image?: boolean
    video?: boolean
    audio?: boolean
    promptCaching?: {
      /** Whether prompt caching is auto-on for new agents on this model. Default: true. */
      defaultEnabled?: boolean
      /** Auto-on ttl value (must match a preset). Falls back to first preset. */
      default?: string
      ttlPresets?: Array<{ value: string; label: string }>
    }
    thinking?: {
      /** 'adaptive' = effort dropdown; 'manual' = budget number input.
       *  Missing → defaults to 'adaptive' (Sonnet/Opus 4.6+ behaviour). */
      mode?: 'adaptive' | 'manual'
      /** Whether thinking is auto-on for new agents on this model. Default: false (thinking is paid). */
      defaultEnabled?: boolean
      /** Effort selected when user toggles thinking on (adaptive mode). Falls back to first preset. */
      default?: string
      /** Budget tokens used when thinking is toggled on (manual mode). Defaults to 8192. */
      defaultBudgetTokens?: number
      effortPresets?: Array<{ value: string; label: string }>
    }
    /** Output length for the final answer (OpenAI Responses `text.verbosity`).
     *  Distinct from thinking effort. Only declared by the Mantle provider. */
    verbosity?: {
      /** Selected when none set on the agent. Falls back to first preset. */
      default?: string
      presets?: Array<{ value: string; label: string }>
    }
  }
}
type ProviderEntry = {
  id: string
  displayName?: string
  description?: string
  defaultEndpoint?: string
  endpointPresets?: string[]
  /** Default model id for this provider — used when the user switches to it.
   *  Falls back to `models[0].id` if absent. */
  defaultModelId?: string
  models: ModelEntry[]
}
type ModelsRegistry = { providers: ProviderEntry[] } | null

/** Data-driven form: renders from parsed YAML object */
export function AgentForm({
  data, availableSkills, availableTools, allAgents, selfId, modelsRegistry, onUpdate, onUpdateNested, onToggleArrayItem,
}: {
  data: Record<string, unknown>
  availableSkills: Array<{ id: string; name: string; description: string; scope: string; disabled?: boolean }>
  availableTools: Array<{ name: string; description: string }>
  /** All delegatable agents in the workspace — feeds the Team whitelist picker.
   *  Excludes internal agents (they're never delegation targets). */
  allAgents: Array<{ id: string; name: string }>
  /** This agent's own id — pinned in the Team picker as "(self, always allowed)". */
  selfId: string
  modelsRegistry: ModelsRegistry
  onUpdate: (key: string, value: unknown) => void
  onUpdateNested: (parentKey: string, childKey: string, value: unknown) => void
  onToggleArrayItem: (key: string, item: string) => void
}) {
  const t = useT()
  const model = (data.model ?? {}) as Record<string, unknown>
  const context = (data.context ?? {}) as Record<string, string | number>
  const skills = Array.isArray(data.skills) ? (data.skills as string[]) : []
  const tools = Array.isArray(data.tools) ? (data.tools as string[]) : []
  // `team` whitelist: absent = all agents (default). The picker shows all
  // candidates checked when absent; unchecking writes an explicit list.
  const team = Array.isArray(data.team) ? (data.team as string[]) : undefined
  const canDelegate = tools.includes('start_session')

  // Flatten all models from registry for lookup
  const allModels: ModelEntry[] = modelsRegistry?.providers?.flatMap((p) => p.models) ?? []
  const selectedModelId = String(model.id ?? '')
  const selectedModel = allModels.find((m) => m.id === selectedModelId)

  return (
    <div className="h-full overflow-y-auto p-5 space-y-5">
      {/* Basic */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{t('agent.basic')}</h3>
        <div className="grid grid-cols-[1fr_1fr_80px] gap-4">
          <div>
            <label className={LABEL_CLS}>{t('agent.name')}</label>
            <input value={String(data.name ?? '')} onChange={(e) => onUpdate('name', e.target.value)} className={cn(INPUT_CLS, 'mt-1')} />
          </div>
          <div>
            <label className={LABEL_CLS}>{t('agent.description')}</label>
            <input value={String(data.description ?? '')} onChange={(e) => onUpdate('description', e.target.value)} className={cn(INPUT_CLS, 'mt-1')} />
          </div>
          <div>
            <label className={LABEL_CLS}>{t('agent.priority')}</label>
            <input
              type="number"
              value={data.priority != null ? String(data.priority) : ''}
              onChange={(e) => onUpdate('priority', e.target.value ? Number(e.target.value) : undefined)}
              className={cn(INPUT_CLS, 'mt-1')}
              placeholder="0"
            />
          </div>
        </div>
      </section>

      {/* Model */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{t('agent.model')}</h3>
        <div className="grid grid-cols-4 gap-4">
          {/* Provider — dropdown scoped by models registry */}
          <div>
            <label className={LABEL_CLS}>{t('agent.provider')}</label>
            {modelsRegistry && modelsRegistry.providers.length > 0 ? (
              <select
                value={String(model.provider ?? (modelsRegistry.providers[0]?.id ?? ''))}
                onChange={(e) => {
                  const newProvider = modelsRegistry.providers.find((p) => p.id === e.target.value)
                  // Pick the model to land on:
                  //   yaml `defaultModelId` > existing-id-still-valid > first model
                  // The "still valid" path lets you flip back and forth between
                  // providers without losing your model choice (when both have
                  // the same id, e.g. moving from a forked provider config).
                  const oldId = String(model.id ?? '')
                  const idStillValid = newProvider?.models.some((m) => m.id === oldId)
                  const newModel = newProvider?.models.find((m) => m.id === newProvider.defaultModelId)
                    ?? (idStillValid ? newProvider!.models.find((m) => m.id === oldId) : undefined)
                    ?? newProvider?.models[0]

                  onUpdate('model', {
                    ...model,
                    provider: e.target.value,
                    id: newModel?.id ?? '',
                    endpoint: newProvider?.defaultEndpoint ?? '',
                    ...buildCapabilityDefaults(newModel, model),
                  })
                }}
                className={cn(SELECT_CLS, 'mt-1')}
              >
                {modelsRegistry.providers.map((p) => (
                  <option key={p.id} value={p.id} title={p.description}>
                    {p.displayName ?? p.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={String(model.provider ?? '')}
                onChange={(e) => onUpdateNested('model', 'provider', e.target.value)}
                className={cn(INPUT_CLS, 'mt-1')}
              />
            )}
          </div>
          {/* Model ID — combobox (input + datalist) */}
          <div>
            <label className={LABEL_CLS}>{t('agent.modelId')}</label>
            {(() => {
              const selectedProviderId = String(model.provider ?? (modelsRegistry?.providers[0]?.id ?? ''))
              const providerModels = modelsRegistry?.providers.find((p) => p.id === selectedProviderId)?.models ?? []
              // When switching models within the same provider, run the same
              // capability migration as the provider switch — keeps the
              // thinking effort / caching ttl valid for the new model and
              // applies the new model's yaml defaults if previous values
              // don't fit.
              function changeModelId(nextId: string) {
                const nextEntry = providerModels.find((m) => m.id === nextId)
                onUpdate('model', { ...model, id: nextId, ...buildCapabilityDefaults(nextEntry, model) })
              }
              return (
                <Combobox
                  value={selectedModelId}
                  presets={providerModels.map((m) => ({ id: m.id, label: m.displayName ?? m.id }))}
                  placeholder="model id"
                  onCommit={(next) => changeModelId(next)}
                  className="mt-1"
                />
              )
            })()}
          </div>
          {/* Endpoint — combobox (input + datalist) */}
          {(() => {
            const selectedProviderId2 = String(model.provider ?? (modelsRegistry?.providers[0]?.id ?? ''))
            const selectedProvider = modelsRegistry?.providers.find((p) => p.id === selectedProviderId2)
            const defaultEp = selectedProvider?.defaultEndpoint ?? ''
            const epPresets = selectedProvider?.endpointPresets
            return (
              <div>
                <label className={LABEL_CLS}>{t('agent.endpoint')}</label>
                <Combobox
                  value={String(model.endpoint ?? '')}
                  presets={(epPresets ?? []).map((ep) => ({ id: ep, label: ep }))}
                  placeholder={defaultEp || 'https://...'}
                  onCommit={(next) => onUpdateNested('model', 'endpoint', next)}
                  className="mt-1"
                />
                {defaultEp && !model.endpoint && (
                  <p className={cn(DESC_CLS, 'mt-0.5')}>Default: {defaultEp}</p>
                )}
              </div>
            )
          })()}
          <div>
            <label className={LABEL_CLS}>{t('agent.maxTokens')}</label>
            <input
              type="number"
              value={model.maxTokens != null ? String(model.maxTokens) : ''}
              onChange={(e) => onUpdateNested('model', 'maxTokens', e.target.value ? Number(e.target.value) : undefined)}
              className={cn(INPUT_CLS, 'mt-1')}
              placeholder={selectedModel?.maxOutputTokens ? String(selectedModel.maxOutputTokens) : 'auto'}
            />
            <p className={cn(DESC_CLS, 'mt-0.5')}>
              {selectedModel?.maxOutputTokens
                ? t('agent.maxTokensDefault', { max: selectedModel.maxOutputTokens.toLocaleString() })
                : t('agent.maxTokensAuto')}
            </p>
          </div>
        </div>

        {/* Capabilities — from registry match, or fallback defaults for unknown models */}
        {(() => {
          const caps = selectedModel?.capabilities ?? (selectedModelId ? DEFAULT_CAPABILITIES : null)
          if (!caps) return null
          const ttlPresets = caps.promptCaching?.ttlPresets
          const effortPresets = caps.thinking?.effortPresets
          return (
            <div className="flex flex-wrap gap-6 pt-1">
              {/* Prompt Caching — checkbox + editable dropdown. Unchecking removes
                  the field (not sent). Default value from registry. */}
              {ttlPresets && (
                <CapabilityControl
                  label="Prompt Caching"
                  enabled={!!model.promptCaching}
                  value={typeof model.promptCaching === 'string' ? model.promptCaching : ''}
                  defaultValue={caps.promptCaching?.default ?? ttlPresets[0].value}
                  presets={ttlPresets}
                  onChange={(v) => onUpdateNested('model', 'promptCaching', v)}
                />
              )}
              {/* Verbosity — final-answer length (OpenAI Responses `text.verbosity`),
                  distinct from thinking effort. Shown when the model declares it
                  (registry) or for custom models (DEFAULT_CAPABILITIES). Unchecking
                  removes the field so nothing is sent (server falls back to default). */}
              {caps.verbosity?.presets?.length && (
                <CapabilityControl
                  label="Verbosity"
                  enabled={typeof model.verbosity === 'string'}
                  value={typeof model.verbosity === 'string' ? model.verbosity : ''}
                  defaultValue={caps.verbosity.default ?? caps.verbosity.presets[0].value}
                  presets={caps.verbosity.presets}
                  onChange={(v) => onUpdateNested('model', 'verbosity', v)}
                />
              )}
              {/* Modality flags. For manifest-listed models the registry
                  decides — render as read-only badges. For custom model
                  ids (no manifest entry) the user picks — render as
                  checkboxes that write `model.image/video/audio` into
                  agent.yaml so the runtime can override registry. */}
              {(() => {
                const isCustomModel = !selectedModel && selectedModelId !== ''
                const userImage = (model.image as boolean | undefined)
                const userVideo = (model.video as boolean | undefined)
                const userAudio = (model.audio as boolean | undefined)
                if (isCustomModel) {
                  // Click-to-toggle pills (highlighted when on) — same visual
                  // language as the read-only preset badges below, just interactive.
                  const Toggle = ({ field, label, value }: { field: 'image'|'video'|'audio'; label: string; value: boolean | undefined }) => (
                    <button
                      type="button"
                      onClick={() => onUpdateNested('model', field, !value || undefined)}
                      className={cn(
                        'rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer',
                        value
                          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                          : 'bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
                      )}
                    >
                      {label}
                    </button>
                  )
                  return (
                    <div className="flex items-center gap-1">
                      <Toggle field="image" label="Image" value={userImage} />
                      <Toggle field="video" label="Video" value={userVideo} />
                      <Toggle field="audio" label="Audio" value={userAudio} />
                    </div>
                  )
                }
                if (caps.image === undefined && caps.video === undefined && caps.audio === undefined) return null
                return (
                  <div className="flex items-center gap-1">
                    {caps.image !== undefined && (
                      <span className={cn('rounded px-2 py-0.5 text-[10px] font-medium', caps.image ? 'bg-emerald-500/15 text-emerald-600' : 'bg-[var(--secondary)] text-[var(--muted-foreground)]')}>
                        Image
                      </span>
                    )}
                    {caps.video !== undefined && (
                      <span className={cn('rounded px-2 py-0.5 text-[10px] font-medium', caps.video ? 'bg-emerald-500/15 text-emerald-600' : 'bg-[var(--secondary)] text-[var(--muted-foreground)]')}>
                        Video
                      </span>
                    )}
                    {caps.audio !== undefined && (
                      <span className={cn('rounded px-2 py-0.5 text-[10px] font-medium', caps.audio ? 'bg-emerald-500/15 text-emerald-600' : 'bg-[var(--secondary)] text-[var(--muted-foreground)]')}>
                        Audio
                      </span>
                    )}
                  </div>
                )
              })()}
              {(effortPresets || caps.thinking) && (() => {
                const thinkingObj = model.thinking as Record<string, unknown> | undefined
                const enabled = !!thinkingObj?.enabled
                const isCustomModel = !selectedModel && selectedModelId !== ''
                // For known models, the manifest's `mode` decides effort vs budget UI.
                // For custom models, infer from current value: if budget_tokens is set,
                // show budget input; otherwise show effort buttons. User can flip via
                // the "use budget instead" / "use effort instead" link.
                const declaredMode = caps.thinking?.mode ?? 'adaptive'
                const effectiveMode: 'adaptive' | 'manual' = isCustomModel
                  ? (thinkingObj?.budget_tokens != null ? 'manual' : 'adaptive')
                  : declaredMode
                const defaultEffort = caps.thinking?.default ?? effortPresets?.[0]?.value ?? 'medium'
                const turnOnPayload: Record<string, unknown> = effectiveMode === 'manual'
                  ? { enabled: true, budget_tokens: 8192 }
                  : { enabled: true, effort: defaultEffort }
                return (
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => {
                          onUpdateNested('model', 'thinking', e.target.checked ? turnOnPayload : undefined)
                        }}
                        className="rounded border-[var(--border)] bg-[var(--card)] text-[var(--primary)] focus:ring-[var(--primary)] h-3.5 w-3.5 cursor-pointer"
                      />
                      <span className={LABEL_CLS}>Thinking</span>
                    </label>
                    {enabled && effectiveMode === 'adaptive' && effortPresets && (
                      <Combobox
                        value={((thinkingObj?.effort ?? thinkingObj?.budget) as string | undefined) ?? defaultEffort}
                        presets={effortPresets.map((p) => ({ id: p.value, label: p.label }))}
                        onCommit={(next) => onUpdateNested('model', 'thinking', { enabled: true, effort: next })}
                        minWidth={110}
                        className="h-7"
                      />
                    )}
                    {enabled && effectiveMode === 'manual' && (
                      <div className="flex items-center gap-1.5">
                        <span className={DESC_CLS}>budget</span>
                        <input
                          type="number"
                          min={1024}
                          step={1024}
                          value={(thinkingObj?.budget_tokens as number | undefined) ?? 8192}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10)
                            if (Number.isFinite(n) && n > 0) {
                              onUpdateNested('model', 'thinking', { enabled: true, budget_tokens: n })
                            }
                          }}
                          className="h-6 w-24 rounded border border-[var(--border)] bg-[var(--card)] px-2 text-[10px] text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                        />
                        <span className={DESC_CLS}>tokens</span>
                      </div>
                    )}
                    {/* Custom-model only: let user flip between effort label and explicit budget. */}
                    {enabled && isCustomModel && (
                      <button
                        type="button"
                        onClick={() => {
                          if (effectiveMode === 'adaptive') {
                            onUpdateNested('model', 'thinking', { enabled: true, budget_tokens: 8192 })
                          } else {
                            onUpdateNested('model', 'thinking', { enabled: true, effort: defaultEffort })
                          }
                        }}
                        className="text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] underline cursor-pointer"
                      >
                        {effectiveMode === 'adaptive' ? 'use budget' : 'use effort'}
                      </button>
                    )}
                  </div>
                )
              })()}
            </div>
          )
        })()}

        {/* Context — lives under Model since maxTokens/compressAt scale with the model */}
        {Object.keys(context).length > 0 && (
          <div className="grid grid-cols-2 gap-4 pt-1">
            {Object.entries(context).map(([key, val]) => (
              <div key={key}>
                <label className={LABEL_CLS}>{`context.${key}`}</label>
                <input
                  type={typeof val === 'number' ? 'number' : 'text'}
                  step={typeof val === 'number' && val < 1 ? '0.1' : undefined}
                  value={String(val ?? '')}
                  onChange={(e) => onUpdateNested('context', key, typeof val === 'number' ? Number(e.target.value) : e.target.value)}
                  className={cn(INPUT_CLS, 'mt-1')}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* System Prompt (YAML fallback — AGENT.md is preferred) */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{t('agent.systemPrompt')}</h3>
          <span className="text-[9px] text-[var(--muted-foreground)] opacity-60">{t('agent.systemPromptHint')}</span>
        </div>
        <textarea
          value={String(data.system_prompt ?? '')}
          onChange={(e) => onUpdate('system_prompt', e.target.value)}
          rows={8}
          className="w-full rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--primary)] resize-y font-mono"
          placeholder={t('agent.systemPromptPlaceholder')}
        />
      </section>

      {/* Session Tools */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{t('agent.sessionTools')}</h3>
          <span className="text-[9px] text-[var(--muted-foreground)] opacity-60">{t('agent.sessionToolsHint')}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {([
            // Discover
            { name: 'query_agent', description: 'Inspect an agent\'s full config, AGENT.md, and skills' },
            // Create
            { name: 'start_session', description: 'Start a new sub-agent session (async; reports back when done)' },
            // Observe
            { name: 'session_list', description: 'List child sessions with running/idle status' },
            { name: 'get_session_output', description: 'Read a sub-agent session\'s full output text' },
            // Communicate
            { name: 'query_session', description: 'Send a message to another session (e.g. report to parent, ask follow-up)' },
            // Control lifecycle
            { name: 'interrupt_session', description: 'Interrupt a running session and re-run with a new message' },
            { name: 'stop_session', description: 'Abort the current task; the session stays usable via query_session' },
            { name: 'archive_session', description: 'Archive a session and all descendants; they no longer appear in session_list' },
          ]).map((t) => {
            const active = tools.includes(t.name)
            return (
              <button
                key={t.name}
                type="button"
                title={t.description}
                onClick={() => onToggleArrayItem('tools', t.name)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
                  active
                    ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                    : 'bg-[var(--secondary)] text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/80 hover:text-[var(--foreground)]',
                )}
              >
                {t.name}
              </button>
            )
          })}
        </div>
      </section>

      {/* Team whitelist — which agents this one may delegate to via
          start_session. Only meaningful when start_session is enabled.
          Default (no `team` field) = all agents checked. Unchecking writes an
          explicit list; re-checking everything drops the field back to default. */}
      {canDelegate && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{t('agent.team')}</h3>
            <span className="text-[9px] text-[var(--muted-foreground)] opacity-60">{t('agent.teamHint')}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {allAgents.map((a) => {
              const isSelf = a.id === selfId
              // Self is always allowed and not part of the stored list — render
              // it as a fixed, non-toggle chip so it's clear it can't be removed.
              const checked = isSelf || team === undefined || team.includes(a.id)
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={isSelf}
                  title={isSelf ? `${a.name} (self — always allowed)` : a.id}
                  onClick={() => {
                    if (isSelf) return
                    // Current effective whitelist (everyone when unset), then
                    // toggle this id. If the result is "all candidates", drop
                    // the field (back to default); else store the explicit list.
                    const candidateIds = allAgents.map((x) => x.id).filter((id) => id !== selfId)
                    const current = team === undefined ? candidateIds : candidateIds.filter((id) => team.includes(id))
                    const next = current.includes(a.id) ? current.filter((id) => id !== a.id) : [...current, a.id]
                    onUpdate('team', next.length === candidateIds.length ? undefined : next)
                  }}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    isSelf ? 'cursor-default opacity-70' : 'cursor-pointer',
                    checked
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                      : 'bg-[var(--secondary)] text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/80 hover:text-[var(--foreground)]',
                  )}
                >
                  {a.name}{isSelf ? ' (self)' : ''}
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* Tools */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Tools</h3>
        {availableTools.length === 0 ? (
          <p className={DESC_CLS}>{t('agent.loadingTools')}</p>
        ) : (() => {
          const availableNames = new Set(availableTools.map((t) => t.name))
          const SESSION_TOOL_NAMES = new Set([
            'query_agent', 'start_session', 'session_list',
            'get_session_output', 'query_session', 'interrupt_session',
            'stop_session', 'archive_session',
          ])
          const missingTools = tools.filter((name) => !availableNames.has(name) && !SESSION_TOOL_NAMES.has(name))
          // view_image is silently dropped at session-create time when the
          // model can't ingest vision blocks (capabilities.image !== true).
          // Surface that here: keep the toggle clickable (the user may still
          // be in the middle of switching models, and intent ≠ runtime), but
          // dim it and explain in the tooltip.
          // For custom model ids (no manifest entry) the user picks
          // image support via the form's image checkbox, written to
          // `model.image` in agent.yaml. That override wins over the
          // manifest. Without this override path, view_image would
          // always show as gated for any custom model id, regardless
          // of what the user just clicked.
          const userImageOverride = (model.image as boolean | undefined)
          const modelImageCap = userImageOverride ?? selectedModel?.capabilities?.image
          const visionGated = (name: string): boolean =>
            name === 'view_image' && selectedModelId !== '' && modelImageCap !== true
          return (
            <div className="flex flex-wrap gap-2">
              {availableTools.map((t) => {
                const active = tools.includes(t.name)
                const dimmed = visionGated(t.name)
                const tip = dimmed
                  ? `${t.description}\n\nNote: the selected model does not declare capabilities.image: true — view_image will be dropped from this agent's tool list at runtime.`
                  : t.description
                return (
                  <button
                    key={t.name}
                    type="button"
                    title={tip}
                    onClick={() => onToggleArrayItem('tools', t.name)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
                      active
                        ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                        : 'bg-[var(--secondary)] text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/80 hover:text-[var(--foreground)]',
                      dimmed && 'opacity-50',
                    )}
                  >
                    {t.name}{dimmed && <span className="ml-1">⊘</span>}
                  </button>
                )
              })}
              {missingTools.map((name) => (
                <button
                  key={`missing-${name}`}
                  type="button"
                  title={`Tool "${name}" is not available in this server. Click to remove from this agent.`}
                  onClick={() => onToggleArrayItem('tools', name)}
                  className="rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer border border-[var(--destructive)] bg-[var(--destructive)]/10 text-[var(--destructive)] hover:bg-[var(--destructive)]/20"
                >
                  ⚠ {name}
                </button>
              ))}
            </div>
          )
        })()}
      </section>

      {/* Skills */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Skills</h3>
        {(() => {
          const enabledSkills = availableSkills.filter((s) => !s.disabled)
          const availableIds = new Set(enabledSkills.map((s) => s.id))
          const missingSkills = skills.filter((id) => !availableIds.has(id))
          if (enabledSkills.length === 0 && missingSkills.length === 0) {
            return <p className={DESC_CLS}>{t('agent.noSkills')}</p>
          }
          return (
            <div className="flex flex-wrap gap-2">
              {enabledSkills.map((skill) => {
                const active = skills.includes(skill.id)
                return (
                  <button
                    key={skill.id}
                    type="button"
                    title={[skill.description, `(${skill.scope})`].filter(Boolean).join(' ')}
                    onClick={() => onToggleArrayItem('skills', skill.id)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
                      active
                        ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                        : 'bg-[var(--secondary)] text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/80 hover:text-[var(--foreground)]',
                    )}
                  >
                    {skill.name}
                  </button>
                )
              })}
              {missingSkills.map((id) => (
                <button
                  key={`missing-${id}`}
                  type="button"
                  title={`Skill "${id}" is not installed. Add it to ~/.halo/global/skills/ or ${'<workspace>'}/.halo/skills/, or click to remove from this agent.`}
                  onClick={() => onToggleArrayItem('skills', id)}
                  className="rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer border border-[var(--destructive)] bg-[var(--destructive)]/10 text-[var(--destructive)] hover:bg-[var(--destructive)]/20"
                >
                  ⚠ {id}
                </button>
              ))}
            </div>
          )
        })()}
      </section>

    </div>
  )
}

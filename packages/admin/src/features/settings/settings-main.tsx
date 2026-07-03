'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { Settings2, Globe, FolderDot, Eye, EyeOff, Trash2, RotateCcw, RefreshCw } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useI18n } from '@/shared/i18n'
import { useTheme } from '@/shared/theme'

type Schema = Awaited<ReturnType<typeof api.settings.getSchema>>
type Section = Schema['sections'][number]
type Field = Section['fields'][number]

/**
 * Settings page — driven by `GET /settings/schema`.
 *
 * The schema is aggregated server-side from three declarers:
 *   1. General (built-in) — server's own behavior knobs
 *   2. Provider (`models/<id>.yaml` `secrets:`) — keys the server uses to
 *      reach LLMs / external APIs. Hidden from agents.
 *   3. Skill (`skills/<id>/config.yaml`) — params injected into agent
 *      shell_exec via `{{<id>.params.<key>}}` placeholders, plus optional
 *      server-only secrets.
 *
 * Each field comes pre-resolved with its current value, source (global vs
 * workspace), and a masked representation when `secret: true`. Saving routes
 * through the existing PATCH/DELETE settings endpoints — the new page only
 * changes how things are presented.
 */
export function SettingsMain() {
  const { t, refreshFromServer: refreshI18nLang } = useI18n()
  const { refreshFromServer: refreshTheme } = useTheme()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [scope, setScope] = useState<'global' | 'workspace'>('global')
  const [schema, setSchema] = useState<Schema | null>(null)
  const [activeNs, setActiveNs] = useState<string>('general')
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [version, setVersion] = useState<string | null>(null)

  const projectId = scope === 'workspace' ? activeProject?.path : undefined

  const refresh = useCallback(() => {
    setRefreshing(true)
    api.settings.getSchema(projectId).then((res) => {
      setSchema(res)
      // If the previously active namespace is a real section that disappeared
      // (e.g. user uninstalled a skill), fall back to general. The synthetic
      // `__orphans` value is always allowed since it's a UI-only nav target.
      setActiveNs((prev) => {
        if (prev === '__orphans') return prev
        return res.sections.find((s) => s.namespaceId === prev) ? prev : 'general'
      })
    }).catch((err) => {
      console.error('[Settings] schema load failed:', err)
    }).finally(() => setRefreshing(false))
  }, [projectId])

  useEffect(() => { refresh() }, [refresh])

  // App version — fetched once from /api/health (server stamps it at bundle
  // time via esbuild define; 'dev' under tsx). Shown at the sidebar foot.
  useEffect(() => {
    api.health()
      .then((h) => setVersion(typeof h?.version === 'string' ? h.version : null))
      .catch(() => setVersion(null))
  }, [])

  async function handleSave(namespaceId: string, field: Field, rawValue: string) {
    setSaving(true)
    try {
      const dotPath = namespaceId === 'general'
        ? `general.${field.key}`
        : `${namespaceId}.${field.kind}s.${field.key}`
      if (rawValue === '') {
        // Empty string → delete the leaf so the value reverts to lower scope / unset.
        await api.settings.remove(scope, dotPath, projectId)
      } else {
        // Coerce per the schema's declared type so settings.yaml ends up
        // with the right native YAML scalar (number/bool stay numbers/bools,
        // not quoted strings). Falls back to "string" when type is absent.
        const coerced = coerceForSchema(field.type, rawValue)
        await api.settings.patch(scope, dotPath, coerced, projectId)
      }
      refresh()
      // Settings can affect cross-cutting state. The ones we refresh in-place
      // are the i18n context (`general.language`) and the theme context
      // (`general.theme`) — saving either should re-render the whole app
      // without a page reload. Cheap to call unconditionally; if other
      // global settings start needing this, generalize the hook.
      void refreshI18nLang()
      void refreshTheme()
    } catch (err) {
      console.error('[Settings] save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleResetField(namespaceId: string, field: Field) {
    setSaving(true)
    try {
      const dotPath = namespaceId === 'general'
        ? `general.${field.key}`
        : `${namespaceId}.${field.kind}s.${field.key}`
      await api.settings.remove(scope, dotPath, projectId)
      refresh()
      void refreshI18nLang()
      void refreshTheme()
    } catch (err) {
      console.error('[Settings] reset failed:', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleRemoveOrphan(orph: { namespaceId: string; kind: 'param' | 'secret'; key: string }) {
    const key = `${orph.namespaceId}.${orph.kind}s.${orph.key}`
    if (!confirm(t('settings.orphans.confirm', { key }))) return
    setSaving(true)
    try {
      await api.settings.remove(scope, key, projectId)
      refresh()
    } catch (err) {
      console.error('[Settings] orphan remove failed:', err)
    } finally {
      setSaving(false)
    }
  }

  const sections = schema?.sections ?? []
  const orphans = schema?.orphans ?? []
  const activeSection = useMemo(
    () => sections.find((s) => s.namespaceId === activeNs),
    [sections, activeNs],
  )

  return (
    <div className="flex h-full bg-[var(--background)]">
      {/* Left: nav */}
      <div className="flex w-[220px] shrink-0 flex-col border-r border-[var(--border)]">
        <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] px-3">
          <Settings2 className="h-4 w-4 text-[var(--muted-foreground)]" />
          <span className="text-sm font-medium text-[var(--foreground)]">{t('nav.settings')}</span>
          <div className="flex-1" />
          <button
            onClick={refresh}
            disabled={refreshing}
            title="Refresh"
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-[var(--border)] p-2">
            <div className="flex rounded-md bg-[var(--card)] p-0.5">
              <button
                onClick={() => setScope('global')}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-sm px-2 py-1 text-[10px] font-medium transition-colors',
                  scope === 'global' ? 'bg-[var(--secondary)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
                )}
              >
                <Globe className="h-3 w-3" />
                {t('common.global')}
              </button>
              <button
                onClick={() => setScope('workspace')}
                disabled={!activeProject}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-sm px-2 py-1 text-[10px] font-medium transition-colors',
                  scope === 'workspace' ? 'bg-[var(--secondary)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
                  !activeProject && 'cursor-not-allowed opacity-40',
                )}
              >
                <FolderDot className="h-3 w-3" />
                {t('common.workspace')}
              </button>
            </div>
            {scope === 'workspace' && activeProject && (
              <p className="mt-1 truncate text-[9px] text-[var(--muted-foreground)]">{activeProject.path}</p>
            )}
          </div>

          <NavList sections={sections} orphans={orphans} active={activeNs} onPick={setActiveNs} />
        </div>

        {/* Version — stamped into the bundle at build time, read from /api/health */}
        {version && (
          <div className="shrink-0 border-t border-[var(--border)] px-3 py-2 text-[10px] text-[var(--muted-foreground)]">
            Halo v{version}
          </div>
        )}
      </div>

      {/* Right: section content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {scope === 'global' ? '~/.halo/secrets/settings.yaml' : `${activeProject?.path ?? '...'}/.halo/settings.yaml`}
            {' '}&rarr; <code className="text-[var(--foreground)]">{activeNs}</code>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {activeNs === '__orphans' ? (
            <OrphansView orphans={orphans} onRemove={handleRemoveOrphan} saving={saving} />
          ) : activeSection ? (
            <SectionView
              section={activeSection}
              scope={scope}
              saving={saving}
              onSave={(field, value) => handleSave(activeSection.namespaceId, field, value)}
              onReset={(field) => handleResetField(activeSection.namespaceId, field)}
            />
          ) : (
            <div className="p-10 text-center text-xs text-[var(--muted-foreground)]">
              {schema ? t('settings.empty') : t('settings.loading')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Left nav

function NavList({
  sections, orphans, active, onPick,
}: {
  sections: Section[]
  orphans: Schema['orphans']
  active: string
  onPick: (ns: string) => void
}) {
  const { t } = useI18n()
  const grouped = useMemo(() => {
    const general = sections.filter((s) => s.source === 'general')
    const providers = sections.filter((s) => s.source === 'provider')
    const skills = sections.filter((s) => s.source === 'skill')
    const agents = sections.filter((s) => s.source === 'agent')
    return { general, providers, skills, agents }
  }, [sections])
  return (
    <div className="py-1">
      <NavGroup label={t('settings.nav.system')} items={grouped.general} active={active} onPick={onPick} />
      <NavGroup label={t('settings.nav.providers')} items={grouped.providers} active={active} onPick={onPick} />
      <NavGroup label={t('settings.nav.agents')} items={grouped.agents} active={active} onPick={onPick} />
      <NavGroup label={t('settings.nav.skills')} items={grouped.skills} active={active} onPick={onPick} />
      {orphans.length > 0 && (
        <>
          <div className="mt-2 px-3 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            {t('settings.nav.orphans')}
          </div>
          <button
            onClick={() => onPick('__orphans')}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] transition-colors',
              active === '__orphans'
                ? 'bg-[var(--secondary)] text-[var(--foreground)]'
                : 'text-[var(--foreground)]/80 hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
            )}
          >
            <Trash2 className="h-3 w-3" />
            <span>{t('settings.nav.unclaimed')}</span>
            <span className="ml-auto rounded bg-[var(--card)] px-1 py-0 text-[9px]">{orphans.length}</span>
          </button>
        </>
      )}
    </div>
  )
}

function NavGroup({
  label, items, active, onPick,
}: {
  label: string
  items: Section[]
  active: string
  onPick: (ns: string) => void
}) {
  const { lang } = useI18n()
  if (items.length === 0) return null
  return (
    <>
      <div className="px-3 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
        {label}
      </div>
      {items.map((s) => {
        const name = (lang === 'zh' && s.displayName_zh) || s.displayName
        const desc = (lang === 'zh' && s.description_zh) || s.description
        return (
          <button
            key={s.namespaceId}
            onClick={() => onPick(s.namespaceId)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] transition-colors',
              active === s.namespaceId
                ? 'bg-[var(--secondary)] text-[var(--foreground)]'
                : 'text-[var(--foreground)]/80 hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
            )}
            title={desc ?? s.namespaceId}
          >
            <span className="truncate">{name}</span>
          </button>
        )
      })}
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Section content

function SectionView({
  section, scope, saving, onSave, onReset,
}: {
  section: Section
  scope: 'global' | 'workspace'
  saving: boolean
  onSave: (field: Field, value: string) => void
  onReset: (field: Field) => void
}) {
  const { t, lang } = useI18n()
  const params = section.fields.filter((f) => f.kind === 'param')
  const secrets = section.fields.filter((f) => f.kind === 'secret')
  const displayName = (lang === 'zh' && section.displayName_zh) || section.displayName
  const description = (lang === 'zh' && section.description_zh) || section.description
  // The secret-section hint contains a `<<ENV_NAME>>` chip — split the
  // localized string on the {placeholder} marker so we can drop a styled
  // <code> in its place without losing translation.
  const hint = t('settings.section.secretsHint', { placeholder: ' ' })
  const [hintBefore, hintAfter] = hint.split(' ')
  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-[var(--foreground)]">{displayName}</h2>
        {description && (
          <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{description}</p>
        )}
        <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
          {t('settings.section.namespace')}: <code className="text-[var(--foreground)]">{section.namespaceId}</code>
          {' · '}
          {t('settings.section.declaredBy')}: <span>{t(`settings.section.declaredBy.${section.source}`)}</span>
        </p>
      </div>

      {params.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            {section.namespaceId === 'general' ? t('settings.section.settings') : t('settings.section.params')}
          </h3>
          {params.map((f) => (
            <FieldRow
              key={f.key}
              namespaceId={section.namespaceId}
              field={f}
              scope={scope}
              saving={saving}
              onSave={(v) => onSave(f, v)}
              onReset={() => onReset(f)}
            />
          ))}
        </div>
      )}

      {secrets.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            {t('settings.section.secrets')}
          </h3>
          <p className="text-[10px] text-[var(--muted-foreground)]">
            {hintBefore}
            <code className="rounded bg-[var(--card)] px-1 py-0.5">{'<<ENV_NAME>>'}</code>
            {hintAfter}
          </p>
          {secrets.map((f) => (
            <FieldRow
              key={f.key}
              namespaceId={section.namespaceId}
              field={f}
              scope={scope}
              saving={saving}
              onSave={(v) => onSave(f, v)}
              onReset={() => onReset(f)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FieldRow({
  namespaceId, field, scope, saving, onSave, onReset,
}: {
  namespaceId: string
  field: Field
  scope: 'global' | 'workspace'
  saving: boolean
  onSave: (value: string) => void
  onReset: () => void
}) {
  const { lang, t } = useI18n()
  const desc = (lang === 'zh' && field.description_zh) || field.description || ''
  const dotPath = namespaceId === 'general'
    ? `general.${field.key}`
    : `${namespaceId}.${field.kind}s.${field.key}`

  // Workspace scope: showing a value that comes from global is "inherited".
  // User can override by typing a new value (saving creates a workspace-level entry).
  const inherited = scope === 'workspace' && field.inheritedFromGlobal
  // `globalOnly` fields aren't honored at workspace scope. Lock the input
  // when the user is browsing workspace settings — the control still renders
  // the resolved (global) value for context, but no edit / reset is allowed.
  const lockedAsGlobalOnly = scope === 'workspace' && field.globalOnly === true
  // Reset only makes sense when the value at this scope differs from what
  // we'd fall back to:
  //   - workspace scope: any value here is an override → show Reset.
  //   - global scope: value must differ from the schema's `default`. If
  //     they're equal, "Reset" is a no-op visually.
  const canReset = !lockedAsGlobalOnly && field.source === scope && (
    scope === 'workspace' || (field.value ?? '') !== (field.default ?? '')
  )

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-[var(--foreground)]">{field.key}</label>
        <code className="text-[10px] text-[var(--muted-foreground)]">{dotPath}</code>
        <SourceBadge source={field.source} inherited={inherited} />
        {field.globalOnly && (
          <span
            className="rounded bg-[var(--secondary)] px-1.5 py-px text-[10px] uppercase text-[var(--muted-foreground)]"
            title={lang === 'zh' ? '只在全局生效；workspace 级覆盖会被忽略' : 'Honored only at the global layer; workspace overrides are ignored'}
          >global only</span>
        )}
        {canReset && (
          <button
            onClick={onReset}
            disabled={saving}
            className="flex cursor-pointer items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"
            title={scope === 'workspace' ? t('settings.field.resetTitleWorkspace') : t('settings.field.resetTitleGlobal')}
          >
            <RotateCcw className="h-2.5 w-2.5" />
            {t('settings.field.reset')}
          </button>
        )}
      </div>
      {desc && <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{desc}</p>}
      <div className={cn('mt-1.5', lockedAsGlobalOnly && 'opacity-60 pointer-events-none')}>
        {renderFieldControl(field, saving || lockedAsGlobalOnly, onSave)}
      </div>
    </div>
  )
}

/**
 * Render the right input control for a field based on its declared type.
 * Secret fields always use the masked input regardless of type (no number-
 * masking yet — secrets are strings in practice).
 */
function renderFieldControl(field: Field, saving: boolean, onSave: (value: string) => void) {
  if (field.secret) {
    return <SecretInput initial={field.value ?? ''} placeholder={field.default ?? ''} saving={saving} onCommit={onSave} />
  }
  switch (field.type) {
    case 'int':
    case 'float':
      return <NumberInput
        initial={field.value ?? ''}
        placeholder={field.default ?? ''}
        step={field.type === 'int' ? 1 : 0.1}
        saving={saving}
        onCommit={onSave}
      />
    case 'boolean':
      return <BooleanInput value={field.value} saving={saving} onCommit={onSave} />
    case 'enum':
      return <EnumInput value={field.value} options={field.options ?? []} optionLabels={field.optionLabels} placeholder={field.default ?? ''} saving={saving} onCommit={onSave} />
    case 'string':
    default:
      return <TextInput initial={field.value ?? ''} placeholder={field.default ?? ''} saving={saving} onCommit={onSave} />
  }
}

/**
 * Coerce a string from the input element to the right native type before
 * sending to the API, so YAML serializes it as the right scalar (e.g.
 * `compress_at: 0.8` not `compress_at: "0.8"`).
 *
 * Returns the original string when the user typed garbage — server still
 * accepts it; the next read just shows the last good value.
 */
function coerceForSchema(type: Field['type'], raw: string): unknown {
  switch (type) {
    case 'int': {
      const n = parseInt(raw, 10)
      return Number.isFinite(n) ? n : raw
    }
    case 'float': {
      const n = parseFloat(raw)
      return Number.isFinite(n) ? n : raw
    }
    case 'boolean':
      return raw === 'true'
    case 'enum':
    case 'string':
    default:
      return raw
  }
}

function SourceBadge({ source, inherited }: { source: Field['source']; inherited: boolean }) {
  const { t } = useI18n()
  const palette = {
    workspace: 'bg-blue-500/20 text-blue-300',
    global: inherited ? 'bg-[var(--secondary)] text-[var(--muted-foreground)]' : 'bg-emerald-500/20 text-emerald-300',
    unset: 'bg-[var(--secondary)] text-[var(--muted-foreground)] opacity-60',
  }[source]
  const labelKey = source === 'unset'
    ? 'settings.source.unset'
    : inherited
      ? 'settings.source.inherited'
      : `settings.source.${source}`
  return <span className={cn('rounded px-1.5 py-0 text-[9px] font-medium', palette)}>{t(labelKey)}</span>
}

const ENV_PATTERN = /^<<[A-Z_][A-Z0-9_]*>>$/

function TextInput({
  initial, placeholder, saving, onCommit,
}: {
  initial: string
  placeholder?: string
  saving: boolean
  onCommit: (v: string) => void
}) {
  // When `initial` is empty but a placeholder (the schema default) exists, we
  // show the placeholder as the visible value in muted text. That makes
  // "unset → using default" feel concrete (otherwise the input looks blank
  // and users wonder if Reset did anything). Typing replaces the muted
  // value with a real one; clearing the field commits empty (unset).
  const isUsingDefault = initial === '' && !!placeholder
  const [local, setLocal] = useState(initial)
  const [editing, setEditing] = useState(false)
  const committed = useRef(initial)
  useEffect(() => {
    setLocal(initial)
    committed.current = initial
    setEditing(false)
  }, [initial])
  function commit() {
    setEditing(false)
    if (local === committed.current) return
    committed.current = local
    onCommit(local)
  }
  const display = isUsingDefault && !editing ? (placeholder ?? '') : local
  return (
    <input
      type="text"
      value={display}
      placeholder={placeholder}
      onFocus={() => {
        if (isUsingDefault) setLocal('')  // start fresh; don't carry the default into the actual value
        setEditing(true)
      }}
      onChange={(e) => { setLocal(e.target.value); setEditing(true) }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      disabled={saving}
      className={cn(
        'h-7 w-full max-w-md rounded border border-[var(--border)] bg-[var(--card)] px-2 text-xs outline-none focus:border-[var(--primary)]',
        isUsingDefault && !editing ? 'text-[var(--muted-foreground)] italic' : 'text-[var(--foreground)]',
      )}
    />
  )
}

/** Number input for `type: int | float`. Same default-display behaviour as TextInput. */
function NumberInput({
  initial, placeholder, step, saving, onCommit,
}: {
  initial: string
  placeholder?: string
  step?: number
  saving: boolean
  onCommit: (v: string) => void
}) {
  const isUsingDefault = initial === '' && !!placeholder
  const [local, setLocal] = useState(initial)
  const [editing, setEditing] = useState(false)
  const committed = useRef(initial)
  useEffect(() => {
    setLocal(initial)
    committed.current = initial
    setEditing(false)
  }, [initial])
  function commit() {
    setEditing(false)
    if (local === committed.current) return
    committed.current = local
    onCommit(local)
  }
  const display = isUsingDefault && !editing ? (placeholder ?? '') : local
  return (
    <input
      type="number"
      step={step}
      value={display}
      placeholder={placeholder}
      onFocus={() => {
        if (isUsingDefault) setLocal('')
        setEditing(true)
      }}
      onChange={(e) => { setLocal(e.target.value); setEditing(true) }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      disabled={saving}
      className={cn(
        'h-7 w-full max-w-md rounded border border-[var(--border)] bg-[var(--card)] px-2 text-xs outline-none focus:border-[var(--primary)]',
        isUsingDefault && !editing ? 'text-[var(--muted-foreground)] italic' : 'text-[var(--foreground)]',
      )}
    />
  )
}

/** Toggle for `type: boolean`. */
function BooleanInput({
  value, saving, onCommit,
}: {
  value: string | null
  saving: boolean
  onCommit: (v: string) => void
}) {
  const checked = value === 'true' || value === '1'
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={saving}
        onChange={(e) => onCommit(e.target.checked ? 'true' : 'false')}
        className="h-3.5 w-3.5 cursor-pointer rounded border-[var(--border)] bg-[var(--card)] text-[var(--primary)] focus:ring-[var(--primary)]"
      />
      <span className="text-xs text-[var(--muted-foreground)]">{checked ? 'on' : 'off'}</span>
    </label>
  )
}

/** Dropdown for `type: enum`. */
function EnumInput({
  value, options, optionLabels, placeholder, saving, onCommit,
}: {
  value: string | null
  options: string[]
  /** Parallel to `options`. Index `i` is the display label for `options[i]`.
   *  When omitted (or shorter than `options`), the option code itself
   *  doubles as its label. */
  optionLabels?: string[]
  placeholder?: string
  saving: boolean
  onCommit: (v: string) => void
}) {
  const current = value ?? placeholder ?? options[0] ?? ''
  return (
    <select
      value={current}
      disabled={saving}
      onChange={(e) => onCommit(e.target.value)}
      className="h-7 w-full max-w-md cursor-pointer rounded border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
    >
      {options.map((opt, i) => (
        <option key={opt} value={opt}>{optionLabels?.[i] ?? opt}</option>
      ))}
    </select>
  )
}

/**
 * Secret input. Server returns the value already masked (e.g. "ak***JZ") for
 * regular secrets but pass-through for `<<ENV>>` placeholders. We reveal the
 * masked form only — actual plaintext lives in settings.yaml and is never
 * shipped to the browser. To change a secret, type a new value; the masked
 * placeholder gets cleared automatically when you focus.
 */
function SecretInput({
  initial, placeholder, saving, onCommit,
}: {
  initial: string
  placeholder?: string
  saving: boolean
  onCommit: (v: string) => void
}) {
  const isEnvRef = ENV_PATTERN.test(initial)
  const [local, setLocal] = useState(initial)
  const [editing, setEditing] = useState(false)
  const [visible, setVisible] = useState(isEnvRef)
  const committed = useRef(initial)
  useEffect(() => {
    setLocal(initial)
    committed.current = initial
    setEditing(false)
    setVisible(ENV_PATTERN.test(initial))
  }, [initial])

  function commit() {
    if (!editing) return
    if (local === committed.current) { setEditing(false); return }
    committed.current = local
    onCommit(local)
    setEditing(false)
  }

  return (
    <div className="relative w-full max-w-md">
      <input
        type={visible || editing ? 'text' : 'password'}
        value={editing ? local : (initial || '')}
        placeholder={placeholder}
        onFocus={() => {
          if (!editing && initial && !ENV_PATTERN.test(initial)) {
            // Clear masked stub so the user types fresh.
            setLocal('')
          }
          setEditing(true)
        }}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        disabled={saving}
        className="h-7 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 pr-7 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
      />
      {!isEnvRef && (
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          tabIndex={-1}
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Orphans

function OrphansView({
  orphans, onRemove, saving,
}: {
  orphans: Schema['orphans']
  onRemove: (orph: Schema['orphans'][number]) => void
  saving: boolean
}) {
  const { t } = useI18n()
  // Group by namespace for clarity (always run hook, even when empty,
  // to keep React's hook order stable).
  const grouped = useMemo(() => {
    const map = new Map<string, Schema['orphans']>()
    for (const o of orphans) {
      const list = map.get(o.namespaceId) ?? []
      list.push(o)
      map.set(o.namespaceId, list)
    }
    return Array.from(map.entries())
  }, [orphans])
  if (orphans.length === 0) return null
  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-[var(--foreground)]">{t('settings.orphans.title')}</h2>
        <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
          {t('settings.orphans.intro')}
        </p>
      </div>
      {grouped.map(([ns, items]) => (
        <div key={ns} className="space-y-2 rounded border border-[var(--border)] p-3">
          <h3 className="text-[11px] font-semibold text-[var(--foreground)]">{ns}</h3>
          <ul className="space-y-1">
            {items.map((o) => (
              <li key={`${o.kind}.${o.key}`} className="flex items-center justify-between text-[11px]">
                <code className="text-[var(--muted-foreground)]">{ns}.{o.kind}s.{o.key}</code>
                <button
                  onClick={() => onRemove(o)}
                  disabled={saving}
                  className="flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('settings.orphans.remove')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

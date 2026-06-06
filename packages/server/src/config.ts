/**
 * Centralized configuration — all magic numbers in one place.
 * Values can be overridden via environment variables.
 * Settings from ~/.halo/secrets/settings.yaml are loaded as fallbacks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { loadSettingsSchema } from './settings-schema.js'

export const HALO_HOME = path.join(homedir(), '.halo')
export const HALO_GLOBAL_DIR = path.join(HALO_HOME, 'global')
export const HALO_SECRETS_DIR = path.join(HALO_HOME, 'secrets')

/** Load a YAML file synchronously at startup */
function loadYamlFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return YAML.parse(raw) ?? {}
  } catch {
    return {}
  }
}

/** Load the models registry by scanning `{global}/models/*.yaml`.
 *  Each file describes one provider: { id, displayName?, description?, models: [...] }. */
function loadModelsRegistry(): { providers: Array<Record<string, unknown>> } {
  const providers: Array<Record<string, unknown>> = []
  const modelsDir = path.join(HALO_GLOBAL_DIR, 'models')
  try {
    const entries = fs.readdirSync(modelsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
      try {
        const raw = fs.readFileSync(path.join(modelsDir, entry.name), 'utf-8')
        const parsed = YAML.parse(raw) as Record<string, unknown> | null
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
          providers.push(parsed)
        } else {
          console.log(`[config] Skipping ${entry.name}: missing provider id`)
        }
      } catch (err) {
        console.log(`[config] Failed to load ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch { /* dir missing — leave providers empty */ }
  return { providers }
}

const _modelsRegistry = loadModelsRegistry()
const _systemConfig = loadYamlFile(path.join(HALO_SECRETS_DIR, 'config.yaml'))

/** Lazy + mtime-watched settings cache. UI saves rewrite the file; bumping
 *  the mtime triggers a reparse on the next read so the server picks up new
 *  secrets without a restart. */
const SETTINGS_PATH = path.join(HALO_SECRETS_DIR, 'settings.yaml')
let _settingsCache: { mtimeMs: number; data: Record<string, unknown> } | null = null
function getSettings(): Record<string, unknown> {
  let mtimeMs = 0
  try { mtimeMs = fs.statSync(SETTINGS_PATH).mtimeMs } catch { /* missing → mtime 0 */ }
  if (!_settingsCache || _settingsCache.mtimeMs !== mtimeMs) {
    _settingsCache = { mtimeMs, data: loadYamlFile(SETTINGS_PATH) }
  }
  return _settingsCache.data
}

/**
 * Walk a dotted path through a yaml tree.
 *
 * `config.yaml` (system config managed by `halo setup`) still uses the
 * self-describing leaf shape `{ value, default, description, description_zh }`,
 * so we unwrap when we see one. `settings.yaml` is flat scalars now (post
 * 2026-05 schema refactor); a flat leaf passes through untouched.
 */
function readYamlValue(tree: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.')
  let cur: unknown = tree
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  if (cur != null && typeof cur === 'object' && !Array.isArray(cur) && 'value' in (cur as Record<string, unknown>)) {
    const obj = cur as Record<string, unknown>
    const v = obj.value
    // Treat null/undefined/empty-string as "unset"; arrays (even empty) and
    // numbers (incl. 0) and booleans are intentionally provided values.
    const isUnset = (x: unknown) => x == null || (typeof x === 'string' && x === '')
    if (!isUnset(v)) return v
    const d = obj.default
    return isUnset(d) ? undefined : d
  }
  return cur
}

/** Read from settings.yaml (params, secrets, general, logging, ...). Returns string form. */
function settingsValue(dotPath: string): string | undefined {
  const v = readYamlValue(getSettings(), dotPath)
  return v == null ? undefined : (typeof v === 'string' ? v : String(v))
}

/** Read from config.yaml (server, timeout, logging.max_*). Raw type preserved (number/string/array). */
function configValue(dotPath: string): unknown {
  return readYamlValue(_systemConfig, dotPath)
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined) return fallback
  const n = parseInt(v, 10)
  return isNaN(n) ? fallback : n
}

/**
 * Defaults pulled from `settings-schema.ts` so the schema's `default` is the
 * single source of truth. `general` keys live in the built-in section; we
 * cache the lookup once per process (the schema is static for built-ins).
 *
 * If a caller asks for a path the schema doesn't declare, we fall back to
 * the call site's hardcoded literal — which usually means it's an
 * undeclared knob (typo or future addition). Both cases get a one-time
 * console warning so divergence is visible in logs.
 */
let _schemaDefaultsCache: Map<string, string> | null = null
function loadSchemaDefaults(): Map<string, string> {
  if (_schemaDefaultsCache) return _schemaDefaultsCache
  const map = new Map<string, string>()
  for (const section of loadSettingsSchema()) {
    if (section.namespaceId !== 'general') continue
    for (const f of section.fields) {
      if (f.default !== undefined) map.set(`general.${f.key}`, f.default)
    }
  }
  _schemaDefaultsCache = map
  return map
}

function schemaDefault(settingsPath: string, callsiteFallback: string): string {
  const fromSchema = loadSchemaDefaults().get(settingsPath)
  if (fromSchema === undefined) return callsiteFallback
  if (fromSchema !== callsiteFallback) {
    console.warn(`[config] default mismatch for "${settingsPath}": schema=${JSON.stringify(fromSchema)} callsite=${JSON.stringify(callsiteFallback)}. Using schema value.`)
  }
  return fromSchema
}

/** Read int config: settings.yaml > schema default > callsite fallback */
function settingsInt(settingsPath: string, fallback: number): number {
  const sv = settingsValue(settingsPath)
  if (sv !== undefined) { const n = parseInt(sv, 10); if (!isNaN(n)) return n }
  const schemaDef = schemaDefault(settingsPath, String(fallback))
  const n = parseInt(schemaDef, 10)
  return isNaN(n) ? fallback : n
}

/** Read string config: settings.yaml > schema default > callsite fallback */
function settingsStr(settingsPath: string, fallback: string): string {
  const sv = settingsValue(settingsPath)
  if (sv !== undefined) return String(sv)
  return schemaDefault(settingsPath, fallback)
}

/** Read boolean config: settings.yaml > schema default > callsite fallback.
 *  Accepts yaml booleans, the strings "true" / "false", or numeric 0/1. */
function settingsBool(settingsPath: string, fallback: boolean): boolean {
  const raw = settingsStr(settingsPath, fallback ? 'true' : 'false').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}


/** Read int config: env > config.yaml > fallback */
function systemInt(envKey: string, configPath: string, fallback: number): number {
  const envVal = process.env[envKey]
  if (envVal !== undefined) { const n = parseInt(envVal, 10); if (!isNaN(n)) return n }
  const cv = configValue(configPath)
  if (typeof cv === 'number') return cv
  if (typeof cv === 'string') { const n = parseInt(cv, 10); if (!isNaN(n)) return n }
  return fallback
}

function systemStringArray(envKey: string, configPath: string, fallback: string[]): string[] {
  const envVal = process.env[envKey]
  if (envVal !== undefined && envVal.trim()) {
    return envVal.split(',').map((s) => s.trim()).filter(Boolean)
  }
  const cv = configValue(configPath)
  if (Array.isArray(cv)) return cv.map(String)
  return fallback
}

function systemString(envKey: string, configPath: string, fallback: string | null): string | null {
  const envVal = process.env[envKey]
  if (envVal !== undefined) return envVal
  const cv = configValue(configPath)
  if (typeof cv === 'string') return cv
  return fallback
}

const ENV_PATTERN = /<<([A-Z_][A-Z0-9_]*)>>/g

/**
 * Resolve `<<ENV_NAME>>` placeholders inside a settings.yaml string value.
 *
 * If the env var isn't set, **keep the literal placeholder** rather than
 * silently substituting an empty string. Three reasons:
 *   - A literal `<<DEEPSEEK_API_KEY22>>` reaching the API will fail with a
 *     clear 401, telling the user exactly which env var is missing.
 *   - An empty-string substitution looks "valid" to downstream code (truthy
 *     check passes for `<<X>>` but fails for `''`), causing inconsistent
 *     fallback behaviour between callers.
 *   - Users who type a wrong env-var name discover the typo immediately.
 */
function expandEnv(raw: string | undefined): string {
  if (!raw) return ''
  return raw.replace(ENV_PATTERN, (m, name: string) => process.env[name] ?? m)
}

/**
 * Read a server-side secret declared by a provider/skill.
 *
 * Storage layout (after the 2026-05 schema refactor):
 *   <namespace-id>.secrets.<key>
 *
 * `<namespace-id>` is the provider id from `models/<id>.yaml` or the skill id
 * from `skills/<id>/`. So AWS Bedrock keys live at
 *   `aws-bedrock-claude-invoke.secrets.access_key_id`
 * — searchable by the same id used in agent.yaml `model.provider`.
 *
 * `<<ENV_NAME>>` placeholders inside the stored value are expanded against
 * process.env at read time.
 */
export function getServerSecret(namespaceId: string, key: string): string {
  return expandEnv(settingsValue(`${namespaceId}.secrets.${key}`))
}


export const config = {
  server: {
    port: systemInt('HALO_PORT', 'server.port', 9527),
    /** scrypt hash stored in `secrets/config.yaml`, set by `halo setup`.
     *  `null` = not configured. `HALO_PASSWORD` env is *not* a hash —
     *  it's a plaintext bypass; see `passwordEnvPlaintext` below and the
     *  branch in `middleware/auth.ts`. */
    get password(): string | null {
      const cv = configValue('server.password')
      return typeof cv === 'string' ? cv : null
    },
    /** Plaintext password supplied via `HALO_PASSWORD` env. The auth
     *  middleware compares this directly (no scrypt) since the env's
     *  whatever-secret-store already protects the value. Lets ops scripts
     *  set a password without round-tripping through scrypt hashing. */
    get passwordEnvPlaintext(): string | null {
      const v = process.env.HALO_PASSWORD
      return v && v.length > 0 ? v : null
    },
    // Random base64 JWT signing key, set by `halo setup`. Empty = not set up.
    jwtSecret: systemString('HALO_JWT_SECRET', 'server.jwt_secret', null),
    // Empty allowlist means "reflect any origin" (see CORS setup in index.ts).
    corsOrigins: systemStringArray('HALO_CORS_ORIGINS', 'server.cors_origins', []),
  },

  // `model.compressAt` is intentionally a getter — it reads from
  // settings.yaml (`general.compact.compress_at`) on every access so a
  // user edit takes effect on the next session without a restart. The
  // value is a fraction of `maxContextTokens`; auto-compact triggers when
  // the running context exceeds `maxContextTokens * compressAt`.
  model: {
    maxContextTokens: envInt('HALO_MAX_CONTEXT_TOKENS', 200_000),
    get compressAt(): number {
      const raw = settingsValue('general.compact.compress_at')
      if (raw !== undefined) {
        const n = parseFloat(raw)
        if (Number.isFinite(n) && n > 0 && n <= 1) return n
      }
      return 0.8
    },
  },

  /** System language preference. `general.language` in settings.yaml stores
   *  a BCP-47 region tag (`en-US` / `zh-CN`). The rest of the codebase still
   *  uses the simple `'en' | 'zh'` shape — we collapse the region here so
   *  callers don't have to think about it. Anything starting with `zh-` →
   *  `'zh'`; everything else → `'en'`. */
  get language(): 'en' | 'zh' {
    const raw = settingsStr('general.language', 'en-US').toLowerCase()
    return raw.startsWith('zh') ? 'zh' : 'en'
  },

  agent: {

    defaultTools: [
      'file_read', 'file_write', 'file_edit', 'file_list',
      'shell_exec', 'grep', 'glob', 'web_fetch',
    ],
    maxRetries: settingsInt('general.agent.max_retries', 5),
    /** Provider used when scaffolding a new agent.yaml (set in Settings →
     *  General). Empty string means "fall back to whatever the scaffold code
     *  picks" — historically aws-bedrock-claude-invoke. */
    get defaultProvider(): string {
      return settingsValue('general.agent.default_provider') ?? ''
    },
  },

  timeout: {
    shellExec: systemInt('HALO_SHELL_TIMEOUT', 'timeout.shell_exec', 120_000),
    webFetch: systemInt('HALO_WEB_FETCH_TIMEOUT', 'timeout.web_fetch', 10_000),
    sessionGrace: systemInt('HALO_SESSION_GRACE', 'timeout.session_grace', 5 * 60_000),
    terminalGrace: systemInt('HALO_TERMINAL_GRACE', 'timeout.terminal_grace', 5 * 60_000),
  },

  // Runtime caps — read live from settings.yaml on every access. Getters
  // (not literals) so a settings reload takes effect on the next tool
  // call without restarting the server. Schema lives in settings-schema
  // under the `limits.*` namespace.
  limits: {
    get shellOutputBuffer(): number { return settingsInt('general.limits.shell_output_bytes', 5 * 1024 * 1024) },
    get webFetchMaxBody(): number { return settingsInt('general.limits.web_fetch_bytes', 50 * 1024) },
    get grepDefaultMax(): number { return settingsInt('general.limits.grep_default_matches', 50) },
    get toolResultMax(): number { return settingsInt('general.limits.tool_result_render_chars', 8000) },
    get wsEventBuffer(): number { return settingsInt('general.limits.ws_event_buffer', 5000) },
    get terminalOutputBuffer(): number { return settingsInt('general.limits.terminal_scrollback_bytes', 50_000) },
  },

  compact: {
    keep_messages: settingsInt('general.compact.keep_messages', 5),
    max_summary_input: settingsInt('general.compact.max_summary_input', 15_000),
    max_message_slice: settingsInt('general.compact.max_message_slice', 800),
    summarize_timeout_sec: settingsInt('general.compact.summarize_timeout_sec', 300),
  },

  auth: {
    tokenMaxAge: 14 * 24 * 60 * 60,
    refreshAfter: 24 * 60 * 60,
  },

  session: {
    maxCachedSessions: envInt('HALO_MAX_CACHED_SESSIONS', 50),
    maxQueueSize: settingsInt('general.session.max_queue_size', 3),
    maxNestingDepth: settingsInt('general.session.max_nesting_depth', 16),
  },

  sandbox: {
    hiddenDirs: settingsStr('general.sandbox.hidden_dirs', '~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker').split(',').map((s) => s.trim()).filter(Boolean),
    hiddenFiles: settingsStr('general.sandbox.hidden_files', '~/.npmrc,~/.bash_history,~/.gitconfig').split(',').map((s) => s.trim()).filter(Boolean),
  },

  logging: {
    // `logging.level` lives under `general.logging.level` in settings.yaml so
    // it shows up alongside the other general knobs in the settings UI.
    // `max_file_size` / `max_files` stay in config.yaml — they're operator
    // dials, not user-tunable preferences.
    level: (process.env.HALO_LOG_LEVEL ?? settingsStr('general.logging.level', 'warn')) as 'debug' | 'info' | 'warn' | 'error',
    maxFileSize: systemInt('HALO_LOG_MAX_SIZE', 'logging.max_file_size', 10 * 1024 * 1024), // 10MB
    maxFiles: systemInt('HALO_LOG_MAX_FILES', 'logging.max_files', 5),
  },

  // Self-evolution (see plans/self-evolution.md). Getter-based so user edits
  // in settings.yaml take effect on the next ticker run without restart.
  evolution: {
    get level(): 'L0' | 'L1' {
      const raw = settingsStr('general.evolution.level', 'L0')
      return raw === 'L1' ? 'L1' : 'L0'
    },
    get maxConcurrentRun(): number {
      return settingsInt('general.evolution.max_concurrent_run', 1)
    },
    get maxConcurrentApply(): number {
      return settingsInt('general.evolution.max_concurrent_apply', 1)
    },
    get runTimeoutMinutes(): number {
      return settingsInt('general.evolution.run_timeout_minutes', 5)
    },
    get applyTimeoutMinutes(): number {
      return settingsInt('general.evolution.apply_timeout_minutes', 5)
    },
    get maxAttempts(): number {
      return settingsInt('general.evolution.max_attempts', 3)
    },
    triggers: {
      get preCompact(): boolean {
        return settingsBool('general.evolution.triggers.pre_compact', true)
      },
    },
  },
} as const

const HIDDEN_DIRS_DEFAULT = '~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker'
const HIDDEN_FILES_DEFAULT = '~/.npmrc,~/.bash_history,~/.gitconfig'

export function reloadSandboxConfig(): { hiddenDirs: string[]; hiddenFiles: string[] } {
  // getSettings() is mtime-watched, so this picks up the latest file content.
  return {
    hiddenDirs: settingsStr('general.sandbox.hidden_dirs', HIDDEN_DIRS_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean),
    hiddenFiles: settingsStr('general.sandbox.hidden_files', HIDDEN_FILES_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean),
  }
}

/** Look up a model entry from the registry by ID */
function findModelEntry(modelId: string): { id: string; maxOutputTokens?: number; capabilities?: Record<string, unknown> } | undefined {
  try {
    const providers = (_modelsRegistry as { providers?: Array<{ models?: Array<Record<string, unknown>> }> }).providers
    if (providers) {
      for (const provider of providers) {
        for (const model of provider.models ?? []) {
          if (model.id === modelId) return model as ReturnType<typeof findModelEntry>
        }
      }
    }
  } catch { /* fall through */ }
  return undefined
}

/**
 * Resolve max output tokens for a model from models.yaml.
 * Falls back to 16384 if not found (safe for all Claude models).
 */
export function resolveMaxOutputTokens(modelId: string): number {
  const entry = findModelEntry(modelId)
  return (entry?.maxOutputTokens as number) ?? 16384
}

/**
 * Resolve a provider's bearer-token-style API key.
 *
 * Reads `<providerId>.secrets.api_key` from settings.yaml. The value may be
 * a `<<ENV_NAME>>` reference; expansion happens via `getServerSecret`.
 *
 * No env-var fallback chain here — if the user wants to wire to an env var,
 * they should set the value in settings.yaml to `<<MY_ENV>>`. Hardcoding a
 * fallback to `KIMI_API_KEY` / `DEEPSEEK_API_KEY` masked typos: pointing the
 * setting at a non-existent env var would silently fall through to the
 * canonical env var and "succeed", instead of telling the user the
 * configured ref was wrong.
 */
export function resolveApiKey(providerId: string): string | undefined {
  return getServerSecret(providerId, 'api_key') || undefined
}

/**
 * Resolve AWS Bedrock credentials. Reads from
 *   `<providerId>.secrets.access_key_id` / `.secret_access_key`
 * — defaults to the canonical Bedrock provider id when caller doesn't pass
 * one (e.g. the legacy single-provider call sites). Returns undefined fields
 * when not set so callers can fall back to the AWS SDK credential chain.
 */
export function resolveAwsCredentials(providerId = 'aws-bedrock-claude-invoke'): { accessKeyId: string; secretAccessKey: string } {
  return {
    accessKeyId: getServerSecret(providerId, 'access_key_id'),
    secretAccessKey: getServerSecret(providerId, 'secret_access_key'),
  }
}

/**
 * Resolve a model's thinking mode from the registry.
 *   - `adaptive`: send `thinking: {type: 'adaptive'}` + `output_config.effort`
 *     (Sonnet 4.6 / Opus 4.6+ / 4.7 — modern API)
 *   - `manual`: send `thinking: {type: 'enabled', budget_tokens: N}` —
 *     Haiku 4.5 and older Claude models, where effort is translated to a
 *     budget number at the SDK layer.
 *   - `undefined`: registry didn't say; caller falls back to its own default.
 */
export function resolveThinkingMode(modelId: string): 'adaptive' | 'manual' | undefined {
  const entry = findModelEntry(modelId)
  const thinking = (entry?.capabilities as Record<string, unknown> | undefined)?.thinking
  if (thinking && typeof thinking === 'object' && 'mode' in thinking) {
    const mode = (thinking as { mode?: unknown }).mode
    if (mode === 'adaptive' || mode === 'manual') return mode
  }
  return undefined
}

/** Output verbosity for the OpenAI Responses API (`text.verbosity`). Resolves
 *  the model registry's `capabilities.verbosity.default`. Returns undefined when
 *  the model doesn't declare it — the agent's own fallback applies. An optional
 *  `override` (agent.yaml `model.verbosity`) wins, mirroring modelSupportsImage. */
export function resolveVerbosity(modelId: string, override?: string): 'low' | 'medium' | 'high' | undefined {
  if (override === 'low' || override === 'medium' || override === 'high') return override
  const entry = findModelEntry(modelId)
  const v = (entry?.capabilities as Record<string, unknown> | undefined)?.verbosity
  const def = (v as { default?: unknown } | undefined)?.default
  if (def === 'low' || def === 'medium' || def === 'high') return def
  return undefined
}

/** Check model modality support based on manifest capabilities.
 *  An optional `override` (read from agent.yaml `model.image/video/audio`)
 *  takes precedence — the user's per-agent toggle wins over the registry
 *  default. This lets the generic openai/anthropic providers expose
 *  modality flags the user can flip when targeting a custom model id. */
export function modelSupportsImage(modelId: string, override?: boolean): boolean {
  if (typeof override === 'boolean') return override
  const entry = findModelEntry(modelId)
  return !!(entry?.capabilities as Record<string, unknown> | undefined)?.image
}

export function modelSupportsVideo(modelId: string, override?: boolean): boolean {
  if (typeof override === 'boolean') return override
  const entry = findModelEntry(modelId)
  return !!(entry?.capabilities as Record<string, unknown> | undefined)?.video
}

export function modelSupportsAudio(modelId: string, override?: boolean): boolean {
  if (typeof override === 'boolean') return override
  const entry = findModelEntry(modelId)
  return !!(entry?.capabilities as Record<string, unknown> | undefined)?.audio
}

/** Get the loaded models registry (for API endpoints) */
export function getModelsRegistry(): Record<string, unknown> {
  return _modelsRegistry
}

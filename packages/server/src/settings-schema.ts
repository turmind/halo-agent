/**
 * Settings schema registry — aggregates declared parameters from three sources:
 *
 *   1. **General** (built-in)            — server's own behavior knobs (compaction,
 *                                            sandbox, session limits…). Hardcoded
 *                                            below since the server itself is the
 *                                            "declarer".
 *   2. **Provider secrets**              — declared in `models/<provider-id>.yaml`
 *                                            under `secrets:`. Stored at
 *                                            `<provider-id>.secrets.<key>`.
 *   3. **Skill params/secrets**          — declared in
 *                                            `skills/<skill-id>/config.yaml`.
 *                                            Stored at
 *                                            `<skill-id>.params.<key>` /
 *                                            `<skill-id>.secrets.<key>`.
 *
 * Each declared field carries enough metadata for the admin UI to render a
 * proper input (label, help text, secret masking, default placeholder).
 *
 * Storage layout for *values* lives in the user's settings.yaml:
 *
 *   general:                       # the only "namespace" without an id
 *     compact: { keep_messages: 5 }
 *   aws-bedrock-claude-invoke:     # provider id → namespace
 *     secrets:
 *       access_key_id: AKIA…
 *   tavily-search:                 # skill id → namespace
 *     params:
 *       api_key: …
 *
 * The registry is rebuilt on every read (cheap; just reads a few yaml files).
 * Callers that need it many times in one request should call once and reuse.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

const GLOBAL_MODELS_DIR = path.join(homedir(), '.halo', 'global', 'models')
const GLOBAL_SKILLS_DIR = path.join(homedir(), '.halo', 'global', 'skills')
const GLOBAL_AGENTS_DIR = path.join(homedir(), '.halo', 'global', 'agents')

export type FieldKind = 'param' | 'secret'
/**
 * Value type. Drives the UI control:
 *   - `string` → text input (default)
 *   - `int` / `float` → number input with appropriate step
 *   - `boolean` → toggle
 *   - `enum` → dropdown (requires `options`)
 *
 * Stored as YAML scalar of the matching native type. Server-side reads still
 * coerce defensively (a yaml `"3"` reads fine as int).
 */
export type FieldType = 'string' | 'int' | 'float' | 'boolean' | 'enum'

export interface SchemaField {
  key: string                      // leaf key (no namespace prefix)
  kind: FieldKind
  /** Value type — defaults to `'string'` when omitted. */
  type?: FieldType
  /** For `type: 'enum'` — allowed values. UI renders as dropdown. */
  options?: string[]
  /** For `type: 'enum'` — display labels parallel to `options`. Lets the
   *  UI show user-friendly text (e.g. "中文" for `zh-CN`) while the stored
   *  value stays a stable code. Length must match `options`; fall back to
   *  the option code when missing. */
  optionLabels?: string[]
  description?: string
  description_zh?: string
  /** Default placeholder shown when value is empty. May contain `<<ENV>>`. */
  default?: string
  /** UI hint: render as password input + mask value in API responses. */
  secret?: boolean
  /** True when the field is read from the global settings only — workspace
   *  overrides are ignored at runtime. UI should disable the workspace input
   *  and show a "global only" hint so users don't waste time editing it. */
  globalOnly?: boolean
}

export interface SchemaSection {
  /** Namespace id used in settings.yaml — provider id or skill id. */
  namespaceId: string
  /** Origin: where this section was declared. */
  source: 'general' | 'provider' | 'skill' | 'agent'
  /** Human label for the section header. */
  displayName: string
  displayName_zh?: string
  description?: string
  description_zh?: string
  fields: SchemaField[]
}

/** General settings — built-in declarations for the server's own knobs. */
/** List provider ids from `<global>/models/*.yaml` for the general section's
 *  default-provider enum. Sorted for stable UI ordering. */
function listProviderIds(): string[] {
  const ids: string[] = []
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(GLOBAL_MODELS_DIR, { withFileTypes: true }) } catch { return ids }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
    const parsed = readYamlFile(path.join(GLOBAL_MODELS_DIR, entry.name))
    if (parsed && typeof parsed.id === 'string') ids.push(parsed.id)
  }
  return ids.sort()
}

function generalSection(): SchemaSection {
  const providerIds = listProviderIds()
  // Pick aws-bedrock-claude-invoke if available (legacy default), otherwise the
  // first provider on disk. When no providers are installed the enum has no
  // options and the field renders empty — UI will show it disabled.
  const defaultProvider = providerIds.includes('aws-bedrock-claude-invoke')
    ? 'aws-bedrock-claude-invoke'
    : providerIds[0] ?? ''
  return {
    namespaceId: 'general',
    source: 'general',
    displayName: 'General',
    displayName_zh: '常规',
    description: 'Server behavior parameters (session limits, compaction, sandbox, logging).',
    description_zh: '服务端行为参数（会话限制、压缩、沙箱、日志）。',
    fields: ([
      // system-wide language preference. Read by internal agents (evo, score)
      // that don't load INSTRUCTIONS.md, and available to anything else that
      // wants a language hint without inspecting per-session state.
      { key: 'language', type: 'enum', options: ['en-US', 'zh-CN'], optionLabels: ['English', '中文'], globalOnly: true, description: 'System language (BCP-47). Drives the admin UI language and any internal agents (evo / score) that don\'t load INSTRUCTIONS.md. Single source of truth.', description_zh: '系统语言（BCP-47 区域码）。admin UI 与不加载 INSTRUCTIONS.md 的内部 agent（evo / score）共用。单一来源。', default: 'en-US' },
      // admin UI color theme. Consumed only by the admin frontend (shared/theme);
      // stored server-side so the choice follows the user across browsers.
      { key: 'theme', type: 'enum', options: ['dark', 'light', 'midnight', 'warm'], optionLabels: ['Dark', 'Light', 'Midnight', 'Warm'], globalOnly: true, description: 'Admin UI color theme.', description_zh: 'Admin 界面配色主题。', default: 'dark' },
      // agent scaffold
      { key: 'agent.default_provider', type: 'enum', options: providerIds, description: 'Provider used when scaffolding a new agent. Model id, endpoint, prompt-caching TTL, and thinking defaults are read from that provider\'s YAML.', description_zh: '新建 agent 时使用的供应商。模型 id、endpoint、提示缓存 TTL、Thinking 默认值都从该供应商的 YAML 读取。', default: defaultProvider },
      { key: 'agent.max_retries', type: 'int', description: 'Max attempts per model call on transient errors (rate limit, 5xx, network). Backoff grows between attempts.', description_zh: '单次模型调用遇到瞬态错误（限流、5xx、网络）时的最大尝试次数，重试间隔递增。', default: '5' },
      // session
      { key: 'session.max_queue_size', type: 'int', description: 'Maximum queued messages per session', description_zh: '每个会话最大排队消息数', default: '256' },
      { key: 'session.max_nesting_depth', type: 'int', description: 'Maximum session nesting depth for agent delegation', description_zh: 'Agent 委派的最大会话嵌套深度', default: '16' },
      // compact
      { key: 'compact.compress_at', type: 'float', description: 'Auto-compact threshold as a fraction of max context (e.g. 0.8 = compact when 80% full)', description_zh: '自动压缩阈值，最大上下文的比例（如 0.8 表示用满 80% 时压缩）', default: '0.8' },
      { key: 'compact.keep_messages', type: 'int', description: 'Recent messages kept intact during compaction', description_zh: '压缩时保留最后多少条消息不动', default: '5' },
      { key: 'compact.max_summary_input', type: 'int', description: 'Max chars fed into local truncation fallback', description_zh: '本地截断兜底时的总输入字符上限', default: '15000' },
      { key: 'compact.max_message_slice', type: 'int', description: 'Max chars kept per old message during local truncation', description_zh: '本地截断兜底时每条旧消息保留的最大字符数', default: '800' },
      { key: 'compact.summarize_timeout_sec', type: 'int', description: 'LLM summarization timeout (seconds)', description_zh: 'LLM 摘要超时时间（秒）', default: '300' },
      // sandbox (Linux bwrap only)
      { key: 'sandbox.hidden_dirs', description: 'Comma-separated dirs hidden by bwrap (Linux only)', description_zh: '通过 bwrap tmpfs 隐藏的目录（逗号分隔，仅 Linux）', default: '~/.halo/secrets,~/.aws,~/.ssh,~/.gnupg,~/.docker,~/.config/gh' },
      { key: 'sandbox.writable_dirs', description: 'Comma-separated dirs bind-mounted read-write inside the bwrap sandbox (Linux only) — for external CLIs that keep local state, e.g. ~/.kiro,~/.local/share/kiro-cli. Not applied to readonly sessions.', description_zh: '在 bwrap 沙箱内以可写方式挂载的目录（逗号分隔，仅 Linux）——给需要本地状态的外部 CLI 用，如 ~/.kiro,~/.local/share/kiro-cli。readonly 会话不生效。', default: '' },
      { key: 'sandbox.hidden_files', description: 'Comma-separated files hidden by bwrap (Linux only)', description_zh: '通过 /dev/null bind 隐藏的文件（逗号分隔，仅 Linux）', default: '~/.npmrc,~/.bash_history,~/.gitconfig,~/.git-credentials,~/.netrc' },
      // logging
      { key: 'logging.level', type: 'enum', options: ['debug', 'info', 'warn', 'error'], description: 'Log level', description_zh: '日志级别', default: 'warn' },
      // self-evolution (see plans/self-evolution.md). All evo settings are
      // global-only — the worker / ticker live in the server process and
      // would have to reload mid-flight if a workspace could override them.
      { key: 'evolution.level', type: 'enum', options: ['L0', 'L1'], globalOnly: true, description: 'Self-evolution capability ladder. L0: manual only — drafts via /evo, manual approve/reject. L1: L0 plus automatic drafting on pre-compact. (Queued runs always execute regardless of level; the level only gates how they get enqueued.)', description_zh: '自我进化等级。L0：仅手动——通过 /evo 起草，手动 approve/reject。L1：在 L0 基础上，压缩前（pre-compact）自动起草。（已排队的 run 始终执行，level 只决定如何入队。）', default: 'L0' },
      { key: 'evolution.max_concurrent_run', type: 'int', globalOnly: true, description: 'Max concurrent evo run wrappers (drafting patches).', description_zh: '同时运行的 evo run wrapper 上限（起草 patch）。', default: '1' },
      { key: 'evolution.max_concurrent_apply', type: 'int', globalOnly: true, description: 'Max concurrent evo apply wrappers (merging patches).', description_zh: '同时运行的 evo apply wrapper 上限（合并 patch）。', default: '1' },
      { key: 'evolution.run_timeout_minutes', type: 'int', globalOnly: true, description: 'Heartbeat timeout for run wrappers. The wrapper writes a heartbeat every 60s for as long as it lives, so exceeding this means the wrapper process died — the row is requeued (or marked timeout past max_attempts). This is dead-wrapper detection latency, NOT a budget for slow models; the per-phase model budget is the wrapper-internal 30min cap.', description_zh: 'run wrapper 心跳超时（分钟）。wrapper 存活期间每 60 秒写一次心跳，超时即视为 wrapper 进程已死，任务重排（超过 max_attempts 则标 timeout）。这是死 wrapper 的检测延迟，不是慢模型的运行预算——单阶段模型预算是 wrapper 内部的 30 分钟上限。', default: '12' },
      { key: 'evolution.apply_timeout_minutes', type: 'int', globalOnly: true, description: 'Heartbeat timeout for apply wrappers.', description_zh: 'apply wrapper 心跳超时（分钟）。', default: '5' },
      { key: 'evolution.max_attempts', type: 'int', globalOnly: true, description: 'How many times the ticker may try to spawn a wrapper for a single row before giving up. Stops infinite retry loops on permanently broken tasks.', description_zh: 'ticker 为单条任务尝试拉起 wrapper 的最大次数，超过后放弃。避免坏任务无限重试。', default: '3' },
      { key: 'evolution.triggers.pre_compact', type: 'boolean', globalOnly: true, description: 'Snapshot the session right before compaction so evo can analyze it. /evo is always available regardless of this setting.', description_zh: '在 compact 前快照会话供 evo 分析。/evo 总是可用，与此开关无关。', default: 'true' },
      // limits — runtime caps that protect against runaway tool output / UI
      // freezes. All read live from settings.yaml so changes take effect on
      // the next tool call without a server restart.
      { key: 'limits.shell_output_bytes', type: 'int', globalOnly: true, description: 'Max bytes captured from a single shell_exec call (stdout+stderr combined). Output past this is truncated; the agent sees a "[truncated]" marker.', description_zh: '单次 shell_exec 最多保留的输出字节数（stdout+stderr 合计）。超出部分截断，agent 会看到 [truncated] 标记。', default: String(5 * 1024 * 1024) },
      { key: 'limits.web_fetch_bytes', type: 'int', globalOnly: true, description: 'Max bytes downloaded by a single web_fetch call.', description_zh: '单次 web_fetch 最多下载的字节数。', default: String(50 * 1024) },
      { key: 'limits.grep_default_matches', type: 'int', globalOnly: true, description: 'Default match cap for the grep tool when the call site does not pass an explicit `max`.', description_zh: 'grep 工具未显式传 `max` 参数时的默认匹配上限。', default: '50' },
      { key: 'limits.tool_result_render_chars', type: 'int', globalOnly: true, description: 'Per-tool-result cap on the content fed back to the LLM. Larger results are truncated (with a "[Content truncated]" marker telling the model to re-run with narrower scope) to protect the context window and prompt cache. The UI/admin chat panel shows a far larger slice — see tool_result_ui_chars.', description_zh: '每条 tool result 回传给 LLM 的内容长度上限。超出部分会被截断（并附 [Content truncated] 标记提示模型缩小范围重查），以保护上下文窗口和提示词缓存。UI/admin 聊天面板展示的内容上限要大得多，见 tool_result_ui_chars。', default: '8000' },
      { key: 'limits.tool_result_ui_chars', type: 'int', globalOnly: true, description: 'Per-tool-result cap on the content stored for UI display (admin/web chat panel). Far larger than the LLM cap so the full output of a normal command stays visible, but bounded so a multi-MB `cat` does not bloat the session file, the WS payload, or the browser render. Output past this is truncated with a marker pointing at file_read for the complete content.', description_zh: '每条 tool result 存给 UI 展示（admin/web 聊天面板）的内容长度上限。远大于 LLM 上限，保证普通命令的完整输出都能看到；但仍有界，避免 cat 个几 MB 的文件撑爆会话文件、WS 传输和浏览器渲染。超出部分截断并附标记，提示用 file_read 看完整内容。', default: String(64 * 1024) },
      { key: 'limits.auto_report_chars', type: 'int', globalOnly: true, description: 'Cap on the auto-report a finished sub-agent delivers to its parent. Longer reports are truncated with a pointer to get_session_output for the full text.', description_zh: '子会话完成后自动上报给父会话的内容长度上限。超出截断，并提示用 get_session_output 取全文。', default: '8192' },
      { key: 'limits.ws_event_buffer', type: 'int', globalOnly: true, description: 'Events buffered per detached WebSocket session before the oldest are dropped on reattach.', description_zh: 'WebSocket 会话在断开期间最多缓存多少事件，超出后从最早的开始丢。', default: '5000' },
      { key: 'limits.terminal_scrollback_bytes', type: 'int', globalOnly: true, description: 'Off-screen scrollback bytes retained per persistent terminal while detached.', description_zh: '终端断开期间保留的回滚缓冲字节数。', default: '50000' },
    ] as Array<Omit<SchemaField, 'kind'>>).map((f) => ({ ...f, kind: 'param' as const })),
  }
}

function readYamlFile(p: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = YAML.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

const VALID_TYPES = new Set<FieldType>(['string', 'int', 'float', 'boolean', 'enum'])

function normalizeFieldList(raw: unknown, kind: FieldKind): SchemaField[] {
  if (!Array.isArray(raw)) return []
  const out: SchemaField[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.key !== 'string' || !r.key) continue
    const type = typeof r.type === 'string' && VALID_TYPES.has(r.type as FieldType) ? r.type as FieldType : undefined
    const options = Array.isArray(r.options) ? r.options.filter((v) => typeof v === 'string') as string[] : undefined
    const optionLabels = Array.isArray(r.optionLabels) && options && r.optionLabels.length === options.length
      ? r.optionLabels.filter((v) => typeof v === 'string') as string[]
      : undefined
    // YAML lets `default: 0.8` come through as a number — coerce to string
    // since our SchemaField stores defaults as the canonical string form.
    const defaultRaw = r.default
    const defaultStr = defaultRaw == null
      ? undefined
      : typeof defaultRaw === 'string'
        ? defaultRaw
        : String(defaultRaw)
    out.push({
      key: r.key,
      kind,
      type,
      options,
      optionLabels,
      description: typeof r.description === 'string' ? r.description : undefined,
      description_zh: typeof r.description_zh === 'string' ? r.description_zh : undefined,
      default: defaultStr,
      secret: r.secret === true,
    })
  }
  return out
}

/** Walk `models/*.yaml` and collect each provider's `secrets:` declaration. */
function providerSections(): SchemaSection[] {
  const sections: SchemaSection[] = []
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(GLOBAL_MODELS_DIR, { withFileTypes: true }) } catch { return sections }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
    const parsed = readYamlFile(path.join(GLOBAL_MODELS_DIR, entry.name))
    if (!parsed || typeof parsed.id !== 'string') continue
    const fields = normalizeFieldList(parsed.secrets, 'secret')
    if (fields.length === 0) continue
    sections.push({
      namespaceId: parsed.id,
      source: 'provider',
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : parsed.id,
      displayName_zh: typeof parsed.displayName_zh === 'string' ? parsed.displayName_zh : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      description_zh: typeof parsed.description_zh === 'string' ? parsed.description_zh : undefined,
      fields,
    })
  }
  return sections
}

/** Read one skill directory and turn its config.yaml + SKILL.md
 *  frontmatter into a SchemaSection. Returns null if the skill has no
 *  declarations to surface. Pulled out so it can be called from both
 *  the global and the workspace skills walk. */
function buildSkillSection(skillsDir: string, skillId: string): SchemaSection | null {
  const configPath = path.join(skillsDir, skillId, 'config.yaml')
  if (!fs.existsSync(configPath)) return null
  const parsed = readYamlFile(configPath)
  if (!parsed) return null
  const params = normalizeFieldList(parsed.params, 'param')
  const secrets = normalizeFieldList(parsed.secrets, 'secret')
  if (params.length === 0 && secrets.length === 0) return null
  // Display name comes from SKILL.md frontmatter (`name`); descriptions
  // come from config.yaml. zh fallbacks honour the same {field, field_zh}
  // convention as everywhere else.
  let displayName = skillId
  try {
    const md = fs.readFileSync(path.join(skillsDir, skillId, 'SKILL.md'), 'utf-8')
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/)
    if (m) {
      const nameMatch = m[1].match(/^name:\s*(.+)$/m)
      if (nameMatch) displayName = nameMatch[1].trim()
    }
  } catch { /* skill without SKILL.md still ok */ }
  return {
    namespaceId: skillId,
    source: 'skill',
    displayName,
    displayName_zh: typeof parsed.displayName_zh === 'string' ? parsed.displayName_zh : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    description_zh: typeof parsed.description_zh === 'string' ? parsed.description_zh : undefined,
    fields: [...params, ...secrets],
  }
}

/**
 * Walk `skills/<id>/config.yaml` and collect declarations. When
 * `workspaceRoot` is supplied, *also* scans
 * `<workspaceRoot>/.halo/skills/<id>/config.yaml` and merges — workspace
 * skills with the same id as a global one win (same precedence
 * convention as `agent-loader.resolveSkillPath`). This is what makes a
 * workspace-private skill's params show up under Settings → Skills, so
 * users can configure host/port/token in the admin UI rather than
 * hand-editing settings.yaml. Without this merge, only globally-deployed
 * skills surfaced their declarations and workspace skills were
 * config-invisible.
 */
function skillSections(workspaceRoot?: string): SchemaSection[] {
  const byId = new Map<string, SchemaSection>()
  // Global first, workspace overlays.
  for (const dir of [GLOBAL_SKILLS_DIR, workspaceRoot ? path.join(workspaceRoot, '.halo', 'skills') : null]) {
    if (!dir) continue
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const section = buildSkillSection(dir, entry.name)
      if (section) byId.set(section.namespaceId, section)
    }
  }
  return [...byId.values()]
}

/**
 * Walk `agents/<id>/agent-config.yaml` and collect declarations.
 *
 * Mirrors `skillSections` — agents that need their own params/secrets put
 * them here. Settings UI then groups them under the agent's display name.
 * Note: `agent.yaml` is the agent's own immutable identity (model id, tools,
 * system prompt). `agent-config.yaml` is the per-user-tunable surface.
 */
function agentSections(): SchemaSection[] {
  const sections: SchemaSection[] = []
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(GLOBAL_AGENTS_DIR, { withFileTypes: true }) } catch { return sections }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const agentId = entry.name
    const configPath = path.join(GLOBAL_AGENTS_DIR, agentId, 'agent-config.yaml')
    if (!fs.existsSync(configPath)) continue
    const parsed = readYamlFile(configPath)
    if (!parsed) continue
    const params = normalizeFieldList(parsed.params, 'param')
    const secrets = normalizeFieldList(parsed.secrets, 'secret')
    if (params.length === 0 && secrets.length === 0) continue
    // Display name comes from agent.yaml; falls back to the directory id.
    let displayName = agentId
    try {
      const ay = readYamlFile(path.join(GLOBAL_AGENTS_DIR, agentId, 'agent.yaml'))
      if (ay && typeof ay.name === 'string') displayName = ay.name
    } catch { /* agent without yaml still ok */ }
    sections.push({
      namespaceId: agentId,
      source: 'agent',
      displayName,
      displayName_zh: typeof parsed.displayName_zh === 'string' ? parsed.displayName_zh : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      description_zh: typeof parsed.description_zh === 'string' ? parsed.description_zh : undefined,
      fields: [...params, ...secrets],
    })
  }
  return sections
}

/**
 * Build the full settings schema by aggregating all declared sections.
 * General first, then providers, skills, agents — admin UI re-groups under
 * navigation headings.
 *
 * Pass `workspaceRoot` to additionally surface any workspace-scoped
 * skill declarations (under `<workspaceRoot>/.halo/skills/<id>/config.yaml`).
 * Without it the schema only covers globally-deployed skills.
 */
export function loadSettingsSchema(workspaceRoot?: string): SchemaSection[] {
  return [generalSection(), ...providerSections(), ...skillSections(workspaceRoot), ...agentSections()]
}

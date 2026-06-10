/**
 * Template variable injection for AGENT.md and SKILL.md bodies.
 *
 * Syntax: `{{var}}` or `{{x.y.z}}` — dotted paths resolve against the merged
 * settings.yaml (workspace overrides global). Key names may include [\w-].
 *
 * When a leaf is a self-describing entry { value, description, options }, the
 * `.value` is auto-extracted. Values may contain `<<ENV_NAME>>` env placeholders
 * which are replaced with process.env.ENV_NAME (kept literal if unset).
 *
 * Built-in variables (no dots): args / workspace_root / working_dir / now /
 * user_name / ai_name / agent_name.
 *
 * Unknown placeholders are left as-is and logged.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

const PATTERN = /\{\{\s*([\w-][\w.-]*)\s*\}\}/g
const ENV_PATTERN = /<<([A-Z_][A-Z0-9_]*)>>/g
/** `$ARGUMENTS` or `$1`..`$9` — the standard (non-Halo) skill arg syntax for
 *  user-supplied command-line args. `\$` escapes to a literal `$`. Kept
 *  separate from `{{...}}` (Halo-internal: params / channel / builtins) so an
 *  externally-authored SKILL.md using `$1` runs unchanged. Other `$` (e.g.
 *  `$PATH`, `$5.00`) is left untouched — only `$ARGUMENTS` / `$<single digit>`
 *  is a placeholder. The digit must not be followed by another digit or `.`
 *  (so `$5.00` and `$12` stay literal — a lone `$1` is a placeholder, a price
 *  is not). */
const ARG_PATTERN = /\\\$|\$ARGUMENTS\b|\$([1-9])(?![\d.])/g

/** Split a raw arg string into positional tokens, respecting double quotes:
 *  `create "my coder"` → ['create', 'my coder']. */
export function splitArgs(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2]!)
  return out
}

export interface BuiltinVars {
  args?: string
  workspace_root?: string
  working_dir?: string
  now?: string
  user_name?: string
  ai_name?: string
  agent_name?: string
  /** Channel of origin (telegram / wechat / web / undefined for ws/cli).
   *  Used by skills like cron to default targets to the chat
   *  the user is talking from. */
  'channel.type'?: string
  'channel.account_id'?: string
  'channel.chat_id'?: string
}

export interface RenderContext {
  builtin: BuiltinVars
  settings: Record<string, unknown>   // merged global + workspace, not env-substituted
  /**
   * If set, only `{{<allowedNamespace>.params.<key>}}` placeholders resolve;
   * any other namespace stays literal. Used by AGENT.md so an agent can't
   * borrow a skill's params to escape its own configured surface. Skill
   * activation rewrites the short form to the skill's id and uses that as
   * the allowedNamespace.
   */
  allowedNamespace?: string
}

/** Deep merge: override wins, per-key recursive. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    if (
      typeof override[key] === 'object' && override[key] !== null && !Array.isArray(override[key]) &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, override[key] as Record<string, unknown>)
    } else {
      result[key] = override[key]
    }
  }
  return result
}

/** Read and parse a yaml file, returning {} on any failure. */
async function readYaml(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return YAML.parse(raw) ?? {}
  } catch {
    return {}
  }
}

/** Load merged settings: global + workspace overrides. */
export async function loadMergedSettings(workspaceRoot?: string): Promise<Record<string, unknown>> {
  const global = await readYaml(path.join(homedir(), '.halo', 'secrets', 'settings.yaml'))
  if (!workspaceRoot) return global
  const ws = await readYaml(path.join(workspaceRoot, '.halo', 'settings.yaml'))
  return deepMerge(global, ws)
}

/** Resolve a dotted path in an object. */
function resolvePath(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Extract .value from a self-describing leaf, else return as-is. */
function extractValue(node: unknown): unknown {
  if (node != null && typeof node === 'object' && !Array.isArray(node) && 'value' in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).value
  }
  return node
}

/** Replace <<ENV_NAME>> in a value. Missing env → literal + warn. */
function substituteEnv(value: string): string {
  return value.replace(ENV_PATTERN, (match, name: string) => {
    const envVal = process.env[name]
    if (envVal === undefined) {
      console.log(`[md-vars] Env var "${name}" not set — keeping ${match} literal`)
      return match
    }
    return envVal
  })
}

/**
 * Render a template body with {{var}} placeholders.
 *
 * Resolution order:
 *   1. Built-in (no dots): args / workspace_root / working_dir / now /
 *      user_name / ai_name / agent_name.
 *   2. Settings path matching `<namespace>.params.<key>` — declared params
 *      from a skill or other declarer, e.g. `tavily-search.params.api_key`.
 *      Anything else (including `<x>.secrets.<y>`) stays literal so MD content
 *      visible to the model never leaks server-side secrets.
 */
const PARAM_PATH = /^([\w-]+)\.params\.[\w-][\w.-]*$/

export function renderMdBody(body: string, ctx: RenderContext): string {
  // First pass: standard `$ARGUMENTS` / `$1`..`$9` (user-supplied args). This
  // is independent of the `{{...}}` pass below — different syntax, different
  // source (command-line args vs. Halo-injected values). `\$` → literal `$`.
  const rawArgs = ctx.builtin.args ?? ''
  const positional = splitArgs(rawArgs)
  body = body.replace(ARG_PATTERN, (match, digit?: string) => {
    if (match === '\\$') return '$'
    if (match === '$ARGUMENTS') return rawArgs
    // $1..$9 — 1-based; missing positional → empty string.
    return positional[Number(digit) - 1] ?? ''
  })

  return body.replace(PATTERN, (match, name: string) => {
    if (!name.includes('.')) {
      const builtin = (ctx.builtin as Record<string, string | undefined>)[name]
      if (builtin !== undefined) return builtin
    }
    // Dotted built-ins (e.g. `channel.type`, `channel.chat_id`) — looked
    // up directly by full key; keeps these out of the <id>.params.<key>
    // settings-resolution path.
    if (name.startsWith('channel.')) {
      const builtin = (ctx.builtin as Record<string, string | undefined>)[name]
      // Empty string when the channel field is unset (e.g. ws origin has
      // no chat id) — substitute with empty so skill bodies stay clean.
      return builtin ?? ''
    }

    const m = PARAM_PATH.exec(name)
    if (!m) {
      console.log(`[md-vars] Placeholder "${name}" not on the <id>.params.<key> whitelist — leaving as-is`)
      return match
    }
    if (ctx.allowedNamespace && m[1] !== ctx.allowedNamespace) {
      console.log(`[md-vars] Placeholder "${name}" rejected — caller restricted to namespace "${ctx.allowedNamespace}"`)
      return match
    }
    const raw = resolvePath(ctx.settings, name)
    if (raw === undefined) {
      console.log(`[md-vars] Unknown placeholder "${name}" — leaving as-is`)
      return match
    }
    const leaf = extractValue(raw)
    if (leaf == null) {
      console.log(`[md-vars] Placeholder "${name}" resolved to null — leaving as-is`)
      return match
    }
    const str = typeof leaf === 'string' ? leaf : String(leaf)
    return substituteEnv(str)
  })
}

/** Parse USER.md frontmatter for user_name / ai_name. */
async function readUserMd(workspaceRoot?: string): Promise<{ user_name?: string; ai_name?: string }> {
  const candidates: string[] = []
  if (workspaceRoot) candidates.push(path.join(workspaceRoot, '.halo', 'USER.md'))
  candidates.push(path.join(homedir(), '.halo', 'global', 'USER.md'))
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf-8')
      const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/)
      if (!fm) continue
      const out: { user_name?: string; ai_name?: string } = {}
      for (const line of fm[1].split('\n')) {
        // Strip a trailing CR so a USER.md saved with CRLF (Windows editors)
        // still matches the `$`-anchored pattern below — without this, `\r`
        // sits before end-of-line and the value capture fails silently.
        const m = line.replace(/\r$/, '').match(/^(\w+):\s*(.+)$/)
        if (!m) continue
        if (m[1] === 'user_name') out.user_name = m[2].trim()
        if (m[1] === 'ai_name') out.ai_name = m[2].trim()
      }
      return out
    } catch { /* try next */ }
  }
  return {}
}

/** Build the full render context for a skill/agent md. */
export async function buildRenderContext(opts: {
  args?: string
  workspaceRoot?: string
  workingDir?: string | null
  agentName?: string
  /** Channel origin — surfaced to skills as `{{channel.type}}` /
   *  `{{channel.account_id}}` / `{{channel.chat_id}}`. */
  channel?: { type: string; accountId: string; chatId?: string }
}): Promise<RenderContext> {
  const userMd = await readUserMd(opts.workspaceRoot)
  const settings = await loadMergedSettings(opts.workspaceRoot)
  return {
    builtin: {
      args: opts.args ?? '',
      workspace_root: opts.workspaceRoot ?? '',
      working_dir: opts.workingDir ?? opts.workspaceRoot ?? '',
      now: new Date().toISOString(),
      user_name: userMd.user_name,
      ai_name: userMd.ai_name,
      agent_name: opts.agentName,
      'channel.type': opts.channel?.type,
      'channel.account_id': opts.channel?.accountId,
      'channel.chat_id': opts.channel?.chatId,
    },
    settings,
  }
}

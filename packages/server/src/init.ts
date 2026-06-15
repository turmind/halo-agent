/**
 * Startup initialization — populates and refreshes ~/.halo/.
 *
 * Seed policy:
 *
 * - **Platform-owned files** are force-overwritten on every startup so
 *   version upgrades take effect without user action. Users editing
 *   these are expected to lose their changes — flagged in docs.
 *   Includes:
 *     - `templates/builtin/`           → server-internal platform self-knowledge
 *     - `templates/INSTRUCTIONS.md`    → global instructions
 *     - `templates/prompts/{bootstrap,all,root}/*` → system prompts
 *     - `templates/models/*.yaml`      → model registry
 *     - bundled platform docs (BUNDLED_DOCS list) → ~/.halo/global/docs/
 *     - the 6 built-in agent IDs       → ~/.halo/global/agents/<id>/
 *     - the 7 built-in skill IDs       → ~/.halo/global/skills/<id>/
 *
 * - **User-owned files** are left alone:
 *     - any agent under templates/ that's NOT in BUILTIN_AGENT_IDS
 *     - any skill under templates/ that's NOT in BUILTIN_SKILL_IDS
 *     - in practice this means user-added globals (placed by the user
 *       directly into ~/.halo/global/agents/ or skills/) are untouched.
 *
 * - **secrets/config.yaml** uses leaf-merge: existing leaves preserved,
 *   missing leaves added from template. Lets new server versions ship
 *   new knobs without clobbering the user's password / port.
 *
 * - **secrets/settings.yaml** is created empty if missing; never
 *   touched again. Defaults live in `settings-schema.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Root of the bundled `templates/` directory. Exported for setup helpers
 *  that need to read the schema / optional skills metadata. */
export const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates')

/** Candidate locations for the bundled platform docs, tried in order.
 *  - `packages/server/bundled-docs/` — populated by the packaging step (DMG / npm / etc.)
 *  - repo `.halo/docs/` — the source of truth; used when running from the monorepo */
const DOCS_SRC_CANDIDATES = [
  path.resolve(__dirname, '..', 'bundled-docs'),
  path.resolve(__dirname, '..', '..', '..', '.halo', 'docs'),
]

function resolveDocsSource(): string | null {
  for (const p of DOCS_SRC_CANDIDATES) {
    if (fs.existsSync(p)) return p
  }
  return null
}

const TEMPLATE_VERSION = 23
const VERSION_FILE = '.template-version'

const SKIP_NAMES = new Set(['.DS_Store', 'schema.sql', '__pycache__', '.pytest_cache'])

/** Built-in agents — always overwritten with the server-bundled version on
 *  startup. Edits to these in `~/.halo/global/agents/` will be wiped.
 *  Users who want to customize one should override at workspace scope. */
const BUILTIN_AGENT_IDS = new Set([
  '__apply_agent__',
  '__evo_agent__',
  '__score__',
  'default',
  'executor',
  'deep-executor',
])

/** Built-in skills — same overwrite rule. */
const BUILTIN_SKILL_IDS = new Set([
  'agent',
  'skill',
  'ws',
  'cron',
  // Meta-skill: walks the user through generating a per-remote
  // `ask-<label>` ACP binding skill. The generated bindings live in
  // user-owned skill dirs (workspace or global) and aren't templated;
  // only this generator itself is platform-owned.
  'acp',
  // Always-on file delivery primitive: every channel handler (web /
  // wechat / telegram / slack / feishu) intercepts `MEDIA:<path>` from
  // the agent's reply and uploads it. The skill body teaches the agent
  // when/how to emit that marker. Without this in BUILTIN_SKILL_IDS the
  // skill never gets seeded into ~/.halo/global/skills/, so agents
  // can't discover it via activate_skill.
  'send-file',
  // Capability skills, model-invoked only (user-invocable: false — no slash
  // command). Preinstalled because they're broadly useful out of the box.
  'aws-knowledge',
  'nova-web-search',
  // The agent's visual "face": teaches it that `.halo/canvas/self.html`
  // (seeded per-workspace, see ensureWorkspaceHalo) is a live self-portrait
  // it can drive in real time by emitting `<<<SHOW: …js… >>>`, which the admin
  // forwards verbatim to the open preview. A second channel beyond text.
  'self',
])

/** Docs bundled into `~/.halo/global/docs/` so the platform-knowledge
 *  agent can answer "how do I use Halo" questions in any workspace.
 *  Force-overwritten on startup like other platform-owned files. */
const BUNDLED_DOCS = [
  'guide/getting-started.md',
  'guide/workspace.md',
  'guide/chat.md',
  'guide/sessions.md',
  'guide/agents.md',
  'guide/skills.md',
  'guide/testing-agents-and-skills.md',
  'guide/secrets-and-credentials.md',
  'dev/tools.md',
  'dev/add-model-provider.md',
  'dev/add-channel.md',
  'requirements/settings.md',
  'requirements/command.md',
]

/** Read template file then write to dst. mkdir -p the parent. */
function copyTemplate(srcAbs: string, dstAbs: string): void {
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true })
  const content = fs.readFileSync(srcAbs, 'utf-8')
  fs.writeFileSync(dstAbs, content, 'utf-8')
}

/** writeIfMissing — create the file only when it doesn't exist. */
function writeIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  console.log(`[Init] Created ${filePath}`)
}

/**
 * Field-level merge for built-in agent yaml. We force-overwrite agent.yaml on
 * every startup (to keep system_prompt / tools / skills / context aligned with
 * the platform), but **the `model:` block is preserved** if the user already
 * set one — they're allowed to switch the agent's model from the admin UI and
 * we don't want to clobber that on every restart.
 *
 * First install: copy the template as-is (template has a default model).
 * Existing install: parse both, swap template.model with user.model if user has one.
 */
function mergeAgentYaml(srcAbs: string, dstAbs: string): void {
  if (!fs.existsSync(dstAbs)) {
    copyTemplate(srcAbs, dstAbs)
    return
  }
  try {
    const userDoc = YAML.parseDocument(fs.readFileSync(dstAbs, 'utf-8'))
    const templateDoc = YAML.parseDocument(fs.readFileSync(srcAbs, 'utf-8'))
    const userModel = userDoc.get('model')
    if (userModel != null) {
      templateDoc.set('model', userModel)
    }
    fs.writeFileSync(dstAbs, templateDoc.toString(), 'utf-8')
  } catch (err) {
    console.log(`[Init] mergeAgentYaml fallback (force-copy) for ${dstAbs}: ${err instanceof Error ? err.message : String(err)}`)
    copyTemplate(srcAbs, dstAbs)
  }
}

/** Force-copy a built-in agent directory, with model-block preservation on
 *  the agent.yaml. Other files (AGENT.md, USER.md, etc.) are plain overwrites. */
function forceCopyAgentDir(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return
  fs.mkdirSync(dstDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue
    const srcAbs = path.join(srcDir, entry.name)
    const dstAbs = path.join(dstDir, entry.name)
    if (entry.isDirectory()) {
      forceCopyDir(srcAbs, dstAbs)
    } else if (entry.isFile()) {
      try {
        if (entry.name === 'agent.yaml') {
          mergeAgentYaml(srcAbs, dstAbs)
        } else {
          copyTemplate(srcAbs, dstAbs)
        }
      } catch (err) {
        console.log(`[Init] Failed to seed ${srcAbs}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

// ── Optional skills ─────────────────────────────────────────────────────────

/** Marker file storing user-selected optional skill ids, one per line. */
const INSTALLED_OPTIONAL_SKILLS_FILE = '.installed-optional-skills'

/** Read the list of optional skills the user previously opted into.
 *  Returns empty if the file doesn't exist. Also tolerates blank lines and
 *  comments so the user can hand-edit. */
export function readInstalledOptionalSkills(globalDir: string): string[] {
  const p = path.join(globalDir, INSTALLED_OPTIONAL_SKILLS_FILE)
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** Persist the given skill ids as the new opt-in list. */
export function writeInstalledOptionalSkills(globalDir: string, ids: string[]): void {
  const p = path.join(globalDir, INSTALLED_OPTIONAL_SKILLS_FILE)
  const body = ids.length > 0
    ? ids.join('\n') + '\n'
    : '# (no optional skills installed)\n'
  fs.writeFileSync(p, body, 'utf-8')
}

/** Available optional skills — discovered by scanning templates/optional-skills/.
 *  Returns ids only; setup-time UI wants metadata, see {@link describeOptionalSkill}. */
export function listOptionalSkillIds(): string[] {
  const dir = path.join(TEMPLATES_DIR, 'optional-skills')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort()
}

/** Pull a skill's display name + description from its SKILL.md frontmatter
 *  for setup-time UI hints. */
export function describeOptionalSkill(id: string): { name: string; description: string } {
  const skillMd = path.join(TEMPLATES_DIR, 'optional-skills', id, 'SKILL.md')
  if (!fs.existsSync(skillMd)) return { name: id, description: '' }
  try {
    const text = fs.readFileSync(skillMd, 'utf-8')
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text)
    if (!fmMatch) return { name: id, description: '' }
    const fm = YAML.parse(fmMatch[1]!) as { name?: unknown; description?: unknown }
    return {
      name: typeof fm.name === 'string' ? fm.name : id,
      description: typeof fm.description === 'string' ? fm.description : '',
    }
  } catch {
    return { name: id, description: '' }
  }
}

/** Force-copy each opted-in optional skill from templates → ~/.halo/global/skills/.
 *  Skills the user later removed from the marker file are left on disk
 *  untouched (we don't auto-uninstall — too risky, user may have edited). */
function syncOptionalSkills(globalDir: string): void {
  const opts = new Set(readInstalledOptionalSkills(globalDir))
  if (opts.size === 0) return
  const srcRoot = path.join(TEMPLATES_DIR, 'optional-skills')
  if (!fs.existsSync(srcRoot)) return
  for (const id of opts) {
    const src = path.join(srcRoot, id)
    if (fs.existsSync(src)) {
      forceCopyDir(src, path.join(globalDir, 'skills', id))
    }
  }
}

// ── Generic helpers ─────────────────────────────────────────────────────────

/** Recursively force-copy `srcDir` → `dstDir`. Existing files in dst that
 *  aren't in src are left alone (we only refresh what's bundled). */
function forceCopyDir(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return
  fs.mkdirSync(dstDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue
    const srcAbs = path.join(srcDir, entry.name)
    const dstAbs = path.join(dstDir, entry.name)
    if (entry.isDirectory()) {
      forceCopyDir(srcAbs, dstAbs)
    } else if (entry.isFile()) {
      try {
        copyTemplate(srcAbs, dstAbs)
      } catch (err) {
        console.log(`[Init] Failed to seed ${srcAbs}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

/**
 * Migrate sensitive files from `~/.halo/global/` to `~/.halo/secrets/`.
 * Idempotent — skips files that are already in the target location.
 */
function migrateSecrets(haloHome: string): void {
  const globalDir = path.join(haloHome, 'global')
  const secretsDir = path.join(haloHome, 'secrets')
  fs.mkdirSync(secretsDir, { recursive: true })

  const fileMoves: Array<[string, string]> = [
    [path.join(globalDir, 'settings.yaml'), path.join(secretsDir, 'settings.yaml')],
    [path.join(globalDir, 'config.yaml'), path.join(secretsDir, 'config.yaml')],
  ]
  for (const [src, dst] of fileMoves) {
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.renameSync(src, dst)
      console.log(`[Init] Migrated ${src} → ${dst}`)
    }
  }

  const oldChannelsDir = path.join(globalDir, 'channels')
  const newChannelsDir = path.join(secretsDir, 'channels')
  if (fs.existsSync(oldChannelsDir) && !fs.existsSync(newChannelsDir)) {
    fs.renameSync(oldChannelsDir, newChannelsDir)
    console.log(`[Init] Migrated ${oldChannelsDir} → ${newChannelsDir}`)
  }
}

/**
 * Leaf-merge config.yaml: ensure every leaf in the template exists in the
 * user's file. Existing leaves keep their `value`. New leaves added by a
 * server upgrade are filled in from the template.
 *
 * We use Document API (not raw parse → stringify) so YAML comments and
 * formatting in the user's file survive untouched. Leaves are recognized
 * by their `{ value, default, description, … }` shape.
 */
function mergeConfigYaml(templatePath: string, userPath: string): void {
  if (!fs.existsSync(templatePath)) return

  const templateRaw = fs.readFileSync(templatePath, 'utf-8')
  if (!fs.existsSync(userPath)) {
    // Fresh install — drop the template in as-is.
    fs.mkdirSync(path.dirname(userPath), { recursive: true })
    fs.writeFileSync(userPath, templateRaw, { encoding: 'utf-8', mode: 0o600 })
    try { fs.chmodSync(userPath, 0o600) } catch { /* best-effort */ }
    console.log(`[Init] Created ${userPath}`)
    return
  }

  const userDoc = YAML.parseDocument(fs.readFileSync(userPath, 'utf-8'))
  const templateDoc = YAML.parseDocument(templateRaw)

  let added = 0

  // Walk the template's leaves. A leaf is any node whose YAML shape has the
  // self-documenting `{ value, default, description }` keys. For each leaf,
  // check whether the user's doc has the same path; if not, copy the whole
  // leaf node (including comments) into the user's doc.
  function walk(templateNode: unknown, userNode: unknown, pathParts: string[]): void {
    if (!YAML.isMap(templateNode)) return
    for (const item of templateNode.items) {
      const key = String(item.key)
      const childTemplate = item.value
      const isLeaf = YAML.isMap(childTemplate) && childTemplate.has('value') && childTemplate.has('default')

      if (isLeaf) {
        const childUser = YAML.isMap(userNode) ? userNode.get(key) : undefined
        if (childUser === undefined) {
          // Leaf missing entirely — copy the leaf and any inline comments.
          userDoc.setIn([...pathParts, key], childTemplate)
          added++
        } else if (YAML.isMap(childUser) && !childUser.has('value')) {
          // Partial leaf — fill in `value` from template if user didn't set one.
          userDoc.setIn([...pathParts, key, 'value'], childTemplate.get('value'))
          added++
        }
      } else {
        // Branch node — recurse. Create the branch in user doc if missing.
        if (YAML.isMap(userNode) && !userNode.has(key)) {
          userDoc.setIn([...pathParts, key], childTemplate)
          added++
          // Don't recurse — we just added the whole subtree.
        } else {
          const childUser = YAML.isMap(userNode) ? userNode.get(key) : undefined
          walk(childTemplate, childUser, [...pathParts, key])
        }
      }
    }
  }

  walk(templateDoc.contents, userDoc.contents, [])

  if (added > 0) {
    fs.writeFileSync(userPath, userDoc.toString(), { encoding: 'utf-8', mode: 0o600 })
    try { fs.chmodSync(userPath, 0o600) } catch { /* best-effort */ }
    console.log(`[Init] Filled ${added} missing config.yaml leaves`)
  }
}

/**
 * Ensure the Halo home directory has a complete structure.
 *
 * Force-overwrite policy: see top-of-file comment.
 */
export function ensureHaloHome(haloHome: string): void {
  const globalDir = path.join(haloHome, 'global')
  const secretsDir = path.join(haloHome, 'secrets')
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(secretsDir, { recursive: true })

  migrateSecrets(haloHome)

  // Track template version for diagnostic logging only — file behavior is
  // governed by the per-category overwrite policy, not this number.
  const versionPath = path.join(globalDir, VERSION_FILE)
  let existingVersion = 0
  try {
    existingVersion = parseInt(fs.readFileSync(versionPath, 'utf-8').trim(), 10) || 0
  } catch { /* missing = 0 */ }
  if (existingVersion > 0 && existingVersion < TEMPLATE_VERSION) {
    console.log(`[Init] Seed templates updated: v${existingVersion} → v${TEMPLATE_VERSION}`)
  }

  // ── Always-overwrite: platform-owned files ──────────────────────────────

  // builtin/ — server self-knowledge (PLATFORM_KNOWLEDGE.md, etc.)
  forceCopyDir(path.join(TEMPLATES_DIR, 'builtin'), path.join(globalDir, 'builtin'))

  // INSTRUCTIONS.md
  const instrSrc = path.join(TEMPLATES_DIR, 'INSTRUCTIONS.md')
  if (fs.existsSync(instrSrc)) copyTemplate(instrSrc, path.join(globalDir, 'INSTRUCTIONS.md'))

  // prompts/ — system prompts
  forceCopyDir(path.join(TEMPLATES_DIR, 'prompts'), path.join(globalDir, 'prompts'))

  // models/ — model registry
  forceCopyDir(path.join(TEMPLATES_DIR, 'models'), path.join(globalDir, 'models'))

  // Built-in agents — overwrite each id from the BUILTIN_AGENT_IDS set, but
  // preserve the user's `model:` block (the admin UI lets users change it).
  // Agents not in the set (user-added globals) are left alone entirely.
  const agentsTemplateDir = path.join(TEMPLATES_DIR, 'agents')
  if (fs.existsSync(agentsTemplateDir)) {
    for (const id of BUILTIN_AGENT_IDS) {
      const src = path.join(agentsTemplateDir, id)
      if (fs.existsSync(src)) {
        forceCopyAgentDir(src, path.join(globalDir, 'agents', id))
      }
    }
  }

  // Required skills — always installed and force-overwritten.
  const skillsTemplateDir = path.join(TEMPLATES_DIR, 'skills')
  if (fs.existsSync(skillsTemplateDir)) {
    for (const id of BUILTIN_SKILL_IDS) {
      const src = path.join(skillsTemplateDir, id)
      if (fs.existsSync(src)) {
        forceCopyDir(src, path.join(globalDir, 'skills', id))
      }
    }
  }

  // Optional skills — only refresh those the user opted into via setup.
  // Tracked in `~/.halo/global/.installed-optional-skills`, one id per line.
  // `setup` writes this file when the user picks skills; this loop just
  // re-applies them on every startup so updates propagate.
  syncOptionalSkills(globalDir)

  // ── Bundled platform docs ──────────────────────────────────────────────

  const docsSrc = resolveDocsSource()
  if (!docsSrc) {
    console.log(`[Init] No docs source found — skipping platform docs seed. Searched: ${DOCS_SRC_CANDIDATES.join(', ')}`)
  } else {
    for (const rel of BUNDLED_DOCS) {
      const srcAbs = path.join(docsSrc, rel)
      try {
        copyTemplate(srcAbs, path.join(globalDir, 'docs', rel))
      } catch { /* source doc missing — skip */ }
    }
  }

  // ── secrets/ ──────────────────────────────────────────────────────────

  // config.yaml — leaf-merge. New leaves added by server upgrades flow in;
  // user-set values (password, port, jwt_secret) are preserved.
  mergeConfigYaml(path.join(TEMPLATES_DIR, 'config.yaml'), path.join(secretsDir, 'config.yaml'))

  // settings.yaml — create empty placeholder if missing; never touch
  // afterwards. Defaults live in settings-schema.ts.
  writeIfMissing(path.join(secretsDir, 'settings.yaml'), '')

  // ── Bookkeeping ───────────────────────────────────────────────────────

  try {
    fs.writeFileSync(versionPath, String(TEMPLATE_VERSION), 'utf-8')
  } catch { /* best-effort */ }
}

/**
 * Ensure a workspace has a `.halo/` directory with required sub-dirs.
 * Throws if the workspace root itself doesn't exist — we don't resurrect
 * directories that the user may have renamed or deleted.
 */
export function ensureWorkspaceHalo(workspaceRoot: string): void {
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`Workspace root does not exist: ${workspaceRoot}`)
  }
  const haloDir = path.join(workspaceRoot, '.halo')
  // `evo/*` is the self-evolution working tree (see plans/self-evolution.md).
  // `canvas/` holds the agent's visual face (self.html), force-copied below.
  // Created up-front so the first /note doesn't race on mkdir.
  const dirs = [
    'sessions', 'agents', 'skills', 'logs', 'memory', 'canvas',
    'evo/runs', 'evo/applies', 'evo/history',
  ]
  for (const dir of dirs) {
    fs.mkdirSync(path.join(haloDir, dir), { recursive: true })
  }

  // Force-copy the agent's "face" engine into the workspace on every open.
  // It's platform-owned (like the built-in skills): the canonical source is
  // templates/canvas/self.html, and the agent expresses itself by sending live
  // `<<<SHOW: …>>>` JS to it at runtime — never by editing the file — so
  // overwriting any per-workspace copy here is intended, keeping every
  // workspace on the current engine. Best-effort: a copy failure must never
  // break opening a workspace.
  try {
    const faceSrc = path.join(TEMPLATES_DIR, 'canvas', 'self.html')
    if (fs.existsSync(faceSrc)) {
      copyTemplate(faceSrc, path.join(haloDir, 'canvas', 'self.html'))
    }
  } catch (err) {
    console.log(`[Init] Failed to seed canvas/self.html: ${err instanceof Error ? err.message : String(err)}`)
  }
}

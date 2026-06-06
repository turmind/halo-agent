/**
 * Load and compose USER.md, AGENT.md, INSTRUCTIONS.md, INDEX.md files
 * into a unified prompt injection string.
 *
 * Sources (outer → inner):
 *   1. USER.md                       — user profile (workspace > global)
 *   2. AGENT.md                      — agent personality (workspace > global)
 *   3. INSTRUCTIONS.md (global)      — ~/.halo/global/INSTRUCTIONS.md
 *   4. INSTRUCTIONS.md (ws root)     — <ws>/.halo/INSTRUCTIONS.md
 *   5. INDEX.md                      — <workspaceRoot>/.halo/INDEX.md (project root only)
 *
 * INSTRUCTIONS.md scoping:
 *   - The system prompt carries global + workspace-ROOT INSTRUCTIONS only.
 *     Workspace-root suppresses global (same override as USER.md / AGENT.md) so
 *     a cloned workspace is self-contained and doesn't depend on the machine's
 *     global file to share its conventions.
 *   - Sub-directory INSTRUCTIONS.md are NOT baked into the system prompt. They
 *     are injected per-turn via `loadScopeInstructions` (`@scope` from the user,
 *     `working_dir` on a sub-agent's first turn, or a `scope` arg on
 *     query/interrupt_session). That keeps them loop-scoped — relevant to the
 *     turn that asked for them, not a permanent part of the agent's identity.
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const HALO_HOME = path.join(homedir(), '.halo', 'global')

/** Read a file, return content or empty string */
async function readOptional(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, 'utf-8')).trim()
  } catch {
    return ''
  }
}

/** Write a file, creating parent dirs as needed */
export async function writeMdFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

/** Check if a file exists */
export async function mdFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export interface MdPaths {
  agentMd: string | null
  globalInstructions: string
  /** Workspace-root INSTRUCTIONS.md (<ws>/.halo/INSTRUCTIONS.md). Sub-dir
   *  instructions are not part of the system prompt — see loadScopeInstructions. */
  workspaceInstructions: string | null
  projectIndex: string | null       // <workspaceRoot>/.halo/INDEX.md (only)
  globalUserMd: string              // ~/.halo/global/USER.md
  workspaceUserMd: string | null    // <workspaceRoot>/.halo/USER.md
}

/**
 * Build the list of directories from workspaceRoot down to workingDir (inclusive).
 * Returns entries with `rel` being the path relative to workspaceRoot ("." for workspaceRoot itself).
 * If workingDir is undefined or equals workspaceRoot, returns just [{rel: '.', dir: workspaceRoot}].
 * Throws if workingDir is outside workspaceRoot.
 */
function buildDirChain(workspaceRoot: string, workingDir?: string): Array<{ rel: string; dir: string }> {
  const wsRoot = path.resolve(workspaceRoot)
  const target = workingDir ? path.resolve(workingDir) : wsRoot
  if (target !== wsRoot && !target.startsWith(wsRoot + path.sep)) {
    // workingDir outside workspace — fall back to just root
    return [{ rel: '.', dir: wsRoot }]
  }
  const chain: Array<{ rel: string; dir: string }> = [{ rel: '.', dir: wsRoot }]
  if (target === wsRoot) return chain
  const relFull = path.relative(wsRoot, target)
  const parts = relFull.split(path.sep).filter(Boolean)
  let acc = wsRoot
  const accRel: string[] = []
  for (const part of parts) {
    acc = path.join(acc, part)
    accRel.push(part)
    chain.push({ rel: accRel.join('/'), dir: acc })
  }
  return chain
}

/**
 * Resolve all MD file paths for an agent.
 * @param agentId — agent folder name
 * @param workspaceRoot — project directory (optional)
 * @param workingDir — sub-directory the agent focuses on (optional, absolute path)
 */
export function resolveMdPaths(agentId: string, workspaceRoot?: string): MdPaths {
  const globalAgentDir = path.join(HALO_HOME, 'agents', agentId)
  const wsAgentDir = workspaceRoot ? path.join(workspaceRoot, '.halo', 'agents', agentId) : null

  // Whole-folder override: if the workspace agent dir exists it replaces the
  // global one wholesale, so AGENT.md comes from the workspace dir (absent =
  // empty, no per-file fallback to global). Mirrors loadAgentYaml /
  // agentSourceDir in agent-loader.
  const agentDir = wsAgentDir && fsSync.existsSync(wsAgentDir) ? wsAgentDir : globalAgentDir
  return {
    agentMd: path.join(agentDir, 'AGENT.md'),
    globalInstructions: path.join(HALO_HOME, 'INSTRUCTIONS.md'),
    workspaceInstructions: workspaceRoot ? path.join(workspaceRoot, '.halo', 'INSTRUCTIONS.md') : null,
    projectIndex: workspaceRoot ? path.join(workspaceRoot, '.halo', 'INDEX.md') : null,
    globalUserMd: path.join(HALO_HOME, 'USER.md'),
    workspaceUserMd: workspaceRoot ? path.join(workspaceRoot, '.halo', 'USER.md') : null,
  }
}

/**
 * Load AGENT.md content from the agent's source dir. Whole-folder override:
 * a workspace agent dir replaces global wholesale, so we read AGENT.md from
 * the same dir resolveMdPaths picked (workspace if it exists, else global) —
 * no per-file fallback, keeping path and content consistent.
 */
async function loadAgentMd(agentId: string, workspaceRoot?: string): Promise<string> {
  const agentMd = resolveMdPaths(agentId, workspaceRoot).agentMd
  return agentMd ? readOptional(agentMd) : ''
}

export interface MdContents {
  agentMd: string
  globalInstructions: string
  /** Workspace-root INSTRUCTIONS.md content (<ws>/.halo/INSTRUCTIONS.md), or
   *  '' when absent. Sub-dir instructions are injected per-turn elsewhere
   *  (loadScopeInstructions), not baked into the system prompt. */
  workspaceInstructions: string
  projectIndex: string
  userMd: string
  /** True when no USER.md exists at any level — triggers bootstrap */
  needsBootstrap: boolean
}

/**
 * Load all MD file contents for an agent.
 */
export async function loadAllMdContents(
  agentId: string,
  workspaceRoot?: string,
): Promise<MdContents> {
  const paths = resolveMdPaths(agentId, workspaceRoot)

  const [agentMd, globalInstructions, workspaceInstructions, projectIndex, wsUserMd, globalUserMd] = await Promise.all([
    loadAgentMd(agentId, workspaceRoot),
    readOptional(paths.globalInstructions),
    paths.workspaceInstructions ? readOptional(paths.workspaceInstructions) : Promise.resolve(''),
    paths.projectIndex ? readOptional(paths.projectIndex) : Promise.resolve(''),
    paths.workspaceUserMd ? readOptional(paths.workspaceUserMd) : Promise.resolve(''),
    readOptional(paths.globalUserMd),
  ])

  // Workspace USER.md takes priority over global
  const userMd = wsUserMd || globalUserMd
  const needsBootstrap = !userMd

  // Workspace-root INSTRUCTIONS.md overrides global (not stacked) — keeps a
  // cloned workspace self-contained without depending on the machine's global.
  const effectiveGlobalInstructions = workspaceInstructions ? '' : globalInstructions

  return { agentMd, globalInstructions: effectiveGlobalInstructions, workspaceInstructions, projectIndex, userMd, needsBootstrap }
}

/**
 * Compose MD contents into a single prompt injection string.
 * Only includes sections that have content.
 */
export function composeMdPrompt(contents: MdContents): string {
  const sections: string[] = []

  // User profile comes first — sets the tone for the entire conversation
  if (contents.userMd) {
    sections.push(`## User Profile\n\n${contents.userMd}`)
  }

  if (contents.agentMd) {
    sections.push(contents.agentMd)
  }

  if (contents.globalInstructions) {
    sections.push(`## User Instructions (Global)\n\n${contents.globalInstructions}`)
  }

  // Workspace-root INSTRUCTIONS.md (sub-dir instructions are injected per-turn,
  // not here — see loadScopeInstructions).
  if (contents.workspaceInstructions) {
    sections.push(`## User Instructions\n\n${contents.workspaceInstructions}`)
  }

  if (contents.projectIndex) {
    sections.push(
      `## Project Knowledge\n\n` +
      `Overview of this project plus an index of documentation folders. ` +
      `Use \`file_read\` to load specific docs when you need details.\n\n` +
      contents.projectIndex,
    )
  }
  // When INDEX.md is missing, we inject nothing here — the root agent's
  // PLATFORM_KNOWLEDGE prompt tells it to suggest /organize-workspace when the
  // user engages with project structure.

  return sections.join('\n\n---\n\n')
}

/**
 * All-in-one: load + compose MD prompt for an agent.
 * Returns empty string if no MD files exist.
 */
export async function buildMdPrompt(
  agentId: string,
  workspaceRoot?: string,
): Promise<string> {
  const contents = await loadAllMdContents(agentId, workspaceRoot)
  return composeMdPrompt(contents)
}

/**
 * Load directory-scoped INSTRUCTIONS.md for a turn and render them as one
 * injectable block. Reads the `.halo/INSTRUCTIONS.md` at every level along
 * the workspaceRoot → relDir ancestor path, EXCLUDING the workspace root (whose
 * INSTRUCTIONS.md is already in the system prompt via composeMdPrompt). Levels
 * with no file are skipped; outer levels come before inner.
 *
 * Returns '' when relDir resolves to the workspace root, is outside the
 * workspace, or no sub-level has an INSTRUCTIONS.md. The returned string is a
 * self-describing `<workspace-instructions>` block so the agent understands why
 * it appeared in the turn (it is prepended to the user/initial message by the
 * caller — `@scope`, a sub-agent's first turn, or a query/interrupt scope arg).
 */
export async function loadScopeInstructions(workspaceRoot: string, relDir: string): Promise<string> {
  const abs = path.resolve(workspaceRoot, relDir)
  const chain = buildDirChain(workspaceRoot, abs)
  // Drop the root level (rel === '.') — it lives in the system prompt already.
  const subLevels = chain.filter((e) => e.rel !== '.')
  if (subLevels.length === 0) return ''

  const parts = await Promise.all(
    subLevels.map(async (e) => ({
      rel: e.rel,
      content: await readOptional(path.join(e.dir, '.halo', 'INSTRUCTIONS.md')),
    })),
  )
  const present = parts.filter((p) => p.content)
  if (present.length === 0) return ''

  // Display the directory workspace-relative regardless of whether the caller
  // passed a relative (`@scope`) or absolute (`start_session.working_dir`) path,
  // so the block never leaks the machine's absolute path into the prompt.
  const dirLabel = path.relative(workspaceRoot, abs) || '.'
  const body = present.map((p) => `### ${p.rel}\n\n${p.content}`).join('\n\n')
  return (
    `<workspace-instructions dir="${dirLabel}" note="Directory-scoped guidance injected by the platform for this turn (from .halo/INSTRUCTIONS.md along the path to this directory). Treat as user instructions for work under this path. Does not change where tools execute.">\n` +
    `${body}\n` +
    `</workspace-instructions>`
  )
}

/**
 * Resolve which physical file path to use for reading/writing a specific MD file type.
 * Considers scope (global vs workspace).
 */
export function resolveMdFilePath(
  agentId: string,
  fileType: 'AGENT.md' | 'INSTRUCTIONS.md' | 'INDEX.md',
  scope: 'global' | 'workspace',
  workspaceRoot?: string,
): string | null {
  if (fileType === 'INSTRUCTIONS.md') {
    return scope === 'workspace' && workspaceRoot
      ? path.join(workspaceRoot, '.halo', 'INSTRUCTIONS.md')
      : path.join(HALO_HOME, 'INSTRUCTIONS.md')
  }
  if (fileType === 'INDEX.md') {
    // INDEX.md is always project-level (not per-agent)
    return workspaceRoot ? path.join(workspaceRoot, '.halo', 'INDEX.md') : null
  }
  // AGENT.md — scoped to agent directory
  const baseDir = scope === 'workspace' && workspaceRoot
    ? path.join(workspaceRoot, '.halo', 'agents', agentId)
    : path.join(HALO_HOME, 'agents', agentId)
  return path.join(baseDir, fileType)
}

/**
 * Load system prompts from prompts/{bootstrap,all,root}/.
 *
 * Each subdirectory maps to an injection scope:
 *   - bootstrap/  injected only when a root agent has no USER.md yet
 *   - all/        injected into every agent
 *   - root/       injected only into root agents (parentId === null)
 *
 * Platform self-knowledge (the old `builtin/PLATFORM_KNOWLEDGE.md`) used to be
 * force-injected here; it now lives in the `halo` skill (loaded on demand via
 * `activate_skill`) so it doesn't sit in every root agent's system prompt.
 *
 * Within a subdirectory, all `.md` files are concatenated in filename ascending
 * order. Empty / missing subdirectories are treated as an empty string.
 *
 * Precedence: workspace > global. If <ws>/.halo/prompts/<scope>/ directory
 * exists, it entirely replaces the global one (no merge). This mirrors the
 * agent.yaml / AGENT.md override semantics.
 *
 * Read on every `buildAgentInstance` call so user edits take effect on the next
 * session without a server restart. File I/O is a few KB per call — negligible.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
const GLOBAL_PROMPTS_DIR = path.join(homedir(), '.halo', 'global', 'prompts')

// Empty-string fallback when neither the workspace nor the global prompt dir
// has any .md files. `init.ts` seeds the global dir from `templates/prompts/`
// on first startup, so reaching this fallback means someone deleted or
// corrupted that directory — log a warning and continue with no extra prompt
// rather than hard-coding stale text in the binary.

export interface SystemPrompts {
  bootstrap: string
  all: string
  root: string
  dirs: { bootstrap: string; all: string; root: string }
  /** Absolute paths of the .md files actually loaded for each scope. Empty when built-in fallback is used. */
  files: { bootstrap: string[]; all: string[]; root: string[] }
}

/** Check if a directory exists. */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Pick the .md files that apply to the current platform.
 *
 * Convention: `<stem>.windows.md` is a Windows-specific variant of
 * `<stem>.md`. On Windows the variant *replaces* its same-stem base; on
 * every other OS the variant is ignored. Files without a `.windows` infix
 * load everywhere (unless suppressed by a sibling variant on Windows).
 *
 * Lets us keep platform-neutral guidance in one file and swap only the
 * differing section (e.g. SHELL.md ↔ SHELL.windows.md) per platform, with
 * no duplicated common content.
 */
function selectForPlatform(mdFiles: string[]): string[] {
  const isWin = process.platform === 'win32'
  const winStems = new Set(
    mdFiles.filter((n) => n.endsWith('.windows.md')).map((n) => n.slice(0, -'.windows.md'.length)),
  )
  return mdFiles.filter((n) => {
    if (n.endsWith('.windows.md')) return isWin
    const stem = n.slice(0, -'.md'.length)
    return !(isWin && winStems.has(stem)) // base suppressed by its Windows variant
  })
}

/** Read every .md file in a directory, sorted by filename ascending, joined with blank lines. */
async function loadDir(dirPath: string, fallback: string): Promise<{ content: string; files: string[] }> {
  let entries: string[]
  try {
    entries = await fs.readdir(dirPath)
  } catch {
    console.log(`[SystemPrompts] Directory missing: ${dirPath} — using built-in fallback`)
    return { content: fallback, files: [] }
  }
  const mdFiles = selectForPlatform(entries.filter((n) => n.endsWith('.md')).sort())
  if (mdFiles.length === 0) {
    console.log(`[SystemPrompts] No .md files in ${dirPath} — using built-in fallback`)
    return { content: fallback, files: [] }
  }
  const chunks: string[] = []
  const loaded: string[] = []
  for (const name of mdFiles) {
    const fullPath = path.join(dirPath, name)
    try {
      const content = (await fs.readFile(fullPath, 'utf-8')).trim()
      if (content) {
        chunks.push(content)
        loaded.push(fullPath)
      }
    } catch (err) {
      console.warn(`[SystemPrompts] Failed to read ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (chunks.length === 0) return { content: fallback, files: [] }
  return { content: chunks.join('\n\n'), files: loaded }
}

/**
 * Resolve the directory to load for a given scope.
 * Workspace directory wins if it exists; otherwise fall back to global.
 */
async function resolvePromptsDir(scope: string, workspaceRoot?: string): Promise<string> {
  if (workspaceRoot) {
    const wsDir = path.join(workspaceRoot, '.halo', 'prompts', scope)
    if (await dirExists(wsDir)) return wsDir
  }
  return path.join(GLOBAL_PROMPTS_DIR, scope)
}

/** Load all three scopes in parallel. Workspace prompts/ dirs override global. */
export async function loadSystemPrompts(workspaceRoot?: string): Promise<SystemPrompts> {
  const [bootstrapDir, allDir, rootDir] = await Promise.all([
    resolvePromptsDir('bootstrap', workspaceRoot),
    resolvePromptsDir('all', workspaceRoot),
    resolvePromptsDir('root', workspaceRoot),
  ])
  const [bootstrap, all, root] = await Promise.all([
    loadDir(bootstrapDir, ''),
    loadDir(allDir, ''),
    loadDir(rootDir, ''),
  ])
  return {
    bootstrap: bootstrap.content,
    all: all.content,
    root: root.content,
    dirs: { bootstrap: bootstrapDir, all: allDir, root: rootDir },
    files: {
      bootstrap: bootstrap.files,
      all: all.files,
      root: root.files,
    },
  }
}

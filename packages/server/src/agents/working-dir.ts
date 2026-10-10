import path from 'node:path'
import fs from 'node:fs/promises'

/**
 * Resolve a working-directory argument against a workspace root: absolute or
 * workspace-relative, must stay inside the workspace and be an existing
 * directory. Returns the absolute path. One copy of the rule for a sub-agent's
 * `working_dir` (SessionManager.resolveWorkingDir), `halo cli --dir`, and the
 * cron job folder (REST write points + fire-time check). Standalone so the
 * cron routes / runner can use it without building a SessionManager.
 */
export async function resolveWorkingDir(workspaceRoot: string, input: string): Promise<string> {
  const resolved = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(workspaceRoot, input)
  const wsRoot = path.resolve(workspaceRoot)
  if (resolved !== wsRoot && !resolved.startsWith(wsRoot + path.sep)) {
    throw new Error(`working_dir "${input}" is outside the workspace`)
  }
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) throw new Error(`working_dir "${input}" is not a directory`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('working_dir')) throw err
    throw new Error(`working_dir "${input}" does not exist`)
  }
  return resolved
}

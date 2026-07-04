import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);

export class Workspace {
  constructor(public projectRoot: string) {}

  async init(name: string): Promise<void> {
    // Create project directory
    await mkdir(this.projectRoot, { recursive: true });

    // Create .halo directory structure
    const kavoDir = join(this.projectRoot, '.halo');
    await mkdir(join(kavoDir, 'agent-logs'), { recursive: true });

    // Initialize RULES.md
    const rulesPath = join(this.projectRoot, 'RULES.md');
    const rulesExists = await this.fileExists('RULES.md');
    if (!rulesExists) {
      const initialRules = `# ${name}\n\n## Project Status\nInitialized.\n\n## Completed Tasks\nNone yet.\n\n## Pending Tasks\nNone yet.\n`;
      await writeFile(rulesPath, initialRules, 'utf-8');
    }

    console.log(`[Workspace] Initialized workspace: ${this.projectRoot}`);
  }

  async readFile(path: string): Promise<string> {
    const fullPath = this.validatePath(path);
    return readFile(fullPath, 'utf-8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = this.validatePath(path);
    const dir = resolve(fullPath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  async listFiles(dir?: string, recursive?: boolean): Promise<string[]> {
    const targetDir = dir ? this.validatePath(dir) : this.projectRoot;
    const results: string[] = [];

    if (recursive) {
      await this.walkDir(targetDir, results);
    } else {
      const entries = await readdir(targetDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(targetDir, entry.name);
        const relPath = relative(this.projectRoot, fullPath);
        results.push(entry.isDirectory() ? `${relPath}/` : relPath);
      }
    }

    return results;
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const fullPath = this.validatePath(path);
      await access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  validatePath(path: string): string {
    const fullPath = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path);

    // Root cause: a raw startsWith prefix check passes for a SIBLING directory
    // whose name merely starts with the project name (`/x/myapp-secret` vs
    // `/x/myapp`) — match on a path-segment boundary instead, same as
    // routes/files.ts's validatePath.
    const root = resolve(this.projectRoot);
    if (fullPath !== root && !fullPath.startsWith(root + sep)) {
      throw new WorkspaceError(
        `Path "${path}" is outside the workspace directory "${this.projectRoot}"`,
      );
    }

    // The lexical check above doesn't follow symlinks — a link inside the
    // workspace pointing outside (ws/escape -> /etc) passes startsWith yet
    // reads out of bounds. Resolve symlinks and re-check against the
    // realpath'd root (same pattern as server's assertPathAllowed).
    // realpathSync resolves Windows junctions/symlinks too.
    try {
      const real = realpathSync(fullPath);
      const realRoot = realpathSync(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new WorkspaceError(
          `Path "${path}" is outside the workspace directory "${this.projectRoot}"`,
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      // ENOENT etc. — target doesn't exist yet (new-file case); no symlink
      // to follow, the lexical check above is sufficient.
    }

    return fullPath;
  }

  private async walkDir(dir: string, results: string[], depth = 0): Promise<void> {
    if (depth > 20) return;

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(this.projectRoot, fullPath);

      if (entry.isDirectory()) {
        results.push(`${relPath}/`);
        await this.walkDir(fullPath, results, depth + 1);
      } else {
        results.push(relPath);
      }
    }
  }
}

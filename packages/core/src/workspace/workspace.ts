import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute } from 'node:path';

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

    if (!fullPath.startsWith(this.projectRoot)) {
      throw new WorkspaceError(
        `Path "${path}" is outside the workspace directory "${this.projectRoot}"`,
      );
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

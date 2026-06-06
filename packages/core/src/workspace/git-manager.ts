import simpleGit, { type SimpleGit } from 'simple-git';
import type { Workspace } from './workspace.js';

export class GitManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitManagerError';
  }
}

export class GitManager {
  private git: SimpleGit;

  constructor(private workspace: Workspace) {
    this.git = simpleGit(workspace.projectRoot);
  }

  async init(): Promise<void> {
    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        await this.git.init();
        console.log(`[GitManager] Initialized git repo at ${this.workspace.projectRoot}`);

        // Create initial .gitignore
        const gitignoreContent = [
          'node_modules/',
          'dist/',
          '.next/',
          '.env',
          '.env.local',
          '*.log',
          '.DS_Store',
          '',
        ].join('\n');

        await this.workspace.writeFile('.gitignore', gitignoreContent);
        await this.git.add('-A');
        await this.git.commit('Initial commit');
        console.log('[GitManager] Created initial commit');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] Init error: ${message}`);
      throw new GitManagerError(`Failed to initialize git: ${message}`);
    }
  }

  async commitAll(message: string): Promise<string> {
    try {
      await this.git.add('-A');

      const status = await this.git.status();
      if (status.files.length === 0) {
        console.log('[GitManager] Nothing to commit');
        return '';
      }

      const result = await this.git.commit(message);
      const hash = result.commit || '';
      console.log(`[GitManager] Committed: ${hash} - ${message}`);
      return hash;
    } catch (err) {
      const message2 = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] Commit error: ${message2}`);
      throw new GitManagerError(`Failed to commit: ${message2}`);
    }
  }

  async getDiff(path?: string): Promise<string> {
    try {
      if (path) {
        return await this.git.diff(['HEAD', '--', path]);
      }
      return await this.git.diff(['HEAD']);
    } catch {
      // If no HEAD exists yet (no commits), return empty
      return '';
    }
  }

  async getLog(count = 10): Promise<string> {
    try {
      const log = await this.git.log({ maxCount: count });
      return log.all
        .map(
          (entry) =>
            `${entry.hash.slice(0, 7)} ${entry.date} ${entry.message}`,
        )
        .join('\n');
    } catch {
      return '';
    }
  }
}

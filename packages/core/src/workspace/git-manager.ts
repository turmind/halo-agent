import path from 'node:path';
import { promises as fs } from 'node:fs';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { Workspace } from './workspace.js';

export class GitManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitManagerError';
  }
}

/** One changed file in `getStatus()`. `index`/`workingDir` are the two single
 *  status chars git reports (X = staged side, Y = working-tree side). */
export interface GitFileStatus {
  path: string;
  index: string;
  workingDir: string;
  /** Original path when the file was renamed/copied. */
  from?: string;
}

/** Structured working-tree status — the shape the Source Control panel renders. */
export interface GitStatus {
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

/** One commit in `getLog()` — the structured fields the Graph view renders. */
export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  /** Branch/tag decorations git reports (e.g. "HEAD -> main, tag: v1"); '' when none. */
  refs: string;
  /** Whether this commit is already on the branch's upstream. false = local-only
   *  (the Graph view highlights it). True for every commit when there's no remote
   *  to compare against, so the graph isn't painted entirely as "unpushed". */
  pushed: boolean;
}

/** One file changed by a commit, for the Graph view's per-commit file list.
 *  `status` is the single name-status char (M/A/D/R/C); `from` carries the old
 *  path on a rename/copy so the diff's original side resolves. */
export interface GitCommitFile {
  path: string;
  status: string;
  from?: string;
}

export class GitManager {
  private git: SimpleGit;

  constructor(private workspace: Workspace) {
    this.git = simpleGit(workspace.projectRoot);
  }

  /** Whether the workspace root is itself a git work-tree root — not merely
   *  sitting *inside* an ancestor's repo. git resolves `.git` by walking up the
   *  directory tree, so without this guard a workspace placed under a repo (a
   *  dotfiles `$HOME`, a monorepo subdir) would report the ancestor's entire
   *  status — thousands of files, a multi-MB response. We treat "the toplevel
   *  is not this exact directory" as "not a repo", matching VSCode, which only
   *  activates git when the opened folder is the work-tree root. */
  async isRepoRoot(): Promise<boolean> {
    try {
      const top = (await this.git.revparse(['--show-toplevel'])).trim();
      if (!top) return false;
      const here = await fs.realpath(this.workspace.projectRoot);
      return path.resolve(top) === path.resolve(here);
    } catch {
      return false; // not a work-tree at all
    }
  }

  async init(): Promise<void> {
    try {
      // Use isRepoRoot (not checkIsRepo) so a folder nested inside an ancestor
      // repo still gets its own repo here — checkIsRepo would see the ancestor
      // and silently no-op, leaving the "Initialize Repository" button dead.
      const isRepo = await this.isRepoRoot();
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

  /** Recent commits as structured entries for the Graph view. simple-git's
   *  default log fields already carry hash/date/message/refs/author — map them
   *  through, plus a `pushed` flag (see getUnpushedHashes). Empty array when
   *  there are no commits yet. */
  async getLog(count = 50): Promise<GitLogEntry[]> {
    try {
      const log = await this.git.log({ maxCount: count });
      const unpushed = await this.getUnpushedHashes();
      return log.all.map((entry) => ({
        hash: entry.hash,
        shortHash: entry.hash.slice(0, 7),
        message: entry.message,
        author: entry.author_name,
        date: entry.date,
        refs: entry.refs,
        pushed: !unpushed.has(entry.hash),
      }));
    } catch {
      return [];
    }
  }

  /** Full hashes of commits on HEAD that aren't yet on the branch's upstream —
   *  the "local ahead, not pushed" set the Graph view highlights. One git call,
   *  not per-commit. Three cases:
   *   - upstream configured → `rev-list @{upstream}..HEAD` (the ahead commits).
   *   - no upstream but a remote exists (branch never pushed) → every HEAD commit
   *     is unpushed, so `rev-list HEAD`.
   *   - no remote at all → empty set (nothing to compare against; commits read as
   *     neutral/pushed rather than painting the whole graph as unpushed).
   *  Any failure degrades to an empty set so getLog never throws over this. */
  private async getUnpushedHashes(): Promise<Set<string>> {
    try {
      const hasUpstream = await this.git
        .revparse(['--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
        .then(() => true)
        .catch(() => false);
      let range: string;
      if (hasUpstream) {
        range = '@{upstream}..HEAD';
      } else {
        const remotes = await this.git.getRemotes(false);
        if (remotes.length === 0) return new Set();
        range = 'HEAD';
      }
      const raw = await this.git.raw(['rev-list', range]);
      return new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /** Files changed by a single commit, for the Graph view's expandable file
   *  list. `diff-tree --name-status` against the commit reports one tab-split
   *  line per file: a status char (M/A/D, or R###/C### with old+new paths for
   *  renames/copies) then the path(s). `-r` recurses into subtrees; `-m`
   *  flattens a merge commit's per-parent diffs so merges aren't empty;
   *  `--root` makes the first commit (which has no parent) diff against the
   *  empty tree instead of reporting nothing. */
  async getCommitFiles(hash: string): Promise<GitCommitFile[]> {
    try {
      const raw = await this.git.raw([
        'diff-tree', '--no-commit-id', '--name-status', '-r', '-m', '--root', hash,
      ]);
      const seen = new Set<string>();
      const files: GitCommitFile[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const code = parts[0];
        const status = code[0];
        // Rename/copy lines carry both old and new path; the new path is what
        // we show + diff, the old path becomes `from` for the original side.
        const isRenameOrCopy = status === 'R' || status === 'C';
        const path = isRenameOrCopy ? parts[2] : parts[1];
        if (!path || seen.has(path)) continue; // -m can repeat a path per parent
        seen.add(path);
        files.push({
          path,
          status,
          from: isRenameOrCopy ? parts[1] : undefined,
        });
      }
      return files;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] getCommitFiles error: ${message}`);
      throw new GitManagerError(`Failed to list commit files: ${message}`);
    }
  }

  /** Structured working-tree status. simple-git's StatusResult already carries
   *  current/tracking/ahead/behind and per-file index/working_dir chars — this
   *  just maps it to our flat shape. */
  async getStatus(): Promise<GitStatus> {
    try {
      const status = await this.git.status();
      return {
        branch: status.current,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
        files: status.files.map((f) => ({
          path: f.path,
          index: f.index,
          workingDir: f.working_dir,
          from: f.from || undefined,
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] Status error: ${message}`);
      throw new GitManagerError(`Failed to get status: ${message}`);
    }
  }

  /** Paths ignored by .gitignore, for graying them out in the explorer.
   *  `--porcelain --ignored` collapses an ignored directory to a single `!!`
   *  entry (e.g. `node_modules/`) rather than expanding every file inside it —
   *  so this stays cheap even with huge ignored trees (one call, small list).
   *  Trailing slashes are stripped so paths match the explorer's node paths.
   *  Separate from getStatus() (whose shape is a verified hot path) so adding
   *  this never risks regressing the change list. Empty array when no HEAD/clean. */
  async getIgnoredPaths(): Promise<string[]> {
    try {
      // `core.quotepath=false`: git defaults to octal-escaping non-ASCII paths
      // (e.g. a Chinese dir → `"\344\270\255..."`), which breaks the frontend's
      // startsWith prefix match against the real tree node paths so those dirs
      // never gray out. Disable it so paths come back literal (e.g. `中文目录/`).
      const raw = await this.git.raw(['-c', 'core.quotepath=false', 'status', '--porcelain', '--ignored']);
      return raw
        .split('\n')
        .filter((line) => line.startsWith('!!'))
        .map((line) => line.slice(3).replace(/\/$/, ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Stage the given paths (`git add`). */
  async stage(paths: string[]): Promise<void> {
    try {
      await this.git.add(paths);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] Stage error: ${message}`);
      throw new GitManagerError(`Failed to stage: ${message}`);
    }
  }

  /** Unstage the given paths (`git reset -- <paths>`), keeping working-tree edits. */
  async unstage(paths: string[]): Promise<void> {
    try {
      await this.git.reset(['--', ...paths]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] Unstage error: ${message}`);
      throw new GitManagerError(`Failed to unstage: ${message}`);
    }
  }

  /** Commit what's already staged — unlike `commitAll`, never runs `add -A`. */
  async commit(message: string): Promise<string> {
    try {
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

  /** Push to the upstream remote. On the first push of a branch (no upstream
   *  tracking configured) sets it with `-u origin <branch>`; otherwise a plain
   *  push. Errors (e.g. SSH passphrase, missing creds) propagate verbatim so
   *  the caller can surface git's own message. */
  async push(): Promise<void> {
    try {
      const status = await this.git.status();
      if (!status.tracking && status.current) {
        await this.git.push(['-u', 'origin', status.current]);
      } else {
        await this.git.push();
      }
      console.log('[GitManager] Pushed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] Push error: ${message}`);
      throw new GitManagerError(message);
    }
  }

  /** Configured remotes as `{ name, url }` (push URL). Empty array when none —
   *  the "no remote configured" state the SC panel guides the user through. */
  async getRemotes(): Promise<Array<{ name: string; url: string }>> {
    try {
      const remotes = await this.git.getRemotes(true);
      return remotes.map((r) => ({ name: r.name, url: r.refs.push || r.refs.fetch || '' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] getRemotes error: ${message}`);
      throw new GitManagerError(`Failed to list remotes: ${message}`);
    }
  }

  /** Add a remote (`git remote add <name> <url>`), name typically 'origin'. */
  async addRemote(name: string, url: string): Promise<void> {
    try {
      await this.git.addRemote(name, url);
      console.log(`[GitManager] Added remote ${name} -> ${url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] addRemote error: ${message}`);
      throw new GitManagerError(`Failed to add remote: ${message}`);
    }
  }

  /** Pull from the upstream remote. Errors propagate verbatim. */
  async pull(): Promise<void> {
    try {
      await this.git.pull();
      console.log('[GitManager] Pulled');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitManager] Pull error: ${message}`);
      throw new GitManagerError(message);
    }
  }

  /** Two sides of a file's diff for the Monaco side-by-side viewer.
   *  - `original` is always the committed HEAD version (from `from` when renamed).
   *  - `modified` is the staged blob (`staged`) or the current working-tree file.
   *  Each side independently falls back to '' (added file has no HEAD; deleted
   *  file has no working copy), which is exactly what the diff editor wants.
   *
   *  When `commit` is given, this instead shows that historical commit's own
   *  change for the file — `original` is the parent version (`commit^:path`,
   *  empty for an added file or the root commit) and `modified` is the version
   *  at `commit` (empty for a deletion). The working-tree/staged path above is
   *  left entirely untouched (commit === undefined preserves existing behavior). */
  async getFileDiff(
    path: string,
    staged: boolean,
    from?: string,
    commit?: string,
  ): Promise<{ original: string; modified: string }> {
    if (commit) {
      const parentPath = from || path;
      let original = '';
      try {
        original = await this.git.show([`${commit}^:${parentPath}`]);
      } catch {
        original = ''; // added file, or commit is the root (no parent)
      }
      let modified = '';
      try {
        modified = await this.git.show([`${commit}:${path}`]);
      } catch {
        modified = ''; // deleted in this commit
      }
      return { original, modified };
    }

    const headPath = from || path;
    let original = '';
    try {
      original = await this.git.show([`HEAD:${headPath}`]);
    } catch {
      original = '';
    }

    let modified = '';
    if (staged) {
      try {
        modified = await this.git.show([`:${path}`]);
      } catch {
        modified = '';
      }
    } else {
      try {
        modified = await this.workspace.readFile(path);
      } catch {
        modified = '';
      }
    }

    return { original, modified };
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Workspace } from '../src/workspace/workspace.js'
import { GitManager } from '../src/workspace/git-manager.js'

/**
 * Contract: GitManager backs the admin's Source Control panel. Tests run
 * against real throwaway git repos — the behaviors pinned here (isRepoRoot's
 * ancestor guard, status/log mapping, rename detection, pushed flags) are the
 * exact shapes the panel renders; simple-git-mock tests would prove nothing.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

describe('GitManager', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-git-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const mgr = (dir: string) => new GitManager(new Workspace(dir))

  describe('isRepoRoot', () => {
    it('false for a plain (non-git) directory', async () => {
      expect(await mgr(root).isRepoRoot()).toBe(false)
    })

    it('true for a work-tree root', async () => {
      git(root, 'init')
      expect(await mgr(root).isRepoRoot()).toBe(true)
    })

    it('false for a folder NESTED inside an ancestor repo (the dotfiles-$HOME guard)', async () => {
      // Without this guard the panel would render the ANCESTOR repo's status
      // — thousands of files for a workspace under a dotfiles $HOME.
      git(root, 'init')
      const nested = path.join(root, 'sub', 'workspace')
      fs.mkdirSync(nested, { recursive: true })
      expect(await mgr(nested).isRepoRoot()).toBe(false)
    })
  })

  describe('init', () => {
    it('creates a repo + .gitignore + initial commit in a plain dir', async () => {
      await mgr(root).init()
      expect(fs.existsSync(path.join(root, '.git'))).toBe(true)
      expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(true)
      // Halo runtime state (session transcripts, sqlite) must never land in
      // the first commit.
      const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')
      expect(gitignore).toContain('.halo/sessions/')
      expect(gitignore).toContain('.halo/halo.db')
      expect(git(root, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
    })

    it('initializes its OWN repo even when nested inside an ancestor repo', async () => {
      // checkIsRepo would see the ancestor and silently no-op — the
      // "Initialize Repository" button would be dead. Pin the isRepoRoot path.
      git(root, 'init')
      const nested = path.join(root, 'nested-ws')
      fs.mkdirSync(nested)
      await mgr(nested).init()
      expect(fs.existsSync(path.join(nested, '.git'))).toBe(true)
    })

    it('no-ops when already a repo root (keeps existing history)', async () => {
      const m = mgr(root)
      await m.init()
      const before = git(root, 'rev-parse', 'HEAD').trim()
      await m.init()
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before)
    })
  })

  describe('getStatus', () => {
    it('maps modified / untracked files with index+workingDir chars', async () => {
      await mgr(root).init()
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'v1')
      git(root, 'add', '-A')
      git(root, 'commit', '-m', 'add tracked')
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'v2')   // modified, unstaged
      fs.writeFileSync(path.join(root, 'new.txt'), 'x')         // untracked

      const status = await mgr(root).getStatus()
      const byPath = new Map(status.files.map((f) => [f.path, f]))
      expect(byPath.get('tracked.txt')?.workingDir).toBe('M')
      expect(byPath.get('new.txt')?.workingDir).toBe('?')
      expect(status.branch).toBeTruthy()
      expect(status.tracking).toBeNull()
    })

    it('reports a clean tree as zero files', async () => {
      await mgr(root).init()
      const status = await mgr(root).getStatus()
      expect(status.files).toHaveLength(0)
    })
  })

  describe('stage / unstage / commit', () => {
    it('stage moves a file to the index; unstage keeps working-tree edits', async () => {
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'a.txt'), 'content')
      await m.stage(['a.txt'])
      let status = await m.getStatus()
      expect(status.files.find((f) => f.path === 'a.txt')?.index).toBe('A')

      await m.unstage(['a.txt'])
      status = await m.getStatus()
      expect(status.files.find((f) => f.path === 'a.txt')?.workingDir).toBe('?')
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8')).toBe('content')
    })

    it('commit only commits what is staged (never add -A)', async () => {
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'staged.txt'), 'x')
      fs.writeFileSync(path.join(root, 'unstaged.txt'), 'y')
      await m.stage(['staged.txt'])
      const hash = await m.commit('staged only')
      expect(hash).toBeTruthy()
      const status = await m.getStatus()
      expect(status.files.map((f) => f.path)).toEqual(['unstaged.txt'])
    })

    it('commitAll returns empty string when there is nothing to commit', async () => {
      const m = mgr(root)
      await m.init()
      expect(await m.commitAll('noop')).toBe('')
    })
  })

  describe('getLog', () => {
    it('returns entries newest-first with hash/shortHash/message', async () => {
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'f.txt'), '1')
      await m.commitAll('second commit')
      const log = await m.getLog()
      expect(log.length).toBe(2)
      expect(log[0].message).toBe('second commit')
      expect(log[0].shortHash).toBe(log[0].hash.slice(0, 7))
    })

    it('marks all commits pushed=true when there is NO remote (neutral graph)', async () => {
      // No remote → nothing to compare against; painting the whole history
      // "unpushed" was the original bug this flag semantics fixes.
      const m = mgr(root)
      await m.init()
      const log = await m.getLog()
      expect(log.every((e) => e.pushed)).toBe(true)
    })

    it('marks only ahead-of-upstream commits pushed=false', async () => {
      // Simulate a remote with a bare repo; push, then commit locally on top.
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-git-bare-'))
      try {
        git(bare, 'init', '--bare')
        const m = mgr(root)
        await m.init()
        await m.addRemote('origin', bare)
        await m.push() // sets upstream -u origin <branch>

        fs.writeFileSync(path.join(root, 'local.txt'), 'x')
        await m.commitAll('local only')

        const log = await m.getLog()
        expect(log[0].message).toBe('local only')
        expect(log[0].pushed).toBe(false)
        expect(log[1].pushed).toBe(true)
      } finally {
        fs.rmSync(bare, { recursive: true, force: true })
      }
    })

    it('returns [] when there are no commits yet', async () => {
      git(root, 'init')
      expect(await mgr(root).getLog()).toEqual([])
    })
  })

  describe('getCommitFiles', () => {
    it('reports M/A/D name-status for an ordinary commit', async () => {
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'keep.txt'), 'v1')
      fs.writeFileSync(path.join(root, 'gone.txt'), 'bye')
      await m.commitAll('setup')
      fs.writeFileSync(path.join(root, 'keep.txt'), 'v2')
      fs.rmSync(path.join(root, 'gone.txt'))
      fs.writeFileSync(path.join(root, 'fresh.txt'), 'hi')
      const hash = await m.commitAll('changes')

      const files = await m.getCommitFiles(hash)
      const byPath = new Map(files.map((f) => [f.path, f.status]))
      expect(byPath.get('keep.txt')).toBe('M')
      expect(byPath.get('gone.txt')).toBe('D')
      expect(byPath.get('fresh.txt')).toBe('A')
    })

    it('detects a rename as R with `from` carrying the old path', async () => {
      // Regression pin: diff-tree is plumbing → rename detection is off unless
      // -M is passed explicitly. Without it this rename reads as D+A and the
      // Graph view's original-side diff can never resolve.
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'old-name.txt'), 'stable content\n'.repeat(10))
      await m.commitAll('add file')
      git(root, 'mv', 'old-name.txt', 'new-name.txt')
      const hash = await m.commit('rename it')

      const files = await m.getCommitFiles(hash)
      expect(files).toHaveLength(1)
      expect(files[0].status).toBe('R')
      expect(files[0].path).toBe('new-name.txt')
      expect(files[0].from).toBe('old-name.txt')
    })

    it('reports the root commit against the empty tree (not an empty list)', async () => {
      const m = mgr(root)
      await m.init()
      const rootHash = git(root, 'rev-list', '--max-parents=0', 'HEAD').trim()
      const files = await m.getCommitFiles(rootHash)
      expect(files.map((f) => f.path)).toContain('.gitignore')
      expect(files.every((f) => f.status === 'A')).toBe(true)
    })
  })

  describe('getFileDiff', () => {
    it('working-tree edit: original=HEAD version, modified=current file', async () => {
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'f.txt'), 'old')
      await m.commitAll('base')
      fs.writeFileSync(path.join(root, 'f.txt'), 'new')
      const { original, modified } = await m.getFileDiff('f.txt', false)
      expect(original).toBe('old')
      expect(modified).toBe('new')
    })

    it('added file: original falls back to empty', async () => {
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'added.txt'), 'brand new')
      const { original, modified } = await m.getFileDiff('added.txt', false)
      expect(original).toBe('')
      expect(modified).toBe('brand new')
    })

    it('historical commit: original=parent version, modified=commit version', async () => {
      const m = mgr(root)
      await m.init()
      fs.writeFileSync(path.join(root, 'f.txt'), 'v1')
      await m.commitAll('v1')
      fs.writeFileSync(path.join(root, 'f.txt'), 'v2')
      const hash = await m.commitAll('v2')
      const { original, modified } = await m.getFileDiff('f.txt', false, undefined, hash)
      expect(original).toBe('v1')
      expect(modified).toBe('v2')
    })
  })

  describe('getIgnoredPaths', () => {
    it('collapses an ignored directory to one entry, without trailing slash', async () => {
      const m = mgr(root)
      await m.init() // seeds .gitignore with node_modules/ etc.
      fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), 'x')
      const ignored = await m.getIgnoredPaths()
      expect(ignored).toContain('node_modules')
      expect(ignored.some((p) => p.includes('pkg'))).toBe(false)
    })
  })

  describe('getRemotes / addRemote', () => {
    it('returns [] with no remotes, then the added remote with url', async () => {
      const m = mgr(root)
      await m.init()
      expect(await m.getRemotes()).toEqual([])
      await m.addRemote('origin', 'https://example.com/repo.git')
      expect(await m.getRemotes()).toEqual([{ name: 'origin', url: 'https://example.com/repo.git' }])
    })
  })
})

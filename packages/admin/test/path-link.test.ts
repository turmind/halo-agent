import { describe, it, expect } from 'vitest'
import { parsePathRef, resolvePathRef, workspaceRelative } from '../src/shared/path-link'

/**
 * Contract: chat path links recognise paths by syntax only (inline code /
 * link text), split a trailing `:line[:col]`, and resolve an absolute path
 * inside the workspace to the tree's relative `/` key — Windows roots
 * compared `\`- and case-insensitively; anything else stays external as written.
 */

describe('parsePathRef — positives', () => {
  it.each([
    ['docs/report.md', 'docs/report.md'],
    ['.halo/tmp/x/out.png', '.halo/tmp/x/out.png'],
    ['CHANGELOG.md', 'CHANGELOG.md'],
    ['.gitignore', '.gitignore'],
    ['/home/ubuntu/halo-agent/CHANGELOG.md', '/home/ubuntu/halo-agent/CHANGELOG.md'],
    ['~/notes/todo.md', '~/notes/todo.md'],
    ['docs/', 'docs/'],
    ['/etc/', '/etc/'],
    ['src/features', 'src/features'],
    ['C:\\Users\\me\\proj\\a.ts', 'C:\\Users\\me\\proj\\a.ts'],
    ['c:/Users/me/a.ts', 'c:/Users/me/a.ts'],
    ['src\\features\\a.tsx', 'src\\features\\a.tsx'],
    ['.halo\\tmp\\x.png', '.halo\\tmp\\x.png'],
    ['\\\\server\\share\\dir\\file.txt', '\\\\server\\share\\dir\\file.txt'],
  ])('%s', (text, path) => {
    expect(parsePathRef(text)).toEqual({ path })
  })

  it('splits :line and :line:col', () => {
    expect(parsePathRef('packages/admin/src/a.tsx:120')).toEqual({ path: 'packages/admin/src/a.tsx', line: 120 })
    expect(parsePathRef('a.tsx:12:3')).toEqual({ path: 'a.tsx', line: 12, column: 3 })
  })

  it('a drive colon is not a line separator', () => {
    expect(parsePathRef('C:\\a\\b.ts:12')).toEqual({ path: 'C:\\a\\b.ts', line: 12 })
    expect(parsePathRef('C:\\a\\b.ts:12:3')).toEqual({ path: 'C:\\a\\b.ts', line: 12, column: 3 })
    expect(parsePathRef('D:/x/y.md:7')).toEqual({ path: 'D:/x/y.md', line: 7 })
  })
})

describe('parsePathRef — negatives', () => {
  it.each([
    '', 'npm i', 'pnpm --filter x build', 'hello world.md', 'foo()', 'x=1', 'a<b>', 'a|b', 'a;b', 'a,b', '*.ts', 'what?',
    'http://x', 'https://example.com/a.md', 'file:///etc/hosts',
    '2.1.3', 'v2.1.2', '123', 'README', 'useState',
    '/', '//', '~/', './', '-rf', '--filter',
    'C:', 'a:b:c', 'foo.ts:abc', 'localhost:8527', '12:30', 'C:12',
    '\\n', '\\d+', '//cdn.example.com/x.js',
  ])('%j', (text) => {
    expect(parsePathRef(text)).toBeNull()
  })
})

describe('resolvePathRef', () => {
  const ROOT = '/ws/proj'

  it('relative → workspace key, `./` and a trailing `/` dropped', () => {
    expect(resolvePathRef('docs/a.md', ROOT, null)).toEqual({ kind: 'workspace', path: 'docs/a.md', abs: '/ws/proj/docs/a.md' })
    expect(resolvePathRef('./docs/', ROOT, null)).toEqual({ kind: 'workspace', path: 'docs', abs: '/ws/proj/docs' })
  })

  it('absolute inside the workspace → relative key (one tab per file)', () => {
    expect(resolvePathRef('/ws/proj/docs/a.md', ROOT, null)).toEqual({ kind: 'workspace', path: 'docs/a.md', abs: '/ws/proj/docs/a.md' })
    expect(resolvePathRef('/ws/proj/', ROOT, null)).toEqual({ kind: 'workspace', path: '', abs: ROOT })
  })

  it('absolute outside the workspace stays external, as written', () => {
    expect(resolvePathRef('/etc/hosts', ROOT, null)).toEqual({ kind: 'external', path: '/etc/hosts' })
    expect(resolvePathRef('/ws/proj2/a.md', ROOT, null)).toEqual({ kind: 'external', path: '/ws/proj2/a.md' })
    // POSIX roots are case-sensitive.
    expect(resolvePathRef('/WS/proj/a.md', ROOT, null)).toEqual({ kind: 'external', path: '/WS/proj/a.md' })
  })

  it('expands ~/ with the home dir; no home → unresolvable', () => {
    expect(resolvePathRef('~/todo.md', ROOT, '/home/me')).toEqual({ kind: 'external', path: '/home/me/todo.md' })
    expect(resolvePathRef('~/proj/a.md', '/home/me/proj', '/home/me')).toEqual({ kind: 'workspace', path: 'a.md', abs: '/home/me/proj/a.md' })
    expect(resolvePathRef('~/todo.md', ROOT, null)).toBeNull()
  })

  describe('Windows', () => {
    const WIN = 'C:\\Users\\Me\\proj'

    it('drive + backslash / forward slash inside, any case → relative `/` key', () => {
      expect(resolvePathRef('c:\\users\\me\\proj\\src\\a.ts', WIN, null)).toEqual({ kind: 'workspace', path: 'src/a.ts', abs: 'C:\\Users\\Me\\proj/src/a.ts' })
      expect(resolvePathRef('C:/Users/Me/proj/a.ts', WIN, null)).toEqual({ kind: 'workspace', path: 'a.ts', abs: 'C:\\Users\\Me\\proj/a.ts' })
    })

    it('backslash relative → `/` key', () => {
      expect(resolvePathRef('src\\features\\a.tsx', WIN, null)).toEqual({ kind: 'workspace', path: 'src/features/a.tsx', abs: 'C:\\Users\\Me\\proj/src/features/a.tsx' })
    })

    it('outside: passed through untouched', () => {
      expect(resolvePathRef('D:\\other\\a.ts', WIN, null)).toEqual({ kind: 'external', path: 'D:\\other\\a.ts' })
      expect(resolvePathRef('\\\\server\\share\\f.txt', WIN, null)).toEqual({ kind: 'external', path: '\\\\server\\share\\f.txt' })
      expect(resolvePathRef('~\\notes.md', WIN, 'C:\\Users\\Me')).toEqual({ kind: 'external', path: 'C:\\Users\\Me\\notes.md' })
    })

    it('a Windows path from a POSIX root is just external (the server answers 400/404)', () => {
      expect(resolvePathRef('C:\\a\\b.ts', '/ws/proj', null)).toEqual({ kind: 'external', path: 'C:\\a\\b.ts' })
    })
  })
})

describe('workspaceRelative', () => {
  it('prefix must end on a separator', () => {
    expect(workspaceRelative('/ws/proj-x/a', '/ws/proj')).toBeNull()
    expect(workspaceRelative('/ws/proj/a/b', '/ws/proj/')).toBe('a/b')
  })
  it('case-insensitive only for Windows-style roots', () => {
    expect(workspaceRelative('c:/USERS/me/a.ts', 'C:\\Users\\Me')).toBe('a.ts')
    expect(workspaceRelative('/Ws/a', '/ws')).toBeNull()
  })
})

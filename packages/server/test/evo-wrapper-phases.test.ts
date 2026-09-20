import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// This import is itself the entry-guard test: without the argv[1] === import.meta.url
// gate at the bottom of evo-wrapper.ts, main() would run here and exit the worker with 1.
import {
  spawnProc,
  readPatchFrontmatter,
  extractTestScenario,
  buildEvoSandbox,
  phaseApplyPreflight,
  phaseApplyPublish,
  SANDBOX_WHITELIST,
  PUBLISH_WHITELIST,
  type ApplyCtx,
} from '../src/evolution/evo-wrapper.js'
import { wsHaloDir, evoSandboxHaloDir, wsEvoHistoryDir } from '../src/paths.js'

/**
 * fs-level phases of the evo wrapper, run against a tmp workspace:
 *   - patch.md frontmatter → TestScenario (incl. legacy `message` back-compat)
 *   - buildEvoSandbox whitelist / idempotency / symlink dereference
 *   - phaseApplyPreflight diff + history backup, and the resume invariant
 *     (a second preflight after a half-finished publish must NOT overwrite
 *     the pre-apply backup) + phaseApplyPublish
 *   - spawnProc stdin / tee / log elision / exit code / timeout / spawn error
 */

let tmp: string
let logPath: string
let logFd: number

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-'))
  logPath = path.join(tmp, 'wrapper.log')
  logFd = fs.openSync(logPath, 'a')
})

afterEach(() => {
  fs.closeSync(logFd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

const readLog = () => fs.readFileSync(logPath, 'utf-8')

/** Write `<root>/<rel>`, creating parent dirs. */
function writeFile(root: string, rel: string, content: string): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8')
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel))

describe('readPatchFrontmatter / extractTestScenario', () => {
  const scenario = (patchMd: string) => {
    fs.writeFileSync(path.join(tmp, 'patch.md'), patchMd)
    return extractTestScenario(readPatchFrontmatter(tmp))
  }

  it('parses agentId / testMessage / originalMessage', () => {
    expect(scenario('---\ntestScenario:\n  agentId: a\n  testMessage: t\n  originalMessage: o\n---\nbody'))
      .toEqual({ agentId: 'a', testMessage: 't', originalMessage: 'o' })
  })

  it('legacy single `message` feeds both testMessage and originalMessage', () => {
    expect(scenario('---\ntestScenario:\n  agentId: a\n  message: m\n---\nbody'))
      .toEqual({ agentId: 'a', testMessage: 'm', originalMessage: 'm' })
  })

  it('originalMessage falls back to testMessage', () => {
    expect(scenario('---\ntestScenario:\n  agentId: a\n  testMessage: t\n---\nbody'))
      .toEqual({ agentId: 'a', testMessage: 't', originalMessage: 't' })
  })

  it('returns null without agentId', () => {
    expect(scenario('---\ntestScenario:\n  testMessage: t\n---\nbody')).toBeNull()
  })

  it('returns null when patch.md is missing', () => {
    expect(readPatchFrontmatter(tmp)).toBeNull()
    expect(extractTestScenario(null)).toBeNull()
  })

  it('returns null without a frontmatter block', () => {
    expect(scenario('# just a body\n')).toBeNull()
    expect(readPatchFrontmatter(tmp)).toBeNull()
  })

  it('returns null on invalid YAML', () => {
    expect(scenario('---\nfoo: [\n---\nbody')).toBeNull()
    expect(readPatchFrontmatter(tmp)).toBeNull()
  })
})

describe('buildEvoSandbox', () => {
  let ws: string
  let applyDir: string
  let srcHalo: string
  let dstHalo: string

  beforeEach(() => {
    ws = path.join(tmp, 'ws')
    applyDir = path.join(tmp, 'apply')
    srcHalo = wsHaloDir(ws)
    dstHalo = evoSandboxHaloDir(applyDir)
    writeFile(srcHalo, 'INSTRUCTIONS.md', 'instructions')
    writeFile(srcHalo, 'agents/x/agent.yaml', 'id: x')
    writeFile(srcHalo, 'docs/d.md', 'doc')
    writeFile(srcHalo, 'sessions/s.json', '{}')
    writeFile(srcHalo, 'halo.db', 'sqlite')
  })

  it('copies exactly the whitelist entries that exist', () => {
    buildEvoSandbox(ws, applyDir, logFd)
    expect(read(dstHalo, 'INSTRUCTIONS.md')).toBe('instructions')
    expect(read(dstHalo, 'agents/x/agent.yaml')).toBe('id: x')
    expect(read(dstHalo, 'docs/d.md')).toBe('doc')
    // non-whitelisted entries never cross; missing whitelist entries (USER.md…) are skipped
    expect(fs.readdirSync(dstHalo).sort()).toEqual(['INSTRUCTIONS.md', 'agents', 'docs'])
    expect(readLog()).toContain(`[buildEvoSandbox] cp from ${srcHalo} → ${dstHalo}`)
  })

  it('is idempotent — an entry already in the sandbox is left as-is', () => {
    writeFile(dstHalo, 'INSTRUCTIONS.md', 'keep')
    buildEvoSandbox(ws, applyDir, logFd)
    expect(read(dstHalo, 'INSTRUCTIONS.md')).toBe('keep')
    expect(read(dstHalo, 'agents/x/agent.yaml')).toBe('id: x')
  })

  // Nested symlink (skills/link.md, one level below the whitelist entry) — the
  // case `fs.cpSync({ dereference: true })` gets wrong on Node ≥22.17
  // (nodejs/node#59168), which is why buildEvoSandbox walks the tree itself.
  // Skipped on Windows: symlink creation needs privileges there.
  it.skipIf(process.platform === 'win32')('dereferences symlinks into regular files', () => {
    const target = path.join(tmp, 'real.md')
    fs.writeFileSync(target, 'real content')
    fs.mkdirSync(path.join(srcHalo, 'skills'), { recursive: true })
    fs.symlinkSync(target, path.join(srcHalo, 'skills', 'link.md'))
    buildEvoSandbox(ws, applyDir, logFd)
    const copied = path.join(dstHalo, 'skills', 'link.md')
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(copied, 'utf-8')).toBe('real content')
  })
})

describe('phaseApplyPreflight + phaseApplyPublish', () => {
  const MAIN_INSTRUCTIONS = 'instructions v1'
  const SANDBOX_INSTRUCTIONS = 'instructions v2'
  const AGENT_MD = 'agent a'
  const SKILL_MD = 'new skill'
  const MAIN_DOC = 'doc v1'
  const SANDBOX_DOC = 'doc v2'
  const SKILL_REL = path.join('skills', 'new', 'SKILL.md')

  let ws: string
  let applyDir: string
  let mainHalo: string
  let sandboxHalo: string
  let historyDir: string
  let ctx: ApplyCtx

  beforeEach(() => {
    ws = path.join(tmp, 'ws')
    applyDir = path.join(tmp, 'apply')
    mainHalo = wsHaloDir(ws)
    sandboxHalo = evoSandboxHaloDir(applyDir)
    historyDir = wsEvoHistoryDir(ws, 'ap1')
    ctx = { applyId: 'ap1', workspacePath: ws, applyDir, sourceRunIds: ['r1'], reviewerHint: null, langHint: 'English', logFd }
    writeFile(mainHalo, 'INSTRUCTIONS.md', MAIN_INSTRUCTIONS)
    writeFile(mainHalo, 'agents/a/AGENT.md', AGENT_MD)
    writeFile(mainHalo, 'docs/d.md', MAIN_DOC)
  })

  /** changed / identical / new / docs-only-changed / two non-whitelisted runtime artifacts. */
  function seedSandbox(): void {
    writeFile(sandboxHalo, 'INSTRUCTIONS.md', SANDBOX_INSTRUCTIONS)
    writeFile(sandboxHalo, 'agents/a/AGENT.md', AGENT_MD)
    writeFile(sandboxHalo, SKILL_REL, SKILL_MD)
    writeFile(sandboxHalo, 'docs/d.md', SANDBOX_DOC)
    writeFile(sandboxHalo, 'sessions/x.json', '{}')
    writeFile(sandboxHalo, 'halo.db', 'sqlite')
  }

  async function preflightOk() {
    const res = await phaseApplyPreflight(ctx)
    if (!res.ok) throw new Error(res.reason)
    return res.result
  }

  it('docs is in the sandbox whitelist but not the publish whitelist', () => {
    expect(SANDBOX_WHITELIST).toContain('docs')
    expect(PUBLISH_WHITELIST).not.toContain('docs')
  })

  it('fails when the sandbox is missing', async () => {
    expect(await phaseApplyPreflight(ctx)).toEqual({ ok: false, reason: expect.stringMatching(/sandbox missing/) })
  })

  it('lists only publish-whitelisted files that differ from main', async () => {
    seedSandbox()
    const result = await preflightOk()
    expect(result.fileCount).toBe(2)
    expect(result.historyDir).toBe(historyDir)
    // readdir order is fs-dependent — compare sorted
    expect([...result.changed].sort((a, b) => (a.rel < b.rel ? -1 : 1))).toEqual([
      { rel: 'INSTRUCTIONS.md', full: path.join(sandboxHalo, 'INSTRUCTIONS.md'), existsInMain: true },
      { rel: SKILL_REL, full: path.join(sandboxHalo, SKILL_REL), existsInMain: false },
    ])
  })

  it('snapshots the pre-apply main files + MANIFEST.json into history/', async () => {
    seedSandbox()
    await preflightOk()
    expect(read(historyDir, 'INSTRUCTIONS.md')).toBe(MAIN_INSTRUCTIONS)
    expect(exists(historyDir, SKILL_REL)).toBe(false)
    const manifest = JSON.parse(read(historyDir, 'MANIFEST.json')) as {
      applyId: string; sourceRunIds: string[]; files: Array<{ rel: string; kind: string }>
    }
    expect(manifest.applyId).toBe('ap1')
    expect(manifest.sourceRunIds).toEqual(['r1'])
    expect(manifest.files).toHaveLength(2)
    expect(manifest.files).toEqual(expect.arrayContaining([
      { rel: 'INSTRUCTIONS.md', kind: 'overwrite' },
      { rel: SKILL_REL, kind: 'new' },
    ]))
  })

  it('no-op when the sandbox is byte-equal to main — no history dir', async () => {
    writeFile(sandboxHalo, 'INSTRUCTIONS.md', MAIN_INSTRUCTIONS)
    writeFile(sandboxHalo, 'agents/a/AGENT.md', AGENT_MD)
    writeFile(sandboxHalo, 'docs/d.md', MAIN_DOC)
    const result = await preflightOk()
    expect(result.fileCount).toBe(0)
    expect(result.changed).toEqual([])
    expect(fs.existsSync(historyDir)).toBe(false)
  })

  it('resume after a mid-publish crash keeps the original history backup', async () => {
    seedSandbox()
    await preflightOk()
    // crash mid-publish: only INSTRUCTIONS.md reached main
    fs.copyFileSync(path.join(sandboxHalo, 'INSTRUCTIONS.md'), path.join(mainHalo, 'INSTRUCTIONS.md'))
    const result = await preflightOk()
    expect(result.changed.map((c) => c.rel)).toEqual([SKILL_REL])
    expect(read(historyDir, 'INSTRUCTIONS.md')).toBe(MAIN_INSTRUCTIONS)
    expect(readLog()).toContain('resume path, skipping history backup')
  })

  it('publish copies the changed files into main and leaves docs untouched', async () => {
    seedSandbox()
    const result = await preflightOk()
    await phaseApplyPublish(ctx, result)
    expect(read(mainHalo, 'INSTRUCTIONS.md')).toBe(SANDBOX_INSTRUCTIONS)
    expect(read(mainHalo, SKILL_REL)).toBe(SKILL_MD)
    expect(read(mainHalo, 'docs/d.md')).toBe(MAIN_DOC)
    expect(exists(mainHalo, 'sessions')).toBe(false)
    expect(exists(mainHalo, 'halo.db')).toBe(false)
    expect(readLog()).toContain(`[publish] copied 2 files to ${mainHalo}`)
  })
})

describe('spawnProc', () => {
  const node = process.execPath

  it('round-trips stdin and tees output', async () => {
    const teePath = path.join(tmp, 'tee.log')
    const res = await spawnProc(node, ['-e', 'process.stdin.pipe(process.stdout)'], logFd, teePath, 'hello brief')
    expect(res).toEqual({ exitCode: 0, stdout: 'hello brief', stderr: '' })
    expect(readLog()).toContain('<prompt-on-stdin>')
    // spawnProc resolves on child 'exit' after tee.end() — the fs.WriteStream may
    // still be flushing, so give it a moment rather than asserting synchronously.
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.readFileSync(teePath, 'utf-8')).toContain('hello brief')
  })

  it('elides the last arg from the log when there is no stdin', async () => {
    const res = await spawnProc(node, ['-e', 'process.stdout.write("x")', 'SECRET-ARG'], logFd)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('x')
    const log = readLog()
    expect(log).not.toContain('SECRET-ARG')
    expect(log).toMatch(/<last-arg-omitted>$/m)
  })

  it('captures stderr and the exit code', async () => {
    const res = await spawnProc(node, ['-e', 'process.stderr.write("oops");process.exit(3)'], logFd)
    expect(res.exitCode).toBe(3)
    expect(res.stderr).toBe('oops')
  })

  it.skipIf(process.platform === 'win32')('kills the process group on timeout → 124', async () => {
    const res = await spawnProc(node, ['-e', 'setInterval(()=>{},1000)'], logFd, undefined, undefined, 1)
    expect(res.exitCode).toBe(124)
    expect(readLog()).toContain('timeout 1s — killing process group')
  }, 15_000)

  it('reports a spawn error as exit 1', async () => {
    const res = await spawnProc('/nonexistent/halo-bin', ['--x'], logFd)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('[spawn error]')
    expect(readLog()).toContain('spawn error')
  })
})

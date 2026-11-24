import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildExecScriptArgs,
  buildWriteScriptArgs,
  buildReaddirScriptArgs,
} from '../src/tools/sandbox.js'

/**
 * Contract: caller-controlled PATHS handed to a `bash -c` script must be passed
 * as positional args, never interpolated — otherwise a path containing $(...)
 * executes (the command-injection bug these builders fix). bwrap can't run in
 * CI (needs user namespaces), so we run the EXACT argv the builders produce
 * through the real `bash` directly: bwrap is just a transparent prefix, so
 * proving the inner `bash -c …` is injection-proof proves the real path is too.
 *
 * The tests bite by side effect: a malicious path tries to `touch` a sentinel
 * file. If the sentinel appears, injection happened and the test fails — an
 * assertion that can't pass by encoding a wrong expected value.
 */
describe('sandbox bash-c builders are injection-safe', () => {
  let dir: string
  let sentinel: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-inj-'))
    // Slash-free basename so it can sit inside a $(...) within a single path
    // SEGMENT; we run bash with cwd=dir, so an executed `touch PWNED` lands at
    // dir/PWNED.
    sentinel = path.join(dir, 'PWNED')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Run `bash <args...>` where args are everything after the bwrap prefix
   *  (i.e. the builder output with the leading 'bash','-c' kept). cwd=dir so a
   *  successful injection's `touch PWNED` is observable as dir/PWNED. */
  const runBash = (builderArgs: string[]) => {
    // builderArgs = ['bash', '-c', SCRIPT, 'bash', ...positional]
    const [, , ...rest] = builderArgs
    execFileSync('bash', ['-c', rest[0], ...rest.slice(1)], { stdio: 'pipe', input: 'x', cwd: dir })
  }

  it('write: a $(...) path is NOT executed', () => {
    // $(touch PWNED) sits in a single path segment (no slash) so dirname stays
    // the temp dir and the file lands there under its literal name.
    const malicious = path.join(dir, 'evil-$(touch PWNED).txt')
    runBash(buildWriteScriptArgs(malicious, 'hello'))
    expect(fs.existsSync(sentinel)).toBe(false)
    // The file landed under the LITERAL name (the $(...) was inert text).
    expect(fs.readFileSync(malicious, 'utf-8')).toBe('hello')
  })

  it('write: content is written verbatim, no truncation/eval', () => {
    const target = path.join(dir, 'out.txt')
    const content = "weird $(id) `whoami` ' \" \\ chars"
    runBash(buildWriteScriptArgs(target, content))
    expect(fs.existsSync(sentinel)).toBe(false)
    expect(fs.readFileSync(target, 'utf-8')).toBe(content)
  })

  it('exec: a $(...) workspaceRoot is NOT executed (cd fails, command never reached)', () => {
    const maliciousRoot = path.join(dir, 'root-$(touch PWNED)')
    // The command itself is benign; the attack vector is the ROOT path.
    expect(() => runBash(buildExecScriptArgs(maliciousRoot, 'echo hi'))).toThrow() // cd into nonexistent literal dir fails
    expect(fs.existsSync(sentinel)).toBe(false)
  })

  it('exec: command runs in the given root when the root is legit', () => {
    const out = execFileSync('bash', buildExecScriptArgs(dir, 'pwd').slice(1), { stdio: 'pipe' })
      .toString().trim()
    expect(fs.realpathSync(out)).toBe(fs.realpathSync(dir))
  })

  it('exec: a trailing background command does not background cd/shift or hold the pipes', () => {
    const start = Date.now()
    execFileSync('bash', buildExecScriptArgs(dir, "nohup sh -c 'sleep 2' >/dev/null 2>&1 &").slice(1), { stdio: 'pipe' })
    expect(Date.now() - start).toBeLessThan(1500)
  })

  it.each(['printf ok; # trailing comment', 'printf ok\n# trailing comment', '{ printf ok; }'])('exec: grouping preserves shell syntax: %s', (command) => {
    expect(execFileSync('bash', buildExecScriptArgs(dir, command).slice(1), { stdio: 'pipe' }).toString()).toBe('ok')
  })

  it('readdir: a $(...) dir path is NOT executed', () => {
    const maliciousDir = path.join(dir, 'ls-$(touch PWNED)')
    // ls of a nonexistent literal dir errors — that's fine; what matters is the
    // sentinel never gets created.
    try { runBash(buildReaddirScriptArgs(maliciousDir)) } catch { /* ls error expected */ }
    expect(fs.existsSync(sentinel)).toBe(false)
  })
})

/**
 * Evo wrapper — per-task watchdog and 3-phase orchestrator for `mode=run`.
 *
 * Spawned by the server-side ticker (one process per `evolution_runs` /
 * `evolution_applies` row). The ticker has already flipped the row to
 * `status='running'` and bumped `attempts` before spawning us. We never
 * claim the row ourselves.
 *
 * Run mode is split into three wrapper-driven phases (see plans/self-evolution.md):
 *
 *   Phase A — draft
 *     spawn `halo cli -a __evo_agent__ -n -w <ws>` with the draft brief.
 *     Agent writes patch.md (with testScenario frontmatter) and a sandbox
 *     under <runDir>/sandbox/ — but does NOT run any dry-run.
 *
 *   Phase B — dry-run, retrying-on-error via the agent
 *     spawn `halo cli -a <patch.testScenario.agentId> -n -w <runDir>/sandbox`
 *     with the test message, capped by `timeout 60`. On success, save stdout
 *     to dry-run-output.txt. On failure, save the failure log to
 *     dry-run-fail-<n>.log and re-spawn __evo_agent__ in fix mode pointing
 *     at the failure log; then retry. Bounded fix budget.
 *
 *   Phase C — score
 *     spawn `halo cli -a __score__ -n -w <ws>` with the score brief.
 *     Agent reads patch.md + dry-run-output.txt + source-snapshot.json and
 *     writes score.json. No file edits, no execution.
 *
 * Apply mode was originally a placeholder (phase 11); it is now fully
 * implemented as the two-phase A'/B' flow described in the "Apply mode" block
 * further down (build sandbox + merge approved patches, then regression-score
 * before publishing). Heartbeat runs throughout regardless of phase.
 *
 * Process model: detached from the server (`stdio:'ignore'` + `detached:true`
 * in the ticker spawn) so a server restart doesn't kill running evaluations.
 * We re-import `getEvoDb` here, but the singleton inside this *wrapper*
 * process is independent of the server's — both processes hold their own
 * sqlite handle on the same file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { eq, and } from 'drizzle-orm'
import YAML from 'yaml'
import { createEvoDb, evolutionRuns, evolutionApplies, setEvoDb, getEvoDb } from '../db/evo-db.js'
import { config } from '../config.js'

type Mode = 'run' | 'apply'

interface CliArgs {
  mode: Mode
  id: string
}

/** How many times the wrapper pings __evo_agent__ in fix mode after a failed
 *  dry-run before giving up. We deliberately allow exactly ONE fix pass:
 *  - Two-pass shape (original + one corrective edit) covers the common
 *    failure modes — bad yaml, malformed frontmatter, scope-too-aggressive
 *    test scenario — without spiralling into "agent-loops-forever" territory.
 *  - More than one fix tends to look like the old "edit prompt and retry"
 *    anti-pattern that bloats the budget without converging. If a patch
 *    can't be made dry-run-clean in one corrective edit, it's signal that
 *    the patch should be rejected, not iterated on.
 *  Total dry-run attempts is FIX_BUDGET + 1 = 2. */
const FIX_BUDGET = 1

/** Timeout for each dry-run sub-cli, in seconds. The dry-run runs the user's
 *  target agent (which may be a slow model doing several tool calls), so it
 *  gets the same generous 600s budget as the LLM-driven phases — 180s was
 *  tripping legitimate-but-slow runs. */
const DRY_RUN_TIMEOUT_SEC = 600

/** Wall-clock cap for the LLM-driven phases (draft / fix / score / apply-merge
 *  / apply-score), in seconds. The wrapper heartbeats the row for as long as
 *  the wrapper process itself lives, so a sub-cli that wedges — a model looping
 *  over tool calls, a stalled response stream — would otherwise run unbounded
 *  without the ticker's heartbeat-timeout ever firing (the wrapper is healthy;
 *  only the inner cli is stuck). 10 minutes covers a multi-turn draft on the
 *  default __evo_agent__ model (Opus + xhigh thinking), which legitimately
 *  needed >5min on a long source session; past it, kill and let the phase
 *  fail. Same SIGTERM→exit-124 contract as the dry-run timeout. */
const PHASE_TIMEOUT_SEC = 600

/** Prompt-surface entries copied into the evo sandbox (read side — every
 *  LLM phase reads these via buildEvoSandbox). This is the source of truth
 *  for "what evo is allowed to change". */
const SANDBOX_WHITELIST = ['INSTRUCTIONS.md', 'INDEX.md', 'USER.md', 'agents', 'prompts', 'skills', 'docs']

/** Subset of SANDBOX_WHITELIST that phase 12 publishes back to the main
 *  workspace. Derived from the read whitelist (not a second hardcoded list)
 *  so "what evo can change" and "what gets published" can't silently drift —
 *  every entry evo can edit lands in main except the explicit exclusions
 *  below.
 *
 *  `docs` is excluded: `.halo/docs/` is reference material evo may consult
 *  while drafting, but it never enters any system prompt, so the dry-run /
 *  score pipeline produces no behavior signal for a docs change. Publishing
 *  it would be an unvalidated write — better to drop it at the boundary than
 *  to let an un-scoreable patch reach main. */
const PUBLISH_WHITELIST = SANDBOX_WHITELIST.filter((e) => e !== 'docs')

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      id: { type: 'string' },
    },
  })
  if (values.mode !== 'run' && values.mode !== 'apply') {
    throw new Error(`--mode must be 'run' or 'apply', got ${JSON.stringify(values.mode)}`)
  }
  if (typeof values.id !== 'string' || values.id.length === 0) {
    throw new Error('--id is required')
  }
  return { mode: values.mode, id: values.id }
}

/** Read the row's static metadata. The ticker has already set status=running. */
function loadRunRow(id: string): {
  id: string
  workspacePath: string
  triggerKind: string
  sourceSession: string
  userHint: string | null
} {
  const db = getEvoDb()
  const row = db.select({
    id: evolutionRuns.id,
    workspacePath: evolutionRuns.workspacePath,
    triggerKind: evolutionRuns.triggerKind,
    sourceSession: evolutionRuns.sourceSession,
    userHint: evolutionRuns.userHint,
  }).from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
  if (!row) throw new Error(`evolution_runs row not found: ${id}`)
  return row
}

/** Resolve the `halo` cli executable. Override via $HALO_CLI for dev.
 *  On Windows we return the explicit `halo.cmd`, not the bare `halo`:
 *  the desktop NSIS installer drops `halo.cmd` (cli launcher) and
 *  `Halo.exe` (the GUI) into the same $INSTDIR, both on PATH. PATHEXT
 *  ranks `.EXE` above `.CMD`, so a bare `halo` resolves to the GUI —
 *  which relaunches the app and grabs the global server.lock instead of
 *  running the cli. The `.cmd` suffix forces PATH to the launcher. */
function resolveHaloCli(): string {
  if (process.env.HALO_CLI) return process.env.HALO_CLI
  return process.platform === 'win32' ? 'halo.cmd' : 'halo'
}

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Spawn a child process and capture its stdout / stderr. Pipes child's
 * stdio (we want the bytes, not just a fire-and-forget). Returns once the
 * child exits.
 *
 * `stdinInput` (optional): written to the child's stdin then closed — used to
 * pass long briefs/prompts without overflowing the OS command-line limit
 * (Windows ENAMETOOLONG).
 *
 * `timeoutSec` (optional): a Node timer kills the child after the limit and the
 * result reports exit code 124 (same contract the Linux-only `timeout` binary
 * used to give — but cross-platform). The child is `halo cli` running an agent
 * that itself forks grandchildren via shell_exec (sqlite3, grep, npx …), so a
 * SIGTERM to the direct child PID alone leaves those orphaned and the agent's
 * in-flight LLM turn can run to completion in the background — the "timed out
 * but still running" / "ran twice" bug. We instead put the child in its own
 * process group (detached) and signal the whole group, with a SIGKILL escalation
 * if it doesn't exit within the grace window.
 */
function spawnProc(
  bin: string,
  args: string[],
  logFd: number,
  teePath?: string,
  stdinInput?: string,
  timeoutSec?: number,
): Promise<CliResult> {
  // When the prompt is passed via stdin (long briefs — see callers), no arg is
  // omitted; otherwise the last arg is the prompt and we elide it from the log.
  const loggedArgs = stdinInput === undefined ? args.slice(0, -1) : args
  writeLog(logFd, `[wrapper] $ ${bin} ${loggedArgs.join(' ')}${stdinInput === undefined ? ' <last-arg-omitted>' : ' <prompt-on-stdin>'}${timeoutSec ? ` (timeout ${timeoutSec}s)` : ''}\n`)
  // tee both streams to a per-run sub-cli log when teePath is given. Caller
  // writes its own header into the file (phase markers etc.) before calling.
  // We don't shell-redirect (`>> file`) because we still need the in-memory
  // stdout — wrapper writes it to dry-run-output.txt on success.
  const tee = teePath ? fs.createWriteStream(teePath, { flags: 'a' }) : null
  // Windows can't spawn a `.cmd` directly — Node ≥21.7 rejects it with EINVAL
  // (CVE-2024-27980). Route through `cmd.exe /c`, which Node docs recommend for
  // batch files; it quotes space-containing argv itself, so `-w "C:\a b\ws"`
  // survives (a plain `shell:true` would word-split the path instead).
  const [spawnBin, spawnArgs] = process.platform === 'win32' && bin.endsWith('.cmd')
    ? ['cmd.exe', ['/c', bin, ...args]]
    : [bin, args]
  return new Promise((resolve) => {
    const child = spawn(spawnBin, spawnArgs, {
      // Pipe stdin only when we have input to write — the cli reads a prompt
      // from stdin when it's not a TTY, which is how long briefs are delivered
      // (Windows CreateProcess caps the command line at ~32KB → ENAMETOOLONG
      // if a multi-KB brief rides as an argv element).
      stdio: [stdinInput === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: process.env,
      // Own process group (POSIX) so the timeout can signal the whole tree —
      // the cli plus every shell_exec grandchild — not just the direct PID.
      // No-op contract on Windows, where we kill by PID via taskkill /T below.
      detached: process.platform !== 'win32',
      // Suppress the console window the `cmd.exe /c` wrapper would otherwise
      // pop up on Windows (CREATE_NO_WINDOW). No-op on macOS/Linux.
      windowsHide: true,
    })
    if (stdinInput !== undefined && child.stdin) {
      // Guard against EPIPE: if the child closes stdin before we finish writing,
      // an unhandled stream error would crash the process.
      child.stdin.on('error', () => { /* child closed stdin early; ignore */ })
      child.stdin.write(stdinInput)
      child.stdin.end()
    }
    let stdout = ''
    let stderr = ''
    // Node-native timeout: kill the child after `timeoutSec` and report exit
    // code 124 — the same contract Linux `timeout(1)` had, but cross-platform
    // (Windows has no `timeout` command with this semantic). `timedOut` lets
    // the exit handler override the code regardless of the signal-induced one.
    let timedOut = false
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null
    // Kill the child AND everything it forked. POSIX: the child leads its own
    // process group (detached above), so negating the pid signals the group.
    // Windows: taskkill /T walks the child's process tree. SIGTERM first for a
    // clean exit, then SIGKILL after a grace window if it's still alive (a wedged
    // LLM stream or a stuck shell_exec grandchild won't honour SIGTERM).
    const killTree = (signal: 'SIGTERM' | 'SIGKILL') => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') {
          // Windows has no process groups and child.kill() only ends the direct
          // child — its shell_exec grandchildren (grep/sqlite3/npx) would orphan
          // and keep running. taskkill /T walks the whole tree. /F (force) on the
          // SIGKILL escalation; the SIGTERM pass is a polite taskkill without /F.
          const args = signal === 'SIGKILL'
            ? ['/PID', String(child.pid), '/T', '/F']
            : ['/PID', String(child.pid), '/T']
          spawn('taskkill', args)
        } else {
          // POSIX: child leads its own process group (detached), so negating the
          // pid signals the whole group — the cli and every grandchild.
          process.kill(-child.pid, signal)
        }
      } catch { /* group/tree already gone — nothing to kill */ }
    }
    const killTimer = timeoutSec
      ? setTimeout(() => {
          timedOut = true
          writeLog(logFd, `[wrapper] timeout ${timeoutSec}s — killing process group (SIGTERM)\n`)
          killTree('SIGTERM')
          sigkillTimer = setTimeout(() => {
            writeLog(logFd, `[wrapper] still alive 10s after SIGTERM — SIGKILL\n`)
            killTree('SIGKILL')
          }, 10_000)
          sigkillTimer.unref?.()
        }, timeoutSec * 1000)
      : null
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      tee?.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      tee?.write(chunk)
    })
    child.on('exit', (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      const exitCode = timedOut ? 124 : (code ?? 1)
      writeLog(logFd, `[wrapper] proc exit code=${code} signal=${signal}${timedOut ? ' (timed out → 124)' : ''} stdout=${stdout.length}B stderr=${stderr.length}B\n`)
      tee?.end()
      resolve({ exitCode, stdout, stderr })
    })
    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      writeLog(logFd, `[wrapper] spawn error: ${err.message}\n`)
      tee?.write(`\n[spawn error] ${err.message}\n`)
      tee?.end()
      resolve({ exitCode: 1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` })
    })
  })
}

/** Path to the per-run sub-cli log (tee target for `halo cli` children). */
function subCliLogPath(runDir: string): string {
  return path.join(runDir, 'sub-cli.log')
}

/** Append a phase header into sub-cli.log so a single tail covers
 *  draft → fix → dry-run → score with clear markers. */
function appendSubCliHeader(runDir: string, header: string): void {
  try {
    fs.appendFileSync(subCliLogPath(runDir), `\n=== ${new Date().toISOString()} ${header} ===\n`)
  } catch { /* best effort */ }
}

/**
 * Resolve the user's preferred natural language for evo / score / fix
 * agent output. Internal agents skip USER.md / INSTRUCTIONS.md loading
 * (so they can't pick up the "Reply in the same language" rule from
 * platform prompts), so we read the system-wide `general.language`
 * setting and pass the result through brief.
 *
 * `config.language` returns `'en' | 'zh'` regardless of whether the user
 * stored `en-US`, `zh-CN`, etc. — collapse happens in config.
 */
function resolveLangHint(): string {
  return config.language === 'zh' ? '简体中文' : 'English'
}

/**
 * Common language clause appended to every brief (draft / fix / score /
 * apply-merge / apply-score). Forbids mixed-language output explicitly.
 *
 * Earlier observations that drove this wording:
 *   - When given just `Output language: 简体中文` (a header line), agents
 *     treated it as metadata and ignored it. So we use direct imperatives.
 *   - With the imperative version, agents kept patch.md / score.json
 *     pure-Chinese but **left dropped-into-prompt-file prose in English**.
 *     E.g. when copying a global INSTRUCTIONS.md (English) into the
 *     sandbox and adding a Chinese rule, they'd leave the
 *     pre-existing English sections verbatim — producing a
 *     half-Chinese half-English file that's ugly and confuses LLMs
 *     consuming it later. So we now explicitly say: prose drafted into
 *     prompt files counts as "your output" and must be translated.
 *
 * What stays as-is in source language regardless:
 *   - YAML/JSON keys (target, testScenario, agentId, lint, behavior, ...)
 *   - Identifier-like values (file paths, agent ids, command names,
 *     enum values like 'high'/'medium'/'low', encoding names like
 *     'utf-8-sig', shell binaries like `printf`)
 *   - Literal code or CLI snippets quoted verbatim
 *   - Section headings in target prompt files that act as anchors that
 *     the rest of the platform / other tooling references by exact
 *     string (don't blindly translate "## Tools" if downstream code
 *     might grep for it — when in doubt, keep the heading and translate
 *     the body)
 */
function buildLanguageClause(langHint: string, scope: string): string[] {
  return [
    '',
    `Output language: write ${scope} in ${langHint}. Do NOT code-switch —`,
    `don't sprinkle English phrases like "blast radius" or "scope" into`,
    `otherwise-${langHint} prose, and don't mix ${langHint} tokens into`,
    `otherwise-English prose. Pick the language and stay in it.`,
    '',
    `**This rule also applies to prose you draft INTO the patched prompt`,
    `files**, not just to your own commentary. If you copy a global file`,
    `(e.g. global INSTRUCTIONS.md, AGENT.md) into a workspace override`,
    `and the source is in a different language, translate the prose into`,
    `${langHint} as you go. Don't leave a half-English half-${langHint}`,
    `Frankenstein file in the sandbox.`,
    '',
    `Things that stay in their source form regardless of language:`,
    `frontmatter / JSON keys, identifier-like values (file paths, agent`,
    `ids, command names, enum values like 'high'/'medium'/'low',`,
    `encoding names like 'utf-8-sig', shell binaries like `+'`'+`printf`+'`'+`),`,
    `literal code or CLI snippets you're quoting, and section headings`,
    `that other tooling might grep for by exact string (when in doubt,`,
    `keep the heading and translate the body).`,
  ]
}

/** Read and YAML-parse the frontmatter of patch.md. Returns null if the
 *  file is missing or has no frontmatter block. */
function readPatchFrontmatter(runDir: string): Record<string, unknown> | null {
  const patchPath = path.join(runDir, 'patch.md')
  let raw: string
  try { raw = fs.readFileSync(patchPath, 'utf-8') } catch { return null }
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return null
  try {
    const parsed = YAML.parse(m[1]) as Record<string, unknown> | null
    return parsed ?? null
  } catch { return null }
}

/**
 * Test scenario block parsed from patch.md frontmatter.
 *
 * Two messages with distinct purposes:
 *   - `testMessage` is what the wrapper feeds to the dry-run sub-cli. Should
 *     be a clean, self-contained probe authored by the drafter to exercise
 *     the patched rule.
 *   - `originalMessage` is what the scorer uses to find the "before" baseline
 *     in source-snapshot.json. Must appear (verbatim or near-verbatim) in
 *     the snapshot's rawMessages so the scorer can locate the assistant
 *     turn that followed it.
 *
 * Back-compat: older patches wrote a single `message` field. If we see only
 * `message`, treat it as both `originalMessage` and `testMessage` so old
 * runs keep working.
 */
interface TestScenario {
  agentId: string
  testMessage: string
  originalMessage: string
}

function extractTestScenario(fm: Record<string, unknown> | null): TestScenario | null {
  if (!fm) return null
  const ts = fm.testScenario
  if (!ts || typeof ts !== 'object') return null
  const o = ts as Record<string, unknown>
  if (typeof o.agentId !== 'string' || o.agentId.length === 0) return null

  const testMessage = typeof o.testMessage === 'string' && o.testMessage.length > 0
    ? o.testMessage
    : (typeof o.message === 'string' && o.message.length > 0 ? o.message : null)
  if (!testMessage) return null

  const originalMessage = typeof o.originalMessage === 'string' && o.originalMessage.length > 0
    ? o.originalMessage
    : testMessage

  return { agentId: o.agentId, testMessage, originalMessage }
}

/** Build the brief handed to __evo_agent__ in draft mode. Short — AGENT.md
 *  has the procedure; we just pin context. */
interface PromptFileSnapshot {
  scope: 'workspace' | 'global'
  path: string
  content: string
}

interface EvoContext {
  agentId: string
  assembledSystemPrompt: string | null
  promptFiles: PromptFileSnapshot[]
  agents: Array<{ id: string; scope: 'workspace' | 'global' | 'builtin'; description?: string }>
  skills: Array<{ id: string; scope: 'workspace' | 'global' | 'builtin'; description?: string }>
}

/** Read evo-context.json (written by enqueue) — best-effort. Returns null
 *  if the file is missing or unparseable; brief builders fall back to
 *  bare-minimum context in that case. */
function readEvoContext(runDir: string, logFd: number): EvoContext | null {
  const p = path.join(runDir, 'evo-context.json')
  if (!fs.existsSync(p)) {
    writeLog(logFd, `[brief] evo-context.json missing at ${p}\n`)
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as EvoContext
  } catch (err) {
    writeLog(logFd, `[brief] evo-context.json parse failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  }
}

interface DumpedImage {
  /** Path relative to runDir, e.g. `images/12-0.png`. */
  relPath: string
  /** 0-indexed message position in `rawMessages`. */
  msgIdx: number
  /** 0-indexed content-block position within the message. */
  blockIdx: number
  /** `'user' | 'assistant'` */
  role: string
  /** e.g. `image/png`. */
  mediaType: string
  /** Decoded byte size. */
  sizeBytes: number
  /** Adjacent text in the same message, if any — gives evo a hint of how
   *  the image was framed by the user / agent. Truncated at 200 chars. */
  contextText: string
}

/** Walk the snapshot's rawMessages, decode every base64 image content block
 *  to `<runDir>/images/<msgIdx>-<blockIdx>.<ext>`, and return a manifest
 *  the brief builders can render. Image content stays as proper vision
 *  blocks in the inherited messages — these dumped paths just give evo a
 *  way to *reference* an image as a prompt resource (e.g. cp into the
 *  sandbox for a skill that needs an example screenshot). Failures are
 *  logged and skipped, never aborting the run.
 *
 *  Video / audio / document blocks are not dumped — Halo currently has
 *  no view_video / view_audio tool, so those rarely appear as content
 *  blocks; when they do, the wrapper records them in the manifest with
 *  no file path so evo knows they exist but can't be referenced. */
function dumpSnapshotImages(runDir: string, logFd: number): DumpedImage[] {
  const snapshotPath = path.join(runDir, 'source-snapshot.json')
  if (!fs.existsSync(snapshotPath)) return []
  let parsed: { rawMessages?: Array<{ role: string; content: unknown }> }
  try {
    parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
  } catch {
    writeLog(logFd, `[dumpSnapshotImages] snapshot parse failed\n`)
    return []
  }
  const messages = Array.isArray(parsed.rawMessages) ? parsed.rawMessages : []
  if (messages.length === 0) return []

  const imagesDir = path.join(runDir, 'images')
  fs.mkdirSync(imagesDir, { recursive: true })

  const out: DumpedImage[] = []
  const extByMime: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }

  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]!
    if (!msg || !Array.isArray(msg.content)) continue

    // Pull adjacent text blocks for context. Concatenated, trimmed at 200.
    const adjacentText = (msg.content as Array<{ type?: string; text?: unknown }>)
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => String(b.text))
      .join(' ')
      .trim()
      .slice(0, 200)

    for (let b = 0; b < (msg.content as unknown[]).length; b++) {
      const block = (msg.content as unknown[])[b] as Record<string, unknown> | null | undefined
      if (!block || typeof block !== 'object') continue

      // Three places an image block can live:
      //  1. directly as a top-level content block
      //  2. inside a tool_result.content (array form)
      const candidates: Array<{ block: Record<string, unknown>; subBlockIdx: number | null }> = []
      if (block.type === 'image') {
        candidates.push({ block, subBlockIdx: null })
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const inner = block.content as unknown[]
        for (let i = 0; i < inner.length; i++) {
          const sub = inner[i] as Record<string, unknown> | null
          if (sub && sub.type === 'image') {
            candidates.push({ block: sub, subBlockIdx: i })
          }
        }
      }

      for (const c of candidates) {
        const source = c.block.source as Record<string, unknown> | undefined
        if (!source || source.type !== 'base64') continue
        const data = source.data
        const mediaType = source.media_type
        if (typeof data !== 'string' || typeof mediaType !== 'string') continue
        const ext = extByMime[mediaType] ?? 'bin'
        const fileName = c.subBlockIdx == null
          ? `${m}-${b}.${ext}`
          : `${m}-${b}-${c.subBlockIdx}.${ext}`
        const fullPath = path.join(imagesDir, fileName)
        try {
          const buf = Buffer.from(data, 'base64')
          fs.writeFileSync(fullPath, buf)
          out.push({
            relPath: `images/${fileName}`,
            msgIdx: m,
            blockIdx: b,
            role: typeof msg.role === 'string' ? msg.role : '?',
            mediaType,
            sizeBytes: buf.length,
            contextText: adjacentText,
          })
        } catch (err) {
          writeLog(logFd, `[dumpSnapshotImages] decode failed at msg=${m} block=${b}: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      }
    }
  }

  if (out.length > 0) {
    writeLog(logFd, `[dumpSnapshotImages] decoded ${out.length} image(s) to ${imagesDir}\n`)
  }
  return out
}

function renderImageManifest(images: DumpedImage[]): string[] {
  if (images.length === 0) return []
  const lines: string[] = []
  lines.push('=== Images extracted from the source conversation ===')
  lines.push('')
  lines.push('(decoded from inline image content blocks; the same images are')
  lines.push('also visible to you as vision blocks in your message history.')
  lines.push('Use these file paths only when your patch needs to keep an')
  lines.push('image as a prompt resource — e.g. a screenshot inside a skill\'s')
  lines.push('reference doc — and you want the wrapper to reference it later.')
  lines.push('Most patches won\'t need this; the conversation evidence in your')
  lines.push('message history is usually enough.)')
  lines.push('')
  for (const img of images) {
    const sizeKb = (img.sizeBytes / 1024).toFixed(0)
    lines.push(`- ${img.relPath}`)
    lines.push(`  msg ${img.msgIdx} / block ${img.blockIdx}, role=${img.role}, ${img.mediaType}, ${sizeKb} KB`)
    if (img.contextText) lines.push(`  context: ${img.contextText.replace(/\n/g, ' ')}`)
  }
  lines.push('')
  return lines
}

/** Render the prompt-file snapshot block and the agent/skill listings as
 *  brief sections. Used by both the draft brief and the score brief. */
function renderEvoContextSections(ctx: EvoContext | null): string[] {
  if (!ctx) return ['(prompt surface unavailable — evo-context.json missing or invalid)']
  const lines: string[] = []

  lines.push(`Triggering agent id: ${ctx.agentId}`)
  lines.push('')

  if (ctx.assembledSystemPrompt) {
    lines.push('=== Assembled system prompt at trigger time ===')
    lines.push('(this is what the source agent saw as its `system` field on the')
    lines.push('Bedrock call — built from AGENT.md + INSTRUCTIONS.md + USER.md +')
    lines.push('prompts/all + prompts/root + workspace info, in runtime order)')
    lines.push('```')
    lines.push(ctx.assembledSystemPrompt)
    lines.push('```')
    lines.push('')
  }

  if (ctx.promptFiles.length > 0) {
    lines.push('=== Source prompt files ===')
    lines.push('(each entry is a file the assembled prompt was built from. Workspace')
    lines.push('files take precedence over global ones at runtime. The agent.yaml /')
    lines.push('SKILL.md / template-version files are NOT included — those are')
    lines.push('config / metadata, not prompt content.)')
    lines.push('')
    for (const f of ctx.promptFiles) {
      lines.push(`--- ${f.scope}/${f.path} ---`)
      lines.push('```')
      lines.push(f.content)
      lines.push('```')
      lines.push('')
    }
  }

  if (ctx.agents.length > 0) {
    lines.push('=== Agents in this workspace ===')
    for (const a of ctx.agents) lines.push(`  ${a.id} [${a.scope}]`)
    lines.push('')
  }

  if (ctx.skills.length > 0) {
    // Absolute path to the global skills dir, resolved by the wrapper (a Node
    // process) so the brief never embeds a hardcoded `~/.halo/...` that the
    // agent would have to expand — `homedir()` gives the right root and
    // path.join the right separator on Windows / macOS / Linux alike.
    const globalSkillsDir = path.join(homedir(), '.halo', 'global', 'skills')
    lines.push('=== Skills in this workspace ===')
    for (const s of ctx.skills) lines.push(`  ${s.id} [${s.scope}]`)
    lines.push('')
    // Skill *contents* aren't inlined (SKILL.md + sibling resources are too
    // large to pack into every brief). Only this listing is. So unlike the
    // prompt files above, you must file_read a skill yourself to see it —
    // and the path depends on the scope tag, because the sandbox you're
    // running in only mirrors the workspace layer:
    lines.push('To read a skill\'s content, file_read its SKILL.md (you have full')
    lines.push('file access — absolute paths resolve):')
    lines.push(`  [workspace] → ${path.join('<workspace>', '.halo', 'skills', '<id>', 'SKILL.md')}`)
    lines.push(`  [global] / [builtin] → ${path.join(globalSkillsDir, '<id>', 'SKILL.md')}`)
    lines.push('A [global]/[builtin] skill is NOT inside your sandbox — read it')
    lines.push(`from ${globalSkillsDir} directly; don't glob the sandbox for it.`)
    lines.push('Sibling resource files live next to SKILL.md in that same dir.')
    lines.push('')
  }

  return lines
}

function buildDraftBrief(args: {
  runId: string
  workspacePath: string
  runDir: string
  triggerKind: string
  userHint: string | null
  langHint: string
  evoContext: EvoContext | null
  images: DumpedImage[]
}): string {
  const lines = [
    'You are running as the Evolution drafter (mode: DRAFT).',
    '',
    `Run id: ${args.runId}`,
    `Workspace: ${args.workspacePath}`,
    `Working dir: ${args.runDir}`,
    `Trigger: ${args.triggerKind}`,
  ]
  if (args.userHint) lines.push(`Reviewer hint: ${args.userHint}`)
  lines.push(
    '',
    'The triggering agent\'s full message log lives on disk:',
    `  ${path.join(args.runDir, 'tool-flow.md')}        — clipped, fast skim`,
    `  ${path.join(args.runDir, 'source-snapshot.json')}    — full rawMessages`,
    '',
    'Read tool-flow.md first to understand what the user wanted, what the',
    'agent did, and where it diverged. Each tool_result is clipped to a',
    '~200-char peek (with the `is_error` flag when the tool failed) —',
    'enough to see the *shape* of the flow without re-tokenizing large',
    'grep / shell outputs. Fall back to source-snapshot.json only for',
    'messages whose full tool result actually matters to your patch.',
    '',
    ...renderEvoContextSections(args.evoContext),
    ...renderImageManifest(args.images),
    '=== Non-text media note ===',
    '',
    'Inline images in source-snapshot.json are base64 — you can\'t view them',
    'directly the way you would inherited vision blocks. The `images/` dump',
    '(see manifest above) decodes them to disk so you can `view_image` if',
    'a specific image is load-bearing. Video, audio, and binary documents',
    '(PDF, etc.) are even more limited: at trigger time the source agent',
    'worked with them via shell tooling (ffmpeg, pdftotext, etc.), and your',
    'view is limited to the textual results those tools produced (visible',
    'inside source-snapshot.json as tool_result text).',
    '',
    'When the patch you have in mind requires understanding what\'s INSIDE',
    'the media file (a video\'s visual content, an audio\'s acoustic',
    'content, a PDF\'s layout), the dry-run test scenario can\'t reliably',
    'verify it — skipping the run is the right call. When the patch is',
    'about the shell-tooling pattern itself (how to call ffmpeg, how to',
    'grep its output, how to handle credential errors), it can be',
    'verified at the textual level and the run proceeds normally.',
    '',
    '=== Task ===',
    '',
    'Decide what change in the prompt surface above would help the next time',
    'a similar conversation comes up. Three shapes, in order of preference:',
    'rewrite an existing rule; tighten / reorganize what\'s there; or, only',
    'when neither applies, add a new rule.',
    '',
    `Sandbox path: ${path.join(args.runDir, 'sandbox')}`,
    '',
    'When you have a change worth making, write `patch.md` (frontmatter +',
    'body) and one new file at `<runDir>/sandbox/.halo/<target>` with the',
    'full new contents. AGENT.md describes the patch.md schema.',
    '',
    'When the conversation has no signal worth a patch (rule already covers,',
    'too short to learn from, agent did fine, depends on media content',
    'you can\'t see), write `<runDir>/.skip.md` with a one or two sentence',
    'reason instead, and skip the rest.',
    '',
    ...buildLanguageClause(args.langHint, 'all natural-language content (patch.md body, prose drafted into sandbox files, .skip.md body)'),
  )
  return lines.join('\n')
}

/** Build the brief for __evo_agent__ in fix mode. Points at the failure log. */
function buildFixBrief(args: {
  runId: string
  workspacePath: string
  runDir: string
  failLogPath: string
  attempt: number
  maxAttempts: number
  langHint: string
}): string {
  // Read failure log so the agent doesn't need file_read.
  let failLogText = ''
  try {
    failLogText = fs.readFileSync(args.failLogPath, 'utf-8')
  } catch {
    failLogText = `(failed to read ${args.failLogPath})`
  }
  return [
    'You are running as the Evolution drafter (mode: FIX).',
    '',
    `Run id: ${args.runId}`,
    `Workspace: ${args.workspacePath}`,
    `Working dir: ${args.runDir}`,
    `Fix attempt: ${args.attempt}/${args.maxAttempts}`,
    '',
    `An earlier draft pass produced patch.md + a sandbox at`,
    `${path.join(args.runDir, 'patch.md')} and`,
    `${path.join(args.runDir, 'sandbox', '.halo')} respectively.`,
    'The dry-run failed; the wrapper\'s failure log:',
    '',
    '```',
    failLogText,
    '```',
    '',
    'Read patch.md (and the affected sandbox file) to see what was tried.',
    `Read tool-flow.md / source-snapshot.json for the original conversation`,
    'context if you need to reconsider the patch direction. Then write the',
    `corrected sandbox target file (<runDir>/sandbox/.halo/<target>) and`,
    'update patch.md if the fix changes the test scenario. Wrapper reruns',
    'the dry-run after you exit.',
    '',
    ...buildLanguageClause(args.langHint, 'all natural-language content (patch.md body, prose drafted into sandbox files)'),
  ].join('\n')
}

/** Build the brief for the scorer (`__score__`). Packs patch.md +
 *  dry-run-output.txt + meta.json + evo-context.json so the scorer needs
 *  no `file_read` to inspect inputs. */
function buildScoreBrief(args: {
  runId: string
  workspacePath: string
  runDir: string
  langHint: string
  evoContext: EvoContext | null
  logFd: number
}): string {
  function readOrEmpty(p: string, label: string): string {
    try { return fs.readFileSync(p, 'utf-8') }
    catch (err) {
      writeLog(args.logFd, `[buildScoreBrief] ${label} read failed: ${err instanceof Error ? err.message : String(err)}\n`)
      return `(${label} unavailable)`
    }
  }
  const patchMd = readOrEmpty(path.join(args.runDir, 'patch.md'), 'patch.md')
  const dryRun = readOrEmpty(path.join(args.runDir, 'dry-run-output.txt'), 'dry-run-output.txt')
  const meta = readOrEmpty(path.join(args.runDir, 'meta.json'), 'meta.json')

  return [
    'You are running as the Evolution scorer.',
    '',
    `Run id: ${args.runId}`,
    `Workspace: ${args.workspacePath}`,
    `Working dir: ${args.runDir}`,
    '',
    `The original conversation lives on disk:`,
    `  ${path.join(args.runDir, 'tool-flow.md')}    — clipped, fast skim`,
    `  ${path.join(args.runDir, 'source-snapshot.json')}  — full rawMessages, when needed`,
    'Read tool-flow.md first to find the user turn matching',
    '`testScenario.originalMessage` and the assistant reply that followed',
    'it. Fall back to source-snapshot.json only when the full tool result',
    'matters. The current prompt surface and patch context follow.',
    '',
    ...renderEvoContextSections(args.evoContext),
    '=== patch.md ===',
    '```',
    patchMd,
    '```',
    '',
    '=== dry-run-output.txt ===',
    '(stdout from the wrapper running the patched sandbox against',
    '`testScenario.testMessage`. Two execution constraints to keep in',
    'mind when scoring:',
    '',
    ' 1. Sandbox runs under `--access workspace`. The agent can read/write',
    '    inside the sandbox but `~/.aws`, `~/.ssh`, `~/.kube`, `~/.docker`,',
    '    `~/.gnupg`, `~/.halo/secrets` are all masked. A "command not',
    '    found" or "Unable to locate credentials" failure on cloud or',
    '    system-credential operations is expected — interpret it as "we',
    '    cut the wires for safety", not as the patch breaking real',
    '    behavior. Score behavior on whether the agent gave the right',
    '    KIND of response, not on whether external side effects fired.',
    '',
    ' 2. Inline images in your message history are real vision blocks',
    '    you can see; video / audio / binary documents (PDF, etc.) are',
    '    not in your context. At trigger time the source agent worked',
    '    with them via shell tooling (ffmpeg, pdftotext, etc.); your view',
    '    is limited to the textual results. The dry-run\'s `testMessage`',
    '    is also text-only — patches whose value depends on understanding',
    '    media internals naturally show low-signal dry-runs and that\'s',
    '    correctly reflected in `confidence: low` rather than punished',
    '    via behavior score.)',
    '```',
    dryRun,
    '```',
    '',
    '=== meta.json ===',
    '```',
    meta,
    '```',
    '',
    '=== Task ===',
    '',
    'From `patch.md` frontmatter, take `testScenario.originalMessage` and',
    'find the assistant turn that followed it in tool-flow.md (or',
    'source-snapshot.json) — that\'s your baseline. Compare baseline to',
    'dry-run-output.txt, rate lint / behavior / scope, write',
    '`<runDir>/score.json` with the shape AGENT.md describes.',
    '',
    ...buildLanguageClause(args.langHint, 'the score.json "notes" field'),
    'The numeric fields and "confidence" enum stay in their canonical form.',
  ].join('\n')
}

/**
 * Phase A outcome:
 *   - 'skipped'  → evo wrote `.skip.md`, deciding the run has no patch
 *                  worth proposing. Wrapper short-circuits straight to
 *                  finalize without running phase B/C.
 *   - 'drafted'  → evo wrote patch.md + sandbox/.halo. Wrapper proceeds
 *                  to phase B (dry-run) and phase C (score).
 *   - 'failed'   → evo neither wrote .skip.md nor produced patch.md +
 *                  sandbox. Wrapper marks the run failed.
 *
 * The agent picks 'skipped' vs 'drafted' explicitly — we don't infer it
 * by diff'ing the sandbox against main. That keeps the contract simple
 * and lets the agent's reasoning ("rule already exists, nothing to add")
 * be the canonical signal.
 */
type DraftOutcome = 'skipped' | 'drafted' | 'failed'


async function phaseDraft(args: {
  runId: string
  workspacePath: string
  runDir: string
  triggerKind: string
  userHint: string | null
  langHint: string
  logFd: number
}): Promise<DraftOutcome> {
  writeLog(args.logFd, `\n=== Phase A: draft ===\n`)
  const evoContext = readEvoContext(args.runDir, args.logFd)
  const images = dumpSnapshotImages(args.runDir, args.logFd)
  // Build the sandbox before spawning. drafter / scorer / fix all run
  // against this same sandbox — never the user's real workspace — so
  // session rows + any incidental writes stay in the run dir, not in
  // `<user-ws>/.halo/halo.db`. The sandbox starts as a whitelist
  // cp of the user workspace so the agent reads the same prompt
  // surface (file_read continues to work for INSTRUCTIONS, agent.yaml,
  // etc.); writes go to `<runDir>/sandbox/.halo/<target>` either
  // way (drafter's patch output target == sandbox).
  buildEvoSandbox(args.workspacePath, args.runDir, args.logFd)
  const sandboxWs = path.join(args.runDir, 'sandbox')
  const brief = buildDraftBrief({
    runId: args.runId,
    workspacePath: args.workspacePath,
    runDir: args.runDir,
    triggerKind: args.triggerKind,
    userHint: args.userHint,
    langHint: args.langHint,
    evoContext,
    images,
  })
  // Always a fresh `-n` session. The brief points at tool-flow.md and
  // source-snapshot.json on disk — both already in runDir from enqueue
  // — so the agent reads what it needs via `file_read` instead of us
  // stuffing rawMessages into a staged session. Cleaner, predictable,
  // no internal-session JSON to manage.
  // Brief goes on stdin, not argv — it's multi-KB and would overflow the
  // Windows command-line limit (ENAMETOOLONG). The cli reads stdin as the
  // prompt when not a TTY.
  const cliArgs = ['cli', '-a', '__evo_agent__', '-n', '-w', sandboxWs]
  appendSubCliHeader(args.runDir, 'Phase A: __evo_agent__ draft')
  const result = await spawnProc(
    resolveHaloCli(),
    cliArgs,
    args.logFd,
    subCliLogPath(args.runDir),
    brief,
    PHASE_TIMEOUT_SEC,
  )
  if (result.exitCode !== 0) {
    writeLog(args.logFd, `[phaseDraft] evo cli exited ${result.exitCode}\n`)
    if (result.stderr) writeLog(args.logFd, `[phaseDraft] stderr: ${result.stderr.slice(-2000)}\n`)
    if (result.stdout) writeLog(args.logFd, `[phaseDraft] stdout (last 1KB): ${result.stdout.slice(-1000)}\n`)
  }
  // Skip marker takes precedence over patch.md / sandbox checks. If the
  // agent wrote both .skip.md AND a patch (e.g. it changed its mind
  // mid-run), we treat .skip.md as the latest decision — agents should
  // never write both, but if it happens, skip is the safer interpretation
  // (we don't apply ambiguous output).
  const hasSkipMarker = fs.existsSync(path.join(args.runDir, '.skip.md'))
  if (hasSkipMarker) {
    writeLog(args.logFd, `[phaseDraft] .skip.md present — evo declared skip\n`)
    return 'skipped'
  }
  const hasPatch = fs.existsSync(path.join(args.runDir, 'patch.md'))
  const hasSandbox = fs.existsSync(path.join(args.runDir, 'sandbox', '.halo'))
  writeLog(args.logFd, `[phaseDraft] patch.md=${hasPatch} sandbox=${hasSandbox}\n`)
  if (hasPatch && hasSandbox) return 'drafted'
  return 'failed'
}

/**
 * Phase B — wrapper runs the dry-run, with at most one corrective pass.
 *
 * Two-step shape (deliberately not a generic loop):
 *   1. tryDryRun → success ends phase B.
 *   2. on failure, write fail log → ping __evo_agent__ in fix mode →
 *      tryDryRun once more.
 *
 * If the second attempt still fails, return false. We don't keep trying:
 * a patch that needs >1 fix pass is signal that the patch is wrong, not
 * that the loop count is too low.
 */
async function phaseDryRun(args: {
  runId: string
  workspacePath: string
  runDir: string
  langHint: string
  logFd: number
}): Promise<boolean> {
  writeLog(args.logFd, `\n=== Phase B: dry-run ===\n`)

  const first = await tryDryRun(args, 0)
  if (first.kind === 'ok') return true

  // First attempt failed. Spend the single fix budget and try once more.
  const fixed = await runFix(args, first.failLogPath, 1)
  if (!fixed) {
    writeLog(args.logFd, `[phaseDryRun] fix pass exited non-zero; aborting\n`)
    return false
  }

  const second = await tryDryRun(args, 1)
  if (second.kind === 'ok') return true

  writeLog(args.logFd, `[phaseDryRun] dry-run still failing after fix pass; aborting\n`)
  return false
}

/**
 * One dry-run attempt. Reads patch.md frontmatter for the test scenario,
 * spawns the sub-cli wrapped in `timeout(1)`, and either writes
 * dry-run-output.txt (success) or dry-run-fail-<n>.log (failure).
 *
 * The `n` index lets us keep both the original failure log and the
 * post-fix failure log on disk so the user can compare.
 */
type DryRunResult =
  | { kind: 'ok' }
  | { kind: 'failed'; failLogPath: string }
  | { kind: 'no-scenario'; failLogPath: string }

async function tryDryRun(args: {
  runId: string
  workspacePath: string
  runDir: string
  logFd: number
}, attemptIndex: number): Promise<DryRunResult> {
  const sandboxDir = path.join(args.runDir, 'sandbox')
  const outputPath = path.join(args.runDir, 'dry-run-output.txt')
  const failLogPath = path.join(args.runDir, `dry-run-fail-${attemptIndex}.log`)
  const cli = resolveHaloCli()

  const fm = readPatchFrontmatter(args.runDir)
  const scenario = extractTestScenario(fm)
  if (!scenario) {
    writeLog(args.logFd, `[tryDryRun:${attemptIndex}] patch.md frontmatter missing testScenario.{agentId, testMessage}\n`)
    fs.writeFileSync(failLogPath, 'patch.md frontmatter missing testScenario.{agentId, testMessage} — wrapper cannot run dry-run without it.\n', 'utf-8')
    return { kind: 'no-scenario', failLogPath }
  }

  writeLog(args.logFd, `[tryDryRun:${attemptIndex}] agent=${scenario.agentId} testMessage=${JSON.stringify(scenario.testMessage).slice(0, 200)}\n`)
  // Dry-run runs the patched sandbox against a probe — its job is to surface
  // how the agent *would* respond, not to actually exercise side effects on
  // real infrastructure. `--access workspace` keeps file/shell ops working
  // inside the sandbox while bwrap masks ~/.aws / ~/.ssh / ~/.kube etc., so
  // a runaway probe can't `aws ec2 run-instances` against the user's real
  // account just because the test scenario happens to mention EC2.
  appendSubCliHeader(args.runDir, `Phase B: dry-run #${attemptIndex} (${scenario.agentId})`)
  const result = await spawnProc(
    cli,
    ['cli', '-a', scenario.agentId, '-n', '-w', sandboxDir, '--access', 'workspace'],
    args.logFd,
    subCliLogPath(args.runDir),
    scenario.testMessage,   // stdin, not argv
    DRY_RUN_TIMEOUT_SEC,    // Node-native timeout → exit 124 on timeout
  )

  // `timeout(1)` exit code 124 = the wrapped command hit the timeout.
  const timedOut = result.exitCode === 124
  const ok = result.exitCode === 0 && result.stdout.trim().length > 0

  if (ok) {
    fs.writeFileSync(outputPath, result.stdout, 'utf-8')
    writeLog(args.logFd, `[tryDryRun:${attemptIndex}] success: wrote ${outputPath} (${result.stdout.length}B)\n`)
    return { kind: 'ok' }
  }

  const stdoutTail = result.stdout.length > 4000 ? '…' + result.stdout.slice(-4000) : result.stdout
  const stderrTail = result.stderr.length > 4000 ? '…' + result.stderr.slice(-4000) : result.stderr
  fs.writeFileSync(failLogPath, [
    `Wrapper command:  halo cli -a ${scenario.agentId} -n -w ${sandboxDir} <testMessage>`,
    `Test message:     ${scenario.testMessage}`,
    `Exit code:        ${result.exitCode}${timedOut ? ' (timeout)' : ''}`,
    `Stdout (tail):`,
    stdoutTail || '(empty)',
    ``,
    `Stderr (tail):`,
    stderrTail || '(empty)',
  ].join('\n'), 'utf-8')
  writeLog(args.logFd, `[tryDryRun:${attemptIndex}] failed (exit=${result.exitCode}, timedOut=${timedOut}); wrote ${failLogPath}\n`)
  return { kind: 'failed', failLogPath }
}

async function runFix(args: {
  runId: string
  workspacePath: string
  runDir: string
  langHint: string
  logFd: number
}, failLogPath: string, attempt: number): Promise<boolean> {
  writeLog(args.logFd, `\n--- fix attempt ${attempt}/${FIX_BUDGET} ---\n`)
  const brief = buildFixBrief({
    runId: args.runId,
    workspacePath: args.workspacePath,
    runDir: args.runDir,
    failLogPath,
    attempt,
    maxAttempts: FIX_BUDGET,
    langHint: args.langHint,
  })
  // Fix mode resumes the same `evo_<runId>` session draft mode created. That
  // way the agent inherits the source conversation AND its own draft turn —
  // it sees what it just produced, the failure log, and decides what to fix.
  appendSubCliHeader(args.runDir, `Phase B: __evo_agent__ fix attempt ${attempt}`)
  // Fresh `-n` like draft. Brief inlines the failure log + tells the
  // agent to file_read patch.md in the sandbox to see what it
  // produced last time. No session resume — same simplicity as draft.
  const sandboxWs = path.join(args.runDir, 'sandbox')
  const result = await spawnProc(
    resolveHaloCli(),
    ['cli', '-a', '__evo_agent__', '-n', '-w', sandboxWs],
    args.logFd,
    subCliLogPath(args.runDir),
    brief,  // stdin, not argv — see spawnProc / draft
    PHASE_TIMEOUT_SEC,
  )
  return result.exitCode === 0
}

/** Phase C. Returns true iff score.json exists after the scorer exits. */
async function phaseScore(args: {
  runId: string
  workspacePath: string
  runDir: string
  langHint: string
  logFd: number
}): Promise<boolean> {
  writeLog(args.logFd, `\n=== Phase C: score ===\n`)
  const evoContext = readEvoContext(args.runDir, args.logFd)
  const brief = buildScoreBrief({
    runId: args.runId,
    workspacePath: args.workspacePath,
    runDir: args.runDir,
    langHint: args.langHint,
    evoContext,
    logFd: args.logFd,
  })
  // Run against the sandbox built by phase A — by phase C the sandbox
  // already contains the patched files the drafter wrote, plus the
  // original prompt files cp'd in at sandbox build time.
  const sandboxWs = path.join(args.runDir, 'sandbox')
  // Defensive: if for any reason phase A's buildEvoSandbox didn't fire
  // (shouldn't happen — phase B requires the sandbox), build it now.
  buildEvoSandbox(args.workspacePath, args.runDir, args.logFd)
  // Fresh `-n` like draft. Brief tells the scorer to file_read
  // tool-flow.md / source-snapshot.json in the runDir for the original
  // conversation context (and patch.md / dry-run-output.txt for what
  // was tested) — no session staging.
  const cliArgs = ['cli', '-a', '__score__', '-n', '-w', sandboxWs]
  appendSubCliHeader(args.runDir, 'Phase C: __score__')
  const result = await spawnProc(
    resolveHaloCli(),
    cliArgs,
    args.logFd,
    subCliLogPath(args.runDir),
    brief,  // stdin, not argv — see spawnProc / draft
    PHASE_TIMEOUT_SEC,
  )
  if (result.exitCode !== 0) {
    writeLog(args.logFd, `[phaseScore] scorer cli exited ${result.exitCode}\n`)
    if (result.stderr) writeLog(args.logFd, `[phaseScore] stderr: ${result.stderr.slice(-2000)}\n`)
    if (result.stdout) writeLog(args.logFd, `[phaseScore] stdout (last 1KB): ${result.stdout.slice(-1000)}\n`)
  }
  const hasScore = fs.existsSync(path.join(args.runDir, 'score.json'))
  writeLog(args.logFd, `[phaseScore] score.json=${hasScore}\n`)
  return hasScore
}

/** Files in runDir that are *inputs* — written once by enqueueEvoRun() at
 *  trigger time and reused verbatim across every (re-)run. Everything else
 *  in runDir is wrapper *output* (patch.md, .skip.md, score.json, sandbox/,
 *  dry-run logs, sub-cli.log, images/) that a re-run must start without.
 *
 *  Kept as a keep-list, not a delete-list: any future output file the
 *  wrapper learns to write is cleared automatically, so this can't regress
 *  to "forgot to delete the new artifact". */
const RUN_INPUT_FILES = new Set([
  'source-snapshot.json',
  'tool-flow.md',
  'meta.json',
  'evo-context.json',
])

/** Clear the previous attempt's output from runDir, preserving the
 *  trigger-time inputs. Runs at the top of every runMode so a re-run isn't
 *  contaminated by stale output — most visibly a leftover `.skip.md`, which
 *  phaseDraft treats as "skip" before it even looks at patch.md, trapping
 *  every retry of a skipped run in 'skipped'.
 *
 *  Lives in the wrapper, not the /retry route, because re-runs arrive via
 *  two paths — reviewer retry AND automatic heartbeat-timeout re-claims —
 *  and runMode is the single convergence point of both. */
function resetRunArtifacts(runDir: string, logFd: number): void {
  let entries: string[]
  try { entries = fs.readdirSync(runDir) } catch { return }
  for (const entry of entries) {
    if (RUN_INPUT_FILES.has(entry)) continue
    try {
      fs.rmSync(path.join(runDir, entry), { recursive: true, force: true })
    } catch (err) {
      writeLog(logFd, `[resetRunArtifacts] failed to remove ${entry}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

async function runMode(id: string, logFd: number): Promise<void> {
  const row = loadRunRow(id)
  const runDir = path.join(row.workspacePath, '.halo', 'evo', 'runs', id)
  fs.mkdirSync(runDir, { recursive: true })
  // A re-run (reviewer retry or heartbeat-timeout re-claim) reuses this
  // runDir. Clear the prior attempt's output first; a stale .skip.md in
  // particular would make phaseDraft short-circuit to 'skipped' forever.
  resetRunArtifacts(runDir, logFd)

  // Heartbeat loop runs for the whole orchestration, regardless of phase.
  // 60s interval; ticker default timeout is 5min so a single missed
  // heartbeat tolerates a slow LLM call.
  const hb = setInterval(() => {
    try {
      getEvoDb().update(evolutionRuns)
        .set({ heartbeatAt: Date.now() })
        .where(eq(evolutionRuns.id, id))
        .run()
    } catch (err) {
      writeLog(logFd, `[wrapper] heartbeat failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }, 60_000)

  const langHint = resolveLangHint()
  writeLog(logFd, `[wrapper] resolved langHint=${langHint}\n`)

  const ctx = {
    runId: id,
    workspacePath: row.workspacePath,
    runDir,
    triggerKind: row.triggerKind,
    userHint: row.userHint ?? null,
    langHint,
    logFd,
  }

  try {
    const outcome = await phaseDraft(ctx)
    if (outcome === 'failed') {
      finalize(id, 'failed', 'phase A: drafter did not produce patch.md/sandbox or .skip.md', logFd)
      return
    }
    if (outcome === 'skipped') {
      // Evo decided this run has no patch worth proposing (e.g. rule
      // already exists in workspace). Skip phase B/C — no patch means
      // nothing to dry-run and nothing to score. Reviewer doesn't need
      // to approve / reject; the run is terminal.
      finalize(id, 'skipped', null, logFd)
      return
    }

    const dryRunOk = await phaseDryRun(ctx)
    if (!dryRunOk) {
      finalize(id, 'failed', 'phase B: dry-run failed (fix budget exhausted)', logFd)
      return
    }

    const scored = await phaseScore(ctx)
    if (!scored) {
      finalize(id, 'failed', 'phase C: scorer did not produce score.json', logFd)
      return
    }

    finalize(id, 'awaiting_review', null, logFd)
  } finally {
    clearInterval(hb)
  }
}

/** Single helper for the terminal db write at the end of run mode.
 *  Statuses:
 *   - 'awaiting_review' → patch produced, needs human approve/reject
 *   - 'skipped'         → evo decided no patch worth proposing (.skip.md)
 *   - 'failed'          → wrapper aborted (any phase couldn't produce
 *                          its expected outputs) */
function finalize(id: string, status: 'awaiting_review' | 'skipped' | 'failed', failureReason: string | null, logFd: number): void {
  const now = Date.now()
  getEvoDb().update(evolutionRuns)
    .set({ status, failureReason, completedAt: now })
    .where(eq(evolutionRuns.id, id))
    .run()
  writeLog(logFd, `[wrapper] finalize: status=${status}${failureReason ? ` reason=${failureReason}` : ''}\n`)
}

// ---------------------------------------------------------------------------
// Apply mode (phase 11)
//
// Mirrors run mode in shape but with two phases:
//   Phase A' — build sandbox (whitelist cp from CURRENT main workspace), then
//              spawn __apply_agent__ to merge N approved patches into it.
//   Phase B' — for each source_run_id, run `halo cli -a <agentId> -n -w
//              <applyDir>/sandbox "<testMessage>"`, then __score__ on the
//              result. Any score.json with `lint < 50` or `behavior < 50`
//              is a regression — abort with status='failed'. Main workspace
//              is NEVER touched in phase 11; phase 12 owns the final sync.
//
// Important: the apply sandbox is brand-new every time (cp from main, not
// reused from any evo run sandbox). Reasons covered in spec.
// ---------------------------------------------------------------------------

/** Min `behavior` / `lint` score before we treat the merged result as a
 *  regression and refuse to publish. 50 = "neutral / no signal" anchor in
 *  scorer rubric — anything below means the patch genuinely got worse, or
 *  the config didn't load. */
const APPLY_REGRESSION_FLOOR = 50

interface ApplyRow {
  id: string
  workspacePath: string
  sourceRunIds: string[]
  reviewerHint: string | null
  /** Current status read by `applyMode` to decide entry path:
   *   - 'running' (default) → fresh start, run phase A'/B'/12.
   *   - 'syncing' → previous wrapper crashed mid-cp. Skip A'/B' and
   *     resume directly at phase 12 publish. */
  status: string
}

function loadApplyRow(id: string): ApplyRow {
  const db = getEvoDb()
  const row = db.select({
    id: evolutionApplies.id,
    workspacePath: evolutionApplies.workspacePath,
    sourceRunIds: evolutionApplies.sourceRunIds,
    reviewerHint: evolutionApplies.reviewerHint,
    status: evolutionApplies.status,
  }).from(evolutionApplies).where(eq(evolutionApplies.id, id)).get()
  if (!row) throw new Error(`evolution_applies row not found: ${id}`)
  let sourceRunIds: string[]
  try { sourceRunIds = JSON.parse(row.sourceRunIds) as string[] }
  catch { throw new Error(`evolution_applies.${id}.source_run_ids is not valid JSON: ${row.sourceRunIds}`) }
  if (!Array.isArray(sourceRunIds) || sourceRunIds.length === 0) {
    throw new Error(`evolution_applies.${id}.source_run_ids must be a non-empty array`)
  }
  return {
    id: row.id,
    workspacePath: row.workspacePath,
    sourceRunIds,
    reviewerHint: row.reviewerHint,
    status: row.status,
  }
}

/**
 * Whitelist-cp the user workspace's `.halo/` prompt surface into a
 * runtime sandbox `<sandboxParent>/sandbox/.halo/`.
 *
 * Used in BOTH phase 11 (apply) and run-mode phases A/A-fix/C — every
 * LLM step that the wrapper spawns runs against this sandbox, never
 * the user's real workspace. That gives us:
 *   - no `agent_sessions` rows leaking into `<user-ws>/.halo/halo.db`
 *     (stage's session row lands in the sandbox's brand-new db instead)
 *   - no risk of an evo agent accidentally writing into the real
 *     workspace via `file_write` (the access guard already covers
 *     this, but defense-in-depth)
 *   - all evo state ends up under `<runDir>/sandbox/`, which the
 *     archive job already zips on retention
 *
 * Whitelist: only the prompt-relevant directories. Memory / sessions /
 * logs / db / evo state are intentionally NOT copied — copying memory
 * would balloon sandbox size, copying sessions would leak unrelated
 * conversations, copying the db would re-import the very pollution
 * we're trying to escape.
 */
function buildEvoSandbox(workspacePath: string, sandboxParent: string, logFd: number): void {
  const srcWs = path.join(workspacePath, '.halo')
  const dstWs = path.join(sandboxParent, 'sandbox', '.halo')
  fs.mkdirSync(dstWs, { recursive: true })
  const whitelist = SANDBOX_WHITELIST
  for (const entry of whitelist) {
    const srcEntry = path.join(srcWs, entry)
    if (!fs.existsSync(srcEntry)) continue
    const dstEntry = path.join(dstWs, entry)
    // Skip if already present (idempotent — phase A may have built it,
    // phase C reuses; apply has its own first-run path that builds this).
    if (fs.existsSync(dstEntry)) continue
    // Use Node's recursive cp — synchronous variant, available since Node 16.
    // Symlinks: dereference (we want the contents in the sandbox, not links
    // back to the live workspace).
    fs.cpSync(srcEntry, dstEntry, { recursive: true, dereference: true })
  }
  writeLog(logFd, `[buildEvoSandbox] cp from ${srcWs} → ${dstWs} (whitelist: ${whitelist.join(', ')})\n`)
}

/** Apply-mode wrapper around buildEvoSandbox — same behavior, retained
 *  name for log readability and to mark the apply-specific call site. */
function buildApplySandbox(workspacePath: string, applyDir: string, logFd: number): void {
  buildEvoSandbox(workspacePath, applyDir, logFd)
}

interface ApplyCtx {
  applyId: string
  workspacePath: string
  applyDir: string
  sourceRunIds: string[]
  reviewerHint: string | null
  langHint: string
  logFd: number
}

/** Brief for __apply_agent__ in merge mode (phase A'). */
function buildApplyMergeBrief(args: ApplyCtx): string {
  return [
    'You are running as the Apply agent (phase A: MERGE).',
    '',
    `Apply id: ${args.applyId}`,
    `Workspace: ${args.workspacePath}`,
    `Working dir: ${args.applyDir}`,
    `source_run_ids: [${args.sourceRunIds.join(', ')}]`,
    `Reviewer hint: ${args.reviewerHint ?? '(none)'}`,
    '',
    'The wrapper has already built the sandbox at',
    `${path.join(args.applyDir, 'sandbox', '.halo')} by whitelist-cp from`,
    'the current main workspace. Read each source_run_id\'s patch.md',
    '(latest version!) and merge their changes into the sandbox.',
    '',
    'Follow the procedure in your AGENT.md. Pay close attention to the',
    'platform override matrix — workspace-replaces-global rules differ',
    'per file type, and the prompts/ directory replacement trap is real.',
    '',
    'Hard rules: only edit files under sandbox/.halo/ — main workspace',
    'and ~/.halo/global/ are off-limits. Do NOT spawn halo cli. Do NOT',
    'write score.json. Write apply.log with a summary of what you did.',
    ...buildLanguageClause(args.langHint, 'apply.log and any natural-language commentary'),
  ].join('\n')
}

/** Brief for __score__ in regression mode (phase B'). Same scorer agent
 *  as run mode, but pointed at a per-source regression dir instead of the
 *  run dir. */
function buildApplyScoreBrief(args: {
  applyId: string
  workspacePath: string
  runId: string
  regressDir: string
  patchMdPath: string
  snapshotPath: string
  langHint: string
}): string {
  return [
    'You are running as the Evolution scorer in APPLY REGRESSION mode.',
    '',
    `Apply id: ${args.applyId}`,
    `Source run id: ${args.runId}`,
    `Workspace: ${args.workspacePath}`,
    `Regress dir: ${args.regressDir}`,
    '',
    'The apply agent has merged this patch (and possibly others) into',
    'an apply sandbox. The wrapper just ran the patch\'s testScenario',
    'against the merged sandbox; stdout is in',
    `${path.join(args.regressDir, 'dry-run-output.txt')}.`,
    '',
    'Follow your AGENT.md procedure. Read:',
    `  patch.md      → ${args.patchMdPath}`,
    `  source-snapshot.json → ${args.snapshotPath}`,
    `  dry-run output  → ${path.join(args.regressDir, 'dry-run-output.txt')}`,
    '',
    `Write score.json into ${args.regressDir}. Same format as run mode.`,
    'Do not modify any other file.',
    ...buildLanguageClause(args.langHint, 'the score.json "notes" field'),
    'The numeric fields and "confidence" enum stay as-is.',
  ].join('\n')
}

/**
 * Phase A' — wrapper builds sandbox, then spawns apply agent to merge.
 * Returns true iff apply.log exists after the agent exits (proxy for
 * "agent ran the procedure to completion"). Empty sandbox still gets
 * detected at phase B' — there'll be no patched behavior to regress on.
 */
async function phaseApplyMerge(ctx: ApplyCtx): Promise<boolean> {
  writeLog(ctx.logFd, `\n=== Phase A': merge ===\n`)
  buildApplySandbox(ctx.workspacePath, ctx.applyDir, ctx.logFd)

  const brief = buildApplyMergeBrief(ctx)
  // Run apply agent against the sandbox (where it will read patches and
  // merge them) — never the user workspace. Same isolation reasoning as
  // run mode: no agent_sessions row pollution, no accidental writes to
  // user files.
  const sandboxWs = path.join(ctx.applyDir, 'sandbox')
  const result = await spawnProc(
    resolveHaloCli(),
    ['cli', '-a', '__apply_agent__', '-n', '-w', sandboxWs],
    ctx.logFd,
    undefined,
    brief,  // stdin, not argv — see spawnProc / draft
    PHASE_TIMEOUT_SEC,
  )
  if (result.exitCode !== 0) {
    writeLog(ctx.logFd, `[phaseApplyMerge] apply cli exited ${result.exitCode}\n`)
    return false
  }
  // apply.log is the agent's audit trail; if it didn't write one, it likely
  // bailed early. The sandbox contents themselves are what matters for
  // phase B', but apply.log presence is a cheap "did it follow procedure"
  // signal.
  const hasLog = fs.existsSync(path.join(ctx.applyDir, 'apply.log'))
  writeLog(ctx.logFd, `[phaseApplyMerge] apply.log=${hasLog}\n`)
  return hasLog
}

/**
 * Phase B' — for each source_run_id, run the patch's testScenario against
 * the merged sandbox and score the result. Returns the array of scores
 * (one per source run) and a boolean indicating whether any regressed.
 *
 * `lint < 50` or `behavior < 50` counts as regression; everything else
 * is "patch survived the merge" and apply can proceed.
 */
interface RegressOutcome {
  runId: string
  scoreAvg: number | null
  lint: number | null
  behavior: number | null
  regressed: boolean
  reason: string | null
}

async function phaseApplyRegress(ctx: ApplyCtx): Promise<{ allOk: boolean; outcomes: RegressOutcome[] }> {
  writeLog(ctx.logFd, `\n=== Phase B': regress ===\n`)
  const sandboxDir = path.join(ctx.applyDir, 'sandbox')
  const regressBaseDir = path.join(ctx.applyDir, 'regress')
  fs.mkdirSync(regressBaseDir, { recursive: true })
  const outcomes: RegressOutcome[] = []

  for (const runId of ctx.sourceRunIds) {
    writeLog(ctx.logFd, `\n--- regress for source run ${runId} ---\n`)
    const regressDir = path.join(regressBaseDir, runId)
    fs.mkdirSync(regressDir, { recursive: true })

    // Resolve the patch + snapshot for this source run.
    const runDir = path.join(ctx.workspacePath, '.halo', 'evo', 'runs', runId)
    const patchMdPath = path.join(runDir, 'patch.md')
    const snapshotPath = path.join(runDir, 'source-snapshot.json')

    const fm = readPatchFrontmatter(runDir)
    const scenario = extractTestScenario(fm)
    if (!scenario) {
      writeLog(ctx.logFd, `[phaseApplyRegress:${runId}] missing testScenario in patch.md frontmatter\n`)
      outcomes.push({
        runId, scoreAvg: null, lint: null, behavior: null,
        regressed: true, reason: 'patch.md missing testScenario',
      })
      continue
    }

    // Step 1: dry-run against the merged sandbox. Same `--access workspace`
    // reasoning as phaseDryRun — verifying prompt behavior, not exercising
    // real cloud / system credentials.
    writeLog(ctx.logFd, `[phaseApplyRegress:${runId}] testScenario.testMessage=${JSON.stringify(scenario.testMessage).slice(0, 200)}\n`)
    const dryRun = await spawnProc(
      resolveHaloCli(),
      ['cli', '-a', scenario.agentId, '-n', '-w', sandboxDir, '--access', 'workspace'],
      ctx.logFd,
      undefined,
      scenario.testMessage,   // stdin, not argv
      DRY_RUN_TIMEOUT_SEC,    // Node-native timeout → exit 124 on timeout
    )
    const dryRunOut = path.join(regressDir, 'dry-run-output.txt')
    if (dryRun.exitCode === 0 && dryRun.stdout.trim().length > 0) {
      fs.writeFileSync(dryRunOut, dryRun.stdout, 'utf-8')
    } else {
      // Persist whatever we got so the scorer (and humans) can see it. We
      // still let the scorer run — score.lint will land at 0 because the
      // dry-run failed, which is the right regression signal.
      const tail = dryRun.stdout.length > 4000 ? '…' + dryRun.stdout.slice(-4000) : dryRun.stdout
      const errTail = dryRun.stderr.length > 4000 ? '…' + dryRun.stderr.slice(-4000) : dryRun.stderr
      fs.writeFileSync(dryRunOut, '', 'utf-8')
      fs.writeFileSync(path.join(regressDir, 'dry-run-fail.log'), [
        `Wrapper command:  halo cli -a ${scenario.agentId} -n -w ${sandboxDir} <testMessage>`,
        `Test message:     ${scenario.testMessage}`,
        `Exit code:        ${dryRun.exitCode}${dryRun.exitCode === 124 ? ' (timeout)' : ''}`,
        `Stdout (tail):`, tail || '(empty)', '',
        `Stderr (tail):`, errTail || '(empty)',
      ].join('\n'), 'utf-8')
    }

    // Step 2: score the result.
    const scoreBrief = buildApplyScoreBrief({
      applyId: ctx.applyId,
      workspacePath: ctx.workspacePath,
      runId,
      regressDir,
      patchMdPath,
      snapshotPath,
      langHint: ctx.langHint,
    })
    // Apply scorer also runs against the apply sandbox — same isolation
    // reasoning as the merge phase. The patched-and-merged prompt files
    // are already in there from phaseApplyMerge.
    const scoreSandboxWs = path.join(ctx.applyDir, 'sandbox')
    const scoreRun = await spawnProc(
      resolveHaloCli(),
      ['cli', '-a', '__score__', '-n', '-w', scoreSandboxWs],
      ctx.logFd,
      undefined,
      scoreBrief,  // stdin, not argv — see spawnProc / draft
      PHASE_TIMEOUT_SEC,
    )
    if (scoreRun.exitCode !== 0) {
      writeLog(ctx.logFd, `[phaseApplyRegress:${runId}] scorer cli exited ${scoreRun.exitCode}\n`)
    }

    // Step 3: read score.json + classify.
    const scorePath = path.join(regressDir, 'score.json')
    let scoreJson: { lint?: number; behavior?: number; avg?: number } | null = null
    try { scoreJson = JSON.parse(fs.readFileSync(scorePath, 'utf-8')) }
    catch { /* missing or malformed */ }

    if (!scoreJson) {
      writeLog(ctx.logFd, `[phaseApplyRegress:${runId}] missing/malformed score.json — treating as regression\n`)
      outcomes.push({
        runId, scoreAvg: null, lint: null, behavior: null,
        regressed: true, reason: 'scorer did not produce score.json',
      })
      continue
    }
    const lint = typeof scoreJson.lint === 'number' ? scoreJson.lint : null
    const behavior = typeof scoreJson.behavior === 'number' ? scoreJson.behavior : null
    const avg = typeof scoreJson.avg === 'number' ? scoreJson.avg : null
    let regressed = false
    let reason: string | null = null
    if (lint != null && lint < APPLY_REGRESSION_FLOOR) {
      regressed = true
      reason = `lint ${lint} < ${APPLY_REGRESSION_FLOOR} (config didn't load cleanly)`
    } else if (behavior != null && behavior < APPLY_REGRESSION_FLOOR) {
      regressed = true
      reason = `behavior ${behavior} < ${APPLY_REGRESSION_FLOOR} (worse than baseline)`
    }
    writeLog(ctx.logFd, `[phaseApplyRegress:${runId}] avg=${avg} lint=${lint} behavior=${behavior} regressed=${regressed}${reason ? ` (${reason})` : ''}\n`)
    outcomes.push({ runId, scoreAvg: avg, lint, behavior, regressed, reason })
  }

  const allOk = outcomes.every((o) => !o.regressed)
  writeLog(ctx.logFd, `\n[phaseApplyRegress] summary: ${outcomes.length} runs, allOk=${allOk}\n`)
  return { allOk, outcomes }
}

/** Terminal "failed" db write for apply mode. (The "applied" side lives
 *  in `finalizeApplied` below, which sets appliedAt and the matching
 *  source-run rows.) */
function finalizeApply(applyId: string, status: 'failed', failureReason: string | null, logFd: number): void {
  const now = Date.now()
  getEvoDb().update(evolutionApplies)
    .set({ status, failureReason, completedAt: now })
    .where(eq(evolutionApplies.id, applyId))
    .run()
  writeLog(logFd, `[wrapper] finalize apply: status=${status}${failureReason ? ` reason=${failureReason}` : ''}\n`)
}

async function applyMode(id: string, logFd: number): Promise<void> {
  const row = loadApplyRow(id)
  const applyDir = path.join(row.workspacePath, '.halo', 'evo', 'applies', id)
  fs.mkdirSync(applyDir, { recursive: true })

  // Persist meta.json so the apply agent (and any debugging human) can
  // read source_run_ids + reviewer_hint without round-tripping through
  // the db. This also matches the layout described in the spec.
  fs.writeFileSync(path.join(applyDir, 'meta.json'), JSON.stringify({
    id,
    sourceRunIds: row.sourceRunIds,
    reviewerHint: row.reviewerHint,
    workspacePath: row.workspacePath,
    createdAt: Date.now(),
  }, null, 2), 'utf-8')

  // Heartbeat loop covers both phases. Same cadence as run mode (60s
  // interval, 5min timeout default).
  const hb = setInterval(() => {
    try {
      getEvoDb().update(evolutionApplies)
        .set({ heartbeatAt: Date.now() })
        .where(eq(evolutionApplies.id, id))
        .run()
    } catch (err) {
      writeLog(logFd, `[wrapper] heartbeat (apply) failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }, 60_000)

  const ctx: ApplyCtx = {
    applyId: id,
    workspacePath: row.workspacePath,
    applyDir,
    sourceRunIds: row.sourceRunIds,
    reviewerHint: row.reviewerHint,
    langHint: resolveLangHint(),
    logFd,
  }

  // Resume detection. The ticker claims rows by transitioning pending →
  // running, so any row we see here normally has status='running'. The
  // single exception is a crash-recovery claim of a 'syncing' row —
  // markTimeouts treats stale-heartbeat 'syncing' the same way as stale
  // 'running' and lets the ticker re-spawn us.
  //
  // When we see status='syncing' on entry, all the LLM-heavy phases
  // (A' merge, B' regress) already ran successfully in the previous
  // wrapper — main is just half-published. Skip straight to redoing
  // the publish step. cp is idempotent; redoing it on a partly-finished
  // main brings it the rest of the way to the sandbox state.
  const isResume = row.status === 'syncing'
  if (isResume) {
    writeLog(logFd, `[wrapper] resume path: row was in 'syncing', skipping phase A'/B' and re-running phase 12 publish only\n`)
  }

  try {
    if (!isResume) {
      const merged = await phaseApplyMerge(ctx)
      if (!merged) {
        finalizeApply(id, 'failed', "phase A': apply agent didn't produce apply.log", logFd)
        return
      }

      const { allOk, outcomes } = await phaseApplyRegress(ctx)
      if (!allOk) {
        const regressedRuns = outcomes.filter((o) => o.regressed).map((o) => `${o.runId}(${o.reason ?? '?'})`).join('; ')
        finalizeApply(id, 'failed', `phase B': regression in ${regressedRuns}`, logFd)
        return
      }
    }

    // Phase 12 — final sync to main workspace, in two checkpointed steps.
    //
    // Step 1 (preflight): walk sandbox, diff against main, snapshot soon-
    // to-be-overwritten files to history/. No main mutation. Idempotent.
    // Step 2 (checkpoint): db status='syncing'. From here on, a wrapper
    // crash → ticker recovery → resume path lands at step 3.
    // Step 3 (publish): cp sandbox → main. The dangerous step.
    // Step 4: mark source runs 'applied' + finalize apply row 'applied'.
    //
    // Per-workspace mutex in the ticker prevents two apply wrappers for
    // the same workspace from racing on this — that mutex is the one
    // load-bearing assumption phase 12 makes about the rest of the
    // system.
    try {
      const preflight = await phaseApplyPreflight(ctx)
      if (!preflight.ok) {
        finalizeApply(id, 'failed', `phase 12 preflight: ${preflight.reason}`, logFd)
        return
      }

      // Move into the danger zone: from this write onward, a crash leaves
      // the row in 'syncing' state and ticker recovery does the rest.
      // Skip when we're already a resume (no point flipping syncing →
      // syncing); but harmless if we did.
      if (!isResume) markSyncing(id, logFd)

      await phaseApplyPublish(ctx, preflight.result)

      // Mark source runs as applied. (Apply row already moves to
      // 'applied' inside finalizeApplied below, with appliedAt.)
      for (const runId of ctx.sourceRunIds) {
        getEvoDb().update(evolutionRuns)
          .set({ status: 'applied', appliedAt: Date.now() })
          .where(eq(evolutionRuns.id, runId))
          .run()
      }
      finalizeApplied(id, logFd)
      writeLog(logFd, `[wrapper] phase 12: published ${preflight.result.fileCount} files to main; history snapshot at ${preflight.result.historyDir}\n`)
      writeLog(logFd, `[wrapper] note: no explicit session-release step needed. Halo's SessionManager evicts every session from the in-memory cache as soon as its current message turn finishes (runSession's finally block). The next message — channel reply, web reload, /new — runs ensureSession → buildAgentInstance, which re-reads agent.yaml + INSTRUCTIONS.md + USER.md from disk. So the new prompts kick in on the next turn for free, and currently-running turns finish on the old prompts (which is the right behavior — we don't want to abort a user mid-conversation).\n`)
    } catch (err) {
      // Read current status to decide what kind of failure this was. If
      // we already passed `markSyncing` (status='syncing'), main may be
      // half-published and the right behavior is to leave the row in
      // 'syncing' so the ticker recovery path can resume — overwriting
      // to 'failed' here would strand the row. The ticker still has
      // attempts/maxAttempts as the bottom-line stop; if the failure is
      // permanent (disk full etc.), retries will eventually exhaust and
      // markTimeouts converts 'syncing' → 'failed' with a clear reason.
      const currentStatus = getEvoDb()
        .select({ status: evolutionApplies.status })
        .from(evolutionApplies)
        .where(eq(evolutionApplies.id, id))
        .get()?.status
      if (currentStatus === 'syncing') {
        writeLog(logFd, `[wrapper] phase 12 publish threw (${err instanceof Error ? err.message : String(err)}); leaving status='syncing' so ticker can resume — main may be half-applied\n`)
        // Don't overwrite. Wrapper exits, heartbeat stops, ticker takes
        // over. Bonus: clear started_at/heartbeat now so ticker doesn't
        // have to wait the full timeout window before recovering.
        getEvoDb().update(evolutionApplies)
          .set({ startedAt: null, heartbeatAt: null })
          .where(and(eq(evolutionApplies.id, id), eq(evolutionApplies.status, 'syncing')))
          .run()
      } else {
        finalizeApply(id, 'failed', `phase 12: ${err instanceof Error ? err.message : String(err)}`, logFd)
      }
    }
  } finally {
    clearInterval(hb)
  }
}

/**
 * Phase 12 — copy validated sandbox into the main workspace.
 *
 * Steps (any failure aborts and main is left in whatever partial state
 * we got to — caller marks the apply `failed`, the history snapshot is
 * the rollback artifact):
 *   1. Walk sandbox/.halo/ and find files that differ from main
 *      (added or modified). These are the "changes" we publish.
 *   2. For each path that exists in main, snapshot it to
 *      `history/<ts>--apply-<id>/<rel-path>` BEFORE we touch main.
 *      Skipping snapshot for new files (no main equivalent to back up).
 *   3. Copy sandbox file → main.
 *
 * Returns the count of files copied + the history dir path. Caller
 * uses these to record the apply outcome.
 */
/**
 * Phase 12 is split into two steps so the dangerous one (overwriting main)
 * is bracketed by a db checkpoint:
 *
 *   1. `phaseApplyPreflight`: walk sandbox, diff against main, snapshot
 *      pre-state to history/. Idempotent — if it half-finishes and we
 *      retry, MANIFEST.json gets overwritten with the same content,
 *      history files get re-copied. No main mutation.
 *
 *   2. **db checkpoint**: `evolution_applies.status='syncing'`. From
 *      here on, if the wrapper dies, the ticker (on next tick or after
 *      server restart) sees a `syncing` row with stale heartbeat and
 *      knows main is potentially half-published. Recovery path: claim
 *      the row, restart the wrapper which sees status='syncing' on
 *      entry and resumes straight at `phaseApplyPublish` (skipping
 *      A'/B'/preflight to avoid burning more LLM tokens).
 *
 *   3. `phaseApplyPublish`: copy each `changed` file from sandbox to
 *      main. Crash here is the only "real" failure mode — main may be
 *      half-applied, but history/ has the rollback material.
 */

interface PreflightResult {
  changed: Array<{ rel: string; full: string; existsInMain: boolean }>
  historyDir: string
  fileCount: number  // length of `changed`; 0 = no-op apply
}

async function phaseApplyPreflight(ctx: ApplyCtx): Promise<
  { ok: true; result: PreflightResult }
  | { ok: false; reason: string }
> {
  writeLog(ctx.logFd, `\n=== Phase 12 preflight: diff + history backup ===\n`)
  const sandboxHalo = path.join(ctx.applyDir, 'sandbox', '.halo')
  const mainHalo = path.join(ctx.workspacePath, '.halo')
  if (!fs.existsSync(sandboxHalo)) return { ok: false, reason: 'sandbox missing — phase 11 must run first' }

  // Walk sandbox/.halo/ and produce a list of (relPath, sandboxFullPath).
  // We restrict to PUBLISH_WHITELIST (derived from the sandbox read whitelist)
  // so sub-cli runtime artifacts created inside the sandbox (its own
  // sessions/, halo.db, logs/, evo/, memory/) don't get propagated to
  // main, and so the un-scoreable `docs` entry is dropped at this boundary.
  const whitelistTop = new Set(PUBLISH_WHITELIST)
  const filesToConsider: Array<{ rel: string; full: string }> = []
  for (const top of fs.readdirSync(sandboxHalo)) {
    if (!whitelistTop.has(top)) continue
    walkInto(path.join(sandboxHalo, top), top, filesToConsider)
  }

  // Compare sandbox vs main, byte-equal → no-op; differs or new → publish.
  // Use the apply id for the history dir name (instead of a fresh
  // timestamp on every preflight) so a recovery retry lands on the same
  // dir and overwrites its manifest cleanly, instead of leaving stale
  // `<ts1>--apply-<id>/` and `<ts2>--apply-<id>/` siblings.
  const historyDir = path.join(mainHalo, 'evo', 'history', `apply-${ctx.applyId}`)
  const changed: Array<{ rel: string; full: string; existsInMain: boolean }> = []
  for (const { rel, full } of filesToConsider) {
    const mainPath = path.join(mainHalo, rel)
    let existsInMain = false
    try { fs.accessSync(mainPath); existsInMain = true } catch { /* new file */ }
    if (existsInMain) {
      const sandboxBuf = fs.readFileSync(full)
      const mainBuf = fs.readFileSync(mainPath)
      if (sandboxBuf.equals(mainBuf)) continue
    }
    changed.push({ rel, full, existsInMain })
  }
  writeLog(ctx.logFd, `[preflight] ${changed.length} of ${filesToConsider.length} whitelisted files differ from main\n`)

  if (changed.length === 0) {
    return { ok: true, result: { changed, historyDir, fileCount: 0 } }
  }

  // Snapshot existing main files before touching them. NEW files (no main
  // counterpart) need no snapshot — rollback for them is just deletion.
  //
  // Important: do this only on the FIRST preflight, never on a resume.
  // Reasoning: if we crashed mid-publish, some files in main are already
  // the new (sandbox) version. Re-backing them up now would write the
  // sandbox version into history/, destroying the pre-apply backup that
  // rollback needs. We detect first-vs-resume by whether MANIFEST.json
  // already exists in the history dir.
  fs.mkdirSync(historyDir, { recursive: true })
  const manifestPath = path.join(historyDir, 'MANIFEST.json')
  const isFirstPreflight = !fs.existsSync(manifestPath)
  if (isFirstPreflight) {
    for (const { rel, existsInMain } of changed) {
      if (!existsInMain) continue
      const mainPath = path.join(mainHalo, rel)
      const histPath = path.join(historyDir, rel)
      fs.mkdirSync(path.dirname(histPath), { recursive: true })
      fs.copyFileSync(mainPath, histPath)
    }
    fs.writeFileSync(manifestPath, JSON.stringify({
      applyId: ctx.applyId,
      sourceRunIds: ctx.sourceRunIds,
      capturedAt: new Date().toISOString(),
      files: changed.map((c) => ({ rel: c.rel, kind: c.existsInMain ? 'overwrite' : 'new' })),
    }, null, 2), 'utf-8')
  } else {
    writeLog(ctx.logFd, `[preflight] MANIFEST.json already exists — resume path, skipping history backup (the pre-apply state is already preserved from the first preflight)\n`)
  }
  writeLog(ctx.logFd, `[preflight] history snapshot: ${historyDir} (${changed.filter((c) => c.existsInMain).length} backed up, ${changed.filter((c) => !c.existsInMain).length} new)\n`)
  return { ok: true, result: { changed, historyDir, fileCount: changed.length } }
}

/**
 * Phase 12 publish — the dangerous step where main actually mutates.
 *
 * Wrapper sets `evolution_applies.status='syncing'` BEFORE calling this.
 * If we crash mid-loop, the row is left in `syncing` state. The ticker
 * detects this on next tick (heartbeat lost), and a fresh wrapper claim
 * jumps straight back into this function (skipping all the LLM-heavy
 * earlier phases) to redo the cp loop. The cp is idempotent on a single-
 * file basis — copyFileSync(src, dst) just overwrites.
 *
 * `preflight` is recomputed on each call rather than passed in: cheap
 * (sandbox is small), and avoids the resume path needing to serialize
 * the changed-list across processes.
 */
async function phaseApplyPublish(ctx: ApplyCtx, preflight: PreflightResult): Promise<void> {
  writeLog(ctx.logFd, `\n=== Phase 12 publish: cp sandbox → main ===\n`)
  const mainHalo = path.join(ctx.workspacePath, '.halo')
  for (const { rel, full } of preflight.changed) {
    const mainPath = path.join(mainHalo, rel)
    fs.mkdirSync(path.dirname(mainPath), { recursive: true })
    fs.copyFileSync(full, mainPath)
  }
  writeLog(ctx.logFd, `[publish] copied ${preflight.changed.length} files to ${mainHalo}\n`)
}

/** Mark the apply row entering the "publish" step. After this write, a
 *  wrapper crash leaves the row in 'syncing' state; ticker recovery
 *  detects this and jumps a new wrapper to the publish step. */
function markSyncing(applyId: string, logFd: number): void {
  getEvoDb().update(evolutionApplies)
    .set({ status: 'syncing' })
    .where(eq(evolutionApplies.id, applyId))
    .run()
  writeLog(logFd, `[wrapper] checkpoint: status=syncing (publishing main)\n`)
}

/** Recursive directory walker — pushes relative paths (relative to the
 *  whitelist root) into `out`. */
function walkInto(absPath: string, relPath: string, out: Array<{ rel: string; full: string }>): void {
  const stat = fs.statSync(absPath)
  if (stat.isFile()) {
    out.push({ rel: relPath, full: absPath })
    return
  }
  if (!stat.isDirectory()) return // skip symlinks etc.
  for (const entry of fs.readdirSync(absPath)) {
    walkInto(path.join(absPath, entry), path.join(relPath, entry), out)
  }
}

/**
 * Final db write after phase 12 succeeds.
 *
 * Status semantics for evolution_applies:
 *   - `pending`     — created by the approve handler, not yet picked up
 *   - `running`     — ticker claimed; phases A' / B' in flight
 *   - `syncing`     — phase 12 publish in flight (checkpoint set BEFORE
 *                     main is mutated; ticker can resume on crash)
 *   - `applied`     — phase 12 publish finished; main workspace updated,
 *                     history snapshot recorded
 *   - `failed`      — any phase aborted; main may have been partially
 *                     updated when failure was mid-publish (history dir
 *                     is the rollback artifact in that case)
 *   - `timeout`     — wrapper heartbeat lost beyond max_attempts on a
 *                     non-syncing row
 */
function finalizeApplied(applyId: string, logFd: number): void {
  const now = Date.now()
  getEvoDb().update(evolutionApplies)
    .set({ status: 'applied', completedAt: now })
    .where(eq(evolutionApplies.id, applyId))
    .run()
  writeLog(logFd, `[wrapper] finalize apply: status=applied\n`)
}

function writeLog(fd: number, msg: string): void {
  try { fs.writeSync(fd, msg) } catch { /* best effort */ }
}

/** Append-mode log file under ~/.halo/global/logs/evo/. */
function openLogFor(mode: Mode, id: string): { fd: number; logPath: string } {
  const logsDir = path.join(homedir(), '.halo', 'global', 'logs', 'evo')
  fs.mkdirSync(logsDir, { recursive: true })
  const logPath = path.join(logsDir, `${mode}-${id}.log`)
  const fd = fs.openSync(logPath, 'a')
  return { fd, logPath }
}

async function main(): Promise<void> {
  const { mode, id } = parseCli(process.argv.slice(2))
  setEvoDb(createEvoDb(path.join(homedir(), '.halo', 'global')))
  const { fd, logPath } = openLogFor(mode, id)
  writeLog(fd, `\n=== ${new Date().toISOString()} wrapper start mode=${mode} id=${id} pid=${process.pid} ===\n`)

  try {
    if (mode === 'run') await runMode(id, fd)
    else await applyMode(id, fd)
    writeLog(fd, `[wrapper] done; log: ${logPath}\n`)
    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    writeLog(fd, `[wrapper] fatal: ${msg}\n`)
    try {
      const now = Date.now()
      if (mode === 'run') {
        getEvoDb().update(evolutionRuns)
          .set({ status: 'failed', failureReason: `wrapper crash: ${msg}`, completedAt: now })
          .where(eq(evolutionRuns.id, id))
          .run()
      }
    } catch { /* fall through */ }
    process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`[wrapper] startup error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})

/**
 * OS-level sandbox for tool execution.
 * Linux: bubblewrap (bwrap) — filesystem + env isolation.
 * Other platforms: no-op passthrough (app-level validation is the fallback).
 */
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const HOME = homedir()
const HALO_HOME = path.join(HOME, '.halo')
const GLOBAL_DIR = path.join(HALO_HOME, 'global')

/**
 * Decode Windows console output bytes. cmd built-ins (echo) honor `chcp 65001`
 * and emit UTF-8, but native Win32 console tools (ipconfig, systeminfo, …)
 * ignore it and emit the system OEM code page (CP936/GBK on zh-CN). We can't
 * know per-command which it'll be, so decode strictly as UTF-8 and fall back
 * to GBK when the bytes aren't valid UTF-8 — GBK's double-byte sequences are
 * almost always invalid UTF-8, so the fallback fires reliably for ipconfig
 * while genuine UTF-8 output passes through untouched. GBK decoder is provided
 * by the runtime's ICU; if absent, best-effort UTF-8.
 */
function decodeWinOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('utf-8')
    }
  }
}

function stripBwrapArgs(msg: string): string {
  const marker = '--die-with-parent -- '
  const markerIdx = msg.indexOf(marker)
  if (markerIdx === -1) return msg
  const bwrapIdx = msg.lastIndexOf('bwrap', markerIdx)
  if (bwrapIdx === -1) return msg
  return msg.slice(0, bwrapIdx) + msg.slice(markerIdx + marker.length)
}

async function bwrapExec(args: string[], opts?: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync('bwrap', args, opts)
    return { stdout: String(r.stdout), stderr: String(r.stderr) }
  } catch (err: unknown) {
    const e = err as Error & { stdout?: string; stderr?: string; code?: number | string }
    e.message = stripBwrapArgs(e.message)
    throw e
  }
}

export type AccessLevel = 'full' | 'workspace' | 'readonly'

export interface SandboxOptions {
  workspaceRoot: string
  accessLevel: AccessLevel
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
}

interface SandboxResult {
  stdout: string
  stderr: string
}

/**
 * Windows has no bwrap and (for now) no equivalent OS-level sandbox we
 * support. Promote every call to `accessLevel: 'full'` so shell_exec /
 * file ops still work — security on Windows falls back to app-level
 * validation only. mac/linux paths are unchanged.
 */
function normalizeOptsForPlatform(opts: SandboxOptions): SandboxOptions {
  if (process.platform === 'win32' && opts.accessLevel !== 'full') {
    return { ...opts, accessLevel: 'full' }
  }
  return opts
}

let _bwrapAvailable: boolean | null = null

async function isBwrapAvailable(): Promise<boolean> {
  if (_bwrapAvailable !== null) return _bwrapAvailable
  try {
    await execFileAsync('bwrap', ['--version'])
    _bwrapAvailable = true
  } catch {
    _bwrapAvailable = false
  }
  return _bwrapAvailable
}

export function isBwrapCached(): boolean {
  return _bwrapAvailable === true
}

export async function initBwrapCheck(): Promise<boolean> {
  return isBwrapAvailable()
}

const DEFAULT_HIDDEN_DIRS = [
  '~/.halo/secrets',
  '~/.aws',
  '~/.ssh',
  '~/.gnupg',
  '~/.docker',
]
const DEFAULT_HIDDEN_FILES = [
  '~/.npmrc',
  '~/.bash_history',
  '~/.gitconfig',
]

let _hiddenDirs: string[] = DEFAULT_HIDDEN_DIRS
let _hiddenFiles: string[] = DEFAULT_HIDDEN_FILES

function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p
}

export function setSandboxHiddenPaths(dirs: string[], files: string[]): void {
  _hiddenDirs = dirs
  _hiddenFiles = files
}

function buildBwrapArgs(opts: SandboxOptions): string[] {
  const args: string[] = []

  // Entire filesystem — read-only base
  args.push('--ro-bind', '/', '/')

  // /tmp — isolated tmpfs per invocation
  args.push('--tmpfs', '/tmp')

  // Hide sensitive directories with tmpfs overlays
  for (const raw of _hiddenDirs) {
    const dir = expandTilde(raw)
    if (existsSync(dir)) args.push('--tmpfs', dir)
  }
  // Hide sensitive files by binding /dev/null over them
  for (const raw of _hiddenFiles) {
    const file = expandTilde(raw)
    if (existsSync(file)) args.push('--ro-bind', '/dev/null', file)
  }

  // Workspace — workspace level gets rw override; readonly stays ro from the root bind
  if (opts.accessLevel !== 'readonly') {
    args.push('--bind', opts.workspaceRoot, opts.workspaceRoot)
  }

  // /proc and /dev need real mounts
  args.push('--proc', '/proc')
  args.push('--dev', '/dev')

  // Clean environment
  args.push('--clearenv')
  args.push('--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
  args.push('--setenv', 'HOME', HOME)
  args.push('--setenv', 'TERM', 'xterm-256color')

  args.push('--die-with-parent')

  return args
}

export function assertPathAllowed(filePath: string, opts: SandboxOptions, write = false): void {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') return

  const resolved = path.resolve(filePath)
  const wsRoot = path.resolve(opts.workspaceRoot)

  if (resolved === wsRoot || resolved.startsWith(wsRoot + '/')) {
    if (write && opts.accessLevel === 'readonly') {
      throw new Error(`Access denied: readonly session cannot write to "${filePath}"`)
    }
    return
  }

  if (!write && (resolved === GLOBAL_DIR || resolved.startsWith(GLOBAL_DIR + '/'))) {
    return
  }

  throw new Error(`Access denied: "${filePath}" is outside the allowed sandbox paths`)
}

export async function sandboxExec(command: string, opts: SandboxOptions): Promise<SandboxResult> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    if (process.platform === 'win32') {
      // Switch the cmd session to UTF-8 (chcp 65001) so cmd built-ins (echo,
      // …) emit UTF-8. Native Win32 console tools (ipconfig, systeminfo, …)
      // ignore chcp and still emit the OEM code page (GBK on zh-CN), so we
      // capture raw bytes (encoding: 'buffer') and decode with a UTF-8→GBK
      // fallback rather than trusting exec()'s fixed UTF-8 decode. `>nul`
      // hides chcp's own banner.
      const result = await execAsync(`chcp 65001 >nul 2>&1 & ${command}`, {
        cwd: opts.workspaceRoot,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
        signal: opts.signal,
        encoding: 'buffer',
      })
      return {
        stdout: decodeWinOutput(result.stdout as unknown as Buffer),
        stderr: decodeWinOutput(result.stderr as unknown as Buffer),
      }
    }
    const result = await execAsync(command, {
      cwd: opts.workspaceRoot,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      signal: opts.signal,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    throw new Error('Access denied: shell_exec requires bubblewrap (bwrap) for non-full access levels. Install with: apt install bubblewrap')
  }

  const bwrapArgs = buildBwrapArgs(opts)
  return bwrapExec([...bwrapArgs, '--', 'bash', '-c', `cd ${JSON.stringify(opts.workspaceRoot)} && ${command}`], {
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    signal: opts.signal,
  })
}

export async function sandboxReadFile(filePath: string, opts: SandboxOptions): Promise<string> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath, 'utf-8')
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    assertPathAllowed(filePath, opts)
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath, 'utf-8')
  }

  const bwrapArgs = buildBwrapArgs(opts)
  const result = await bwrapExec([...bwrapArgs, '--', 'cat', filePath], {
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
  })
  return result.stdout
}

/** Read a file as raw bytes. Use for images, archives, etc. — anything where
 *  utf-8 decoding would corrupt the data. */
export async function sandboxReadBinaryFile(filePath: string, opts: SandboxOptions): Promise<Buffer> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath)
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    assertPathAllowed(filePath, opts)
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath)
  }

  // bwrapExec returns string stdout via execFileAsync's default encoding —
  // re-spawn raw so we can keep bytes intact.
  return new Promise<Buffer>((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const bwrapArgs = buildBwrapArgs(opts)
      const child = spawn('bwrap', [...bwrapArgs, '--', 'cat', filePath])
      const chunks: Buffer[] = []
      let stderr = ''
      child.stdout.on('data', (c: Buffer) => chunks.push(c))
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          const err = new Error(stripBwrapArgs(stderr || `bwrap cat exited ${code}`))
          ;(err as Error & { code?: number }).code = code ?? undefined
          reject(err)
          return
        }
        resolve(Buffer.concat(chunks))
      })
    }).catch(reject)
  })
}

export async function sandboxWriteFile(filePath: string, content: string, opts: SandboxOptions): Promise<void> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const fsP = await import('node:fs/promises')
    await fsP.mkdir(path.dirname(filePath), { recursive: true })
    await fsP.writeFile(filePath, content, 'utf-8')
    return
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    assertPathAllowed(filePath, opts, true)
    const fsP = await import('node:fs/promises')
    await fsP.mkdir(path.dirname(filePath), { recursive: true })
    await fsP.writeFile(filePath, content, 'utf-8')
    return
  }

  const bwrapArgs = buildBwrapArgs(opts)
  const escaped = content.replace(/'/g, "'\\''")
  const cmd = `mkdir -p ${JSON.stringify(path.dirname(filePath))} && printf '%s' '${escaped}' > ${JSON.stringify(filePath)}`
  await bwrapExec([...bwrapArgs, '--', 'bash', '-c', cmd], {
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
  })
}

export async function sandboxStat(filePath: string, opts: SandboxOptions): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { stat } = await import('node:fs/promises')
    const s = await stat(filePath)
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size }
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    assertPathAllowed(filePath, opts)
    const { stat } = await import('node:fs/promises')
    const s = await stat(filePath)
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size }
  }

  const bwrapArgs = buildBwrapArgs(opts)
  const result = await bwrapExec([...bwrapArgs, '--', 'stat', '--printf', '%F\\n%s', filePath])
  const lines = result.stdout.split('\n')
  const fileType = lines[0] ?? ''
  const size = parseInt(lines[1] ?? '0', 10)
  return {
    isDirectory: fileType === 'directory',
    isFile: fileType === 'regular file' || fileType === 'regular empty file',
    size,
  }
}

export async function sandboxReaddir(dirPath: string, opts: SandboxOptions): Promise<Array<{ name: string; isDirectory: boolean }>> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    assertPathAllowed(dirPath, opts)
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  }

  const bwrapArgs = buildBwrapArgs(opts)
  // -1ap (no -L): annotate entry types via lstat. Following symlinks would
  // let a workspace-internal symlink resolve to a path outside the bind
  // mount and leak its type into readdir results.
  const result = await bwrapExec([...bwrapArgs, '--', 'bash', '-c', `ls -1ap ${JSON.stringify(dirPath)}`])
  return result.stdout.split('\n').filter(Boolean).filter((n) => n !== './' && n !== '../').map((name) => {
    const isDir = name.endsWith('/')
    return { name: isDir ? name.slice(0, -1) : name, isDirectory: isDir }
  })
}

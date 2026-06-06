/**
 * File-based logger — intercepts console.log/error/warn and writes to .halo/logs/server.log.
 *
 * Log location:
 *   - Default: ~/.halo/logs/server.log
 *   - When workspace is open: {workspaceRoot}/.halo/logs/server.log
 *
 * Rotation: when file exceeds MAX_SIZE, rotates to server.log.1, .2, ... up to MAX_FILES.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { config } from './config.js'

const LOG_FILENAME = 'server.log'

let logDir = path.join(homedir(), '.halo', 'global', 'logs')
let logFile = path.join(logDir, LOG_FILENAME)
let currentSize = -1 // -1 = not yet measured

function ensureDir(): void {
  fs.mkdirSync(logDir, { recursive: true })
}

function measureSize(): number {
  try {
    return fs.statSync(logFile).size
  } catch {
    return 0
  }
}

function rotate(): void {
  const maxFiles = config.logging.maxFiles
  // Delete oldest
  try { fs.unlinkSync(`${logFile}.${maxFiles}`) } catch { /* ok */ }
  // Shift .N → .N+1
  for (let i = maxFiles - 1; i >= 1; i--) {
    try { fs.renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`) } catch { /* ok */ }
  }
  // Current → .1
  try { fs.renameSync(logFile, `${logFile}.1`) } catch { /* ok */ }
  currentSize = 0
}

function writeToFile(line: string): void {
  try {
    ensureDir()
    if (currentSize < 0) currentSize = measureSize()
    if (currentSize >= config.logging.maxFileSize) rotate()
    fs.appendFileSync(logFile, line)
    currentSize += Buffer.byteLength(line)
  } catch {
    // Silently fail — don't break the server for logging issues
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack ?? a.message
      try { return JSON.stringify(a) } catch { return String(a) }
    })
    .join(' ')
}

/** Switch log directory to workspace-specific path */
export function setLogDir(workspaceRoot: string): void {
  const newDir = path.join(workspaceRoot, '.halo', 'logs')
  if (newDir === logDir) return
  logDir = newDir
  logFile = path.join(newDir, LOG_FILENAME)
  currentSize = -1
  console.log(`Log file switched to: ${logFile}`)
}

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LEVEL_ORDER

function shouldLog(level: LogLevel): boolean {
  const threshold = LEVEL_ORDER[config.logging.level] ?? LEVEL_ORDER.warn
  return LEVEL_ORDER[level] >= threshold
}

/** Install console interceptors — call once at server startup */
export function initLogger(): void {
  const origLog = console.log.bind(console)
  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)
  const origDebug = console.debug.bind(console)

  console.debug = (...args: unknown[]) => {
    if (!shouldLog('debug')) return
    origDebug(...args)
    writeToFile(`${new Date().toISOString()} DEBUG ${formatArgs(args)}\n`)
  }

  console.log = (...args: unknown[]) => {
    if (!shouldLog('info')) return
    origLog(...args)
    writeToFile(`${new Date().toISOString()} INFO  ${formatArgs(args)}\n`)
  }

  console.warn = (...args: unknown[]) => {
    if (!shouldLog('warn')) return
    origWarn(...args)
    writeToFile(`${new Date().toISOString()} WARN  ${formatArgs(args)}\n`)
  }

  console.error = (...args: unknown[]) => {
    if (!shouldLog('error')) return
    origError(...args)
    writeToFile(`${new Date().toISOString()} ERROR ${formatArgs(args)}\n`)
  }

  writeToFile(`${new Date().toISOString()} INFO  [Logger] File logging initialized: ${logFile} (level: ${config.logging.level})\n`)
}

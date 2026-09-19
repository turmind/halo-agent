/**
 * File-based logger — intercepts console.log/error/warn and writes to
 * ~/.halo/global/logs/server.log.
 *
 * Always global: a single server process serves many workspaces, so a
 * per-workspace log dir (the old setLogDir) would cross-contaminate — whichever
 * workspace last opened won the global path and stole everyone else's lines.
 * Logs are a runtime/ops artifact, not part of a workspace's portable `.halo/`.
 *
 * Line format is logfmt-flavored: `time=… level=… <message>`. time/level are
 * parseable key=value fields; the message keeps its `[Module]` prefix convention
 * for readability (promoting module to a real field would mean touching every
 * call site — deferred until a log pipeline actually needs it).
 *
 * Rotation: when file exceeds MAX_SIZE, rotates to server.log.1, .2, ... up to MAX_FILES.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { config } from './config.js'
import { enabled as otelEnabled, otelLogger } from './observability/otel.js'

const LOG_FILENAME = 'server.log'

const logDir = path.join(homedir(), '.halo', 'global', 'logs')
const logFile = path.join(logDir, LOG_FILENAME)
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

/** logfmt-flavored line: `time=<iso> level=<level> <message>\n`. */
function formatLine(level: LogLevel, args: unknown[]): string {
  return `time=${new Date().toISOString()} level=${level} ${formatArgs(args)}\n`
}

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LEVEL_ORDER

function shouldLog(level: LogLevel): boolean {
  const threshold = LEVEL_ORDER[config.logging.level] ?? LEVEL_ORDER.warn
  return LEVEL_ORDER[level] >= threshold
}

const OTEL_SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
}

/** Mirror a console line to the OTel logger (no-op unless observability is
 *  enabled). Callers have already passed the shouldLog gate. The `[Module]`
 *  prefix becomes a real attribute here since the OTLP consumer can filter on it. */
function emitOtelLog(level: LogLevel, args: unknown[]): void {
  if (!otelEnabled) return
  const body = formatArgs(args)
  const module = body.match(/^\[([^\]]+)\]/)?.[1]
  otelLogger.emit({
    severityNumber: OTEL_SEVERITY[level],
    severityText: level.toUpperCase(),
    body,
    attributes: module ? { 'halo.module': module } : undefined,
  })
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
    writeToFile(formatLine('debug', args))
    emitOtelLog('debug', args)
  }

  console.log = (...args: unknown[]) => {
    if (!shouldLog('info')) return
    origLog(...args)
    writeToFile(formatLine('info', args))
    emitOtelLog('info', args)
  }

  console.warn = (...args: unknown[]) => {
    if (!shouldLog('warn')) return
    origWarn(...args)
    writeToFile(formatLine('warn', args))
    emitOtelLog('warn', args)
  }

  console.error = (...args: unknown[]) => {
    if (!shouldLog('error')) return
    origError(...args)
    writeToFile(formatLine('error', args))
    emitOtelLog('error', args)
  }

  if (shouldLog('info')) {
    writeToFile(formatLine('info', [`[Logger] File logging initialized: ${logFile} (level: ${config.logging.level})`]))
  }
}

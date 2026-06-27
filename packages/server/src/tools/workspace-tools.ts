/**
 * Workspace tools for sub-agents (file operations, shell, etc.)
 *
 * Access control is enforced by the OS-level sandbox (bwrap) for
 * 'workspace' and 'readonly' sessions. 'full' sessions bypass the sandbox.
 */
import type { ToolDef } from '../agents/bedrock-agent.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { homedir } from 'node:os'
import { sandboxExec, sandboxReadFile, sandboxReadBinaryFile, sandboxWriteFile, sandboxStat, sandboxReaddir, assertPathAllowed, isBwrapCached } from './sandbox.js'
import type { AccessLevel, SandboxOptions } from './sandbox.js'
import { loadMergedSettings } from '../prompts/md-vars.js'
import { inferImageMime } from '../channels/shared/media-store.js'
import { TOOL_ERROR_MARKER, TOOL_WARN_MARKER } from '../agents/agent-loop.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.halo'])

// Safety backstop for glob: cap how many matches we accumulate. The real fix
// for runaway walks is lstat (see walkDir) — this just bounds the result
// string when a pattern legitimately matches an enormous tree.
const GLOB_MAX_RESULTS = 5000

const HOME = homedir()

function resolvePath(filePath: string, workspaceRoot: string): string {
  const expanded = filePath.startsWith('~/')
    ? path.join(HOME, filePath.slice(2))
    : filePath
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot, expanded)
}

/**
 * Recursively walk a directory, yielding file paths.
 * Skips node_modules, .git, and other non-essential dirs.
 *
 * Uses lstat (not stat) so symlinks are never followed — a symlink to a
 * directory is reported as a symlink, not recursed into. Without this, a
 * circular symlink (e.g. inside a conda env) sends the walk into infinite
 * recursion that pins the CPU and can't be interrupted. `find`/`ripgrep`
 * default to the same non-following behaviour.
 *
 * The optional signal lets a caller abort a long walk; we check it once per
 * directory level so a stopped session actually unwinds the recursion.
 */
async function* walkDir(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
  if (signal?.aborted) return
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (signal?.aborted) return
    if (SKIP_DIRS.has(name)) continue
    const fullPath = path.join(dir, name)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(fullPath)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      yield* walkDir(fullPath, signal)
    } else if (stat.isFile()) {
      yield fullPath
    }
  }
}

/**
 * Check if a file is likely binary by reading the first 512 bytes
 * and looking for null bytes.
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buf, 0, 512, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } catch {
    return true
  } finally {
    await handle?.close()
  }
}

/**
 * Split an include filter on top-level commas only, so brace alternation
 * ("*.{ts,tsx}") survives while a comma-separated list ("*.ts,*.tsx") is
 * broken into its parts.
 */
function splitIncludeList(include: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of include) {
    if (ch === '{') { depth++; cur += ch }
    else if (ch === '}') { depth = Math.max(0, depth - 1); cur += ch }
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = '' }
    else cur += ch
  }
  parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/**
 * Match a filename against a simple glob-like include filter.
 * Supports patterns like "*.ts", "*.{ts,tsx}", "*.json", and comma-separated
 * lists like "*.ts,*.tsx" (matches if ANY part matches).
 */
function matchInclude(fileName: string, include: string): boolean {
  return splitIncludeList(include).some((p) => matchOneInclude(fileName, p))
}

function matchOneInclude(fileName: string, include: string): boolean {
  // Convert simple glob to regex
  // Handle {a,b} alternation
  let pattern = include
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/\{([^}]+)\}/g, (_match, group: string) => {
      return `(${group.split(',').join('|')})`
    })
  pattern = `^${pattern}$`
  try {
    return new RegExp(pattern).test(fileName)
  } catch {
    return false
  }
}

/**
 * Match a file path against a glob pattern.
 * Supports patterns like ** / *.ts, src/** / *.tsx, *.json.
 */
function matchGlob(relativePath: string, pattern: string): boolean {
  // Normalize separators
  const normalized = relativePath.replace(/\\/g, '/')
  const normalizedPattern = pattern.replace(/\\/g, '/')

  // Convert glob to regex
  let regexStr = normalizedPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '__GLOBSTAR_SLASH__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GLOBSTAR_SLASH__/g, '(.+/)?')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/\{([^}]+)\}/g, (_match, group: string) => {
      return `(${group.split(',').join('|')})`
    })
  regexStr = `^${regexStr}$`
  try {
    return new RegExp(regexStr).test(normalized)
  } catch {
    return false
  }
}

// `{{<namespace>.params.<key>}}` is substituted at shell_exec time. The
// namespace is a skill id (or any other declarer); `<key>` may itself be
// dotted. `{{<namespace>.secrets.<key>}}` is intentionally **not** expanded —
// secrets stay server-side and never reach an agent's shell.
//
// `<<ENV>>` placeholders are *only* expanded inside the value resolved from
// `{{…params.x}}` — never in cmd text the agent wrote directly. The trust
// boundary is "settings file content", not "string happens to contain a
// placeholder".
const PARAMS_PATTERN = /\{\{\s*([\w-]+)\.params\.([\w-][\w.-]*)\s*\}\}/g
const ENV_PATTERN = /<<([A-Z_][A-Z0-9_]*)>>/g

interface SubstitutionResult { cmd: string; secrets: string[] }

/**
 * Substitute `{{<id>.params.<key>}}` placeholders in a shell_exec command.
 *
 * `allowedNamespaces` limits which `<id>` values are eligible. Pass the
 * agent's own id plus the ids of skills it has access to — anything else
 * (including a placeholder pointing at another skill the agent could name but
 * isn't authorized to use) stays as the literal
 * `{{...}}` string, so the call fails loudly at the API layer instead of
 * silently using someone else's secret.
 *
 * Pass `undefined` to allow any namespace (legacy behaviour, used only
 * when access control isn't wired yet).
 */
async function substituteSecrets(
  cmd: string,
  workspaceRoot: string,
  allowedNamespaces: Set<string> | undefined,
): Promise<SubstitutionResult> {
  const hasParams = PARAMS_PATTERN.test(cmd)
  PARAMS_PATTERN.lastIndex = 0
  if (!hasParams) return { cmd, secrets: [] }

  const secrets: string[] = []
  const settings = await loadMergedSettings(workspaceRoot)
  const result = cmd.replace(PARAMS_PATTERN, (_match, namespace: string, dotted: string) => {
    if (allowedNamespaces && !allowedNamespaces.has(namespace)) {
      console.log(`[workspace-tools] {{${namespace}.params.${dotted}}} rejected — namespace not in allowed list`)
      return _match
    }
    const parts = [namespace, 'params', ...dotted.split('.')]
    let cur: unknown = settings
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return _match
      cur = (cur as Record<string, unknown>)[part]
    }
    // Self-describing leaf (`{ value: ..., description: ..., secret? }`)
    // — extract the value side. Whether the value gets registered for
    // output masking is decided below.
    if (cur != null && typeof cur === 'object' && !Array.isArray(cur) && 'value' in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>).value
    }
    // Coerce non-string scalars (numbers, booleans) into their string
    // form so natural yaml entries like `port: 9527` substitute as
    // `"9527"`. Without this any non-string leaf rendered as the literal
    // placeholder, which surprised callers writing typed yaml.
    if (cur == null) return _match
    let str: string
    if (typeof cur === 'string') str = cur
    else if (typeof cur === 'number' || typeof cur === 'boolean' || typeof cur === 'bigint') str = String(cur)
    else return _match

    // <<ENV>> placeholders inside a settings value get expanded here —
    // and only here, never on agent-written cmd text. The expanded env
    // value is registered for output masking (env-injected creds are
    // sensitive by definition).
    let envInjected = false
    const expanded = str.replace(ENV_PATTERN, (m, name: string) => {
      const val = process.env[name]
      if (val === undefined) return m
      secrets.push(val)
      envInjected = true
      return val
    })
    // Mask the resolved string only if any portion came from an env
    // var. Plain literal params (host names, ports, workspace paths)
    // don't get masked — masking everything turned tool errors into
    // unreadable `connect to *** failed`. If you have a sensitive
    // literal (a token), put it behind <<TOKEN_ENV>> to opt into masking.
    if (envInjected && expanded !== '') secrets.push(expanded)
    return expanded
  })

  return { cmd: result, secrets }
}

function maskSecrets(output: string, secrets: string[]): string {
  let masked = output
  for (const s of secrets) {
    if (s.length < 4) continue
    masked = masked.replaceAll(s, '***')
  }
  return masked
}

export interface WorkspaceToolsOptions {
  /** Per-session access level applied via the bwrap sandbox. */
  accessLevel?: AccessLevel
  /**
   * Whitelist of namespace ids the agent's `shell_exec` may resolve in
   * `{{<id>.params.<key>}}` placeholders. Pass `undefined` for "anything
   * goes" (used by call sites that haven't been wired to access control yet,
   * e.g. the agent-form preview).
   */
  allowedNamespaces?: Set<string>
  /**
   * Whether the agent's model accepts image content blocks. When false,
   * `view_image` is dropped from the returned tool list — the model would
   * otherwise see the tool, call it, and crash on a 400 from the provider
   * (DeepSeek / non-vision OpenAI models reject image blocks). Defaults to
   * true to keep backwards-compat with call sites that haven't been wired
   * up yet (e.g. the agent-form preview).
   */
  supportsVision?: boolean
}

export function createWorkspaceTools(
  workspaceRoot: string,
  accessLevelOrOpts: AccessLevel | WorkspaceToolsOptions | undefined = 'full',
): ToolDef[] {
  // Backwards-compat shim: existing callers pass an AccessLevel literal as
  // the second arg. Wrapping into the options object keeps that working
  // while letting newer callers pass `{ accessLevel, allowedNamespaces }`.
  const opts: WorkspaceToolsOptions = typeof accessLevelOrOpts === 'string' || accessLevelOrOpts == null
    ? { accessLevel: (accessLevelOrOpts ?? 'full') as AccessLevel }
    : accessLevelOrOpts
  const accessLevel: AccessLevel = opts.accessLevel ?? 'full'
  const allowedNamespaces = opts.allowedNamespaces
  const supportsVision = opts.supportsVision ?? true
  const sbOpts: SandboxOptions = { workspaceRoot, accessLevel }

  const fileRead: ToolDef = {
    name: 'file_read',
    description: [
      'Read the contents of a file from the workspace.',
      '',
      '- The `path` parameter accepts workspace-relative paths, absolute paths,',
      '  and `~/`-prefixed paths.',
      '- By default reads up to 2000 lines starting from the beginning of the file.',
      '- For longer files, pass `offset` (1-based line number to start at) and',
      '  `limit` (number of lines to return).',
      '- Results are returned in `cat -n` format — each line is prefixed with',
      '  its 1-based line number followed by a tab. When using results to',
      '  construct `file_edit` calls, strip the line-number prefix from `old_string`.',
      '- Files larger than 2 MB without an `offset` / `limit` are rejected with a',
      '  hint to page through them; use `grep` to locate the section first if you',
      "  don't know which range to read.",
      '- Output is capped at ~8000 chars; a longer result is truncated with an',
      '  explicit `[Content truncated…]` marker — re-call with `offset` + `limit`',
      '  to read the next slice if you need more.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path — workspace-relative, absolute, or starting with ~/' },
        offset: { type: 'integer', description: '1-based line number to start at (default: 1).', minimum: 1 },
        limit: { type: 'integer', description: 'Number of lines to return (default: 2000).', minimum: 1 },
      },
      required: ['path'],
    },
    callback: async (_input: unknown) => {
      const input = _input as { path: string; offset?: number; limit?: number }
      const fullPath = resolvePath(input.path, workspaceRoot)
      const offset = Math.max(1, Math.floor(input.offset ?? 1))
      const limit = Math.max(1, Math.floor(input.limit ?? 2000))
      const userProvidedRange = input.offset != null || input.limit != null

      const stat = await sandboxStat(fullPath, sbOpts)
      // Files over 2 MB without an explicit range get rejected — full reads
      // at that size routinely consume tens of thousands of tokens. The user
      // should grep first or page through with offset+limit.
      const HARD_SIZE_LIMIT = 2 * 1024 * 1024
      if (!userProvidedRange && stat.size > HARD_SIZE_LIMIT) {
        return [
          TOOL_WARN_MARKER,
          `Error: file too large to read in full (${(stat.size / 1024 / 1024).toFixed(1)} MB).`,
          `Pass \`offset\` and \`limit\` to read a specific range, or use \`grep\` to locate the section first.`,
        ].join('\n')
      }

      const raw = await sandboxReadFile(fullPath, sbOpts)
      const lines = raw.split('\n')
      const totalLines = lines.length
      const startIdx = offset - 1
      const endIdx = Math.min(totalLines, startIdx + limit)
      if (startIdx >= totalLines) {
        return `(empty: file has ${totalLines} lines, offset=${offset} is past end)`
      }

      const slice = lines.slice(startIdx, endIdx)
      // Match `cat -n` formatting: right-aligned line number, tab, content.
      // Width derived from the largest line number in this slice so it stays
      // compact for short files and expands gracefully for long ones.
      const numWidth = String(endIdx).length
      const numbered = slice.map((line, i) => {
        const n = (startIdx + i + 1).toString().padStart(numWidth, ' ')
        return `${n}\t${line}`
      })

      const trailingNote: string[] = []
      if (endIdx < totalLines) {
        trailingNote.push(`... ${totalLines - endIdx} more line(s) — use \`offset=${endIdx + 1}\` to continue.`)
      }
      return [...numbered, ...trailingNote].join('\n')
    },
  }

  const viewImage: ToolDef = {
    name: 'view_image',
    description: 'Load an image file (png/jpg/jpeg/gif/webp) as a visual input — the image is returned as a vision block the model can see directly, so screenshots / generated charts / video frames on disk become visible without describing them. Paths are resolved like file_read. Oversized images are auto-downscaled to fit the model\'s image limit, so you can load full-resolution screenshots directly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Image path — relative to workspace root, absolute, or starting with ~/' },
      },
      required: ['path'],
    },
    callback: async (_input: unknown) => {
      const input = _input as { path: string }
      const fullPath = resolvePath(input.path, workspaceRoot)
      const ext = path.extname(fullPath).toLowerCase()
      const supportedExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
      if (!supportedExts.has(ext)) {
        return `${TOOL_WARN_MARKER}\nError: unsupported image type "${ext}". Supported: png, jpg, jpeg, gif, webp.`
      }
      const buf = await sandboxReadBinaryFile(fullPath, sbOpts)
      // The extension only gates which files we accept — the media_type we
      // hand the model must come from the actual bytes. A jpeg saved as .png
      // (common with screenshots/downloads) otherwise gets tagged image/png
      // and the vision API rejects the whole request ("appears to be jpeg").
      const mediaType = inferImageMime(buf)
      const md5 = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8)

      // Anthropic caps a single image at ~5 MB of *base64* (not raw bytes), and
      // base64 inflates ~33%, so a ~3.8 MB raw image already overflows the API
      // limit and the whole request errors out. The model often screenshots at
      // full resolution (which it can't shrink itself), so rather than reject,
      // we downscale+re-encode to fit. The file on disk is untouched — only the
      // bytes we hand the model are compressed.
      // Anthropic's vision limits: a single image's base64 must be ≤5 MB, and
      // anything past a 1568px long edge / ~1.15 MP is downscaled by the API
      // anyway (extra latency), with >8000px outright rejected. So we normalise
      // to BOTH ceilings up front — fit the byte budget AND cap the long edge —
      // independently, since a big-but-not-5MB screenshot (e.g. a 6000px tall
      // page grab) would otherwise sail past the byte check yet still be
      // oversized. Only the bytes handed to the model change; the file is kept.
      const B64_LIMIT = 5 * 1024 * 1024
      const MAX_EDGE = 1568
      const b64Len = (n: number) => Math.ceil(n / 3) * 4
      const dims = imageDimensions(buf, mediaType)
      const tooManyBytes = b64Len(buf.length) > B64_LIMIT
      const tooBig = dims != null && Math.max(dims.w, dims.h) > MAX_EDGE
      let outMediaType = mediaType
      let outBuf = buf
      let note = ''
      if (tooManyBytes || tooBig) {
        try {
          const { Jimp } = await import('jimp')
          const img = await Jimp.read(buf)
          // Cap the long edge to MAX_EDGE, then re-encode as JPEG, stepping
          // quality down until the base64 fits. JPEG (not PNG) so photographic
          // screenshots shrink hard; mirrors the camera/screen-capture path.
          const longEdge = Math.max(img.bitmap.width, img.bitmap.height)
          if (longEdge > MAX_EDGE) img.scale(MAX_EDGE / longEdge)
          let q = 82
          let jpeg = await img.getBuffer('image/jpeg', { quality: q })
          while (b64Len(jpeg.length) > B64_LIMIT && q > 30) {
            q -= 15
            jpeg = await img.getBuffer('image/jpeg', { quality: q })
          }
          outBuf = jpeg
          outMediaType = 'image/jpeg'
          note = ` — resized to ${img.bitmap.width}×${img.bitmap.height}, ${(jpeg.length / 1024).toFixed(0)} KB (jpeg q${q}) to fit the model's image limits`
        } catch (err) {
          return `${TOOL_WARN_MARKER}\nError: image is too large for the model and automatic compression failed (${err instanceof Error ? err.message : String(err)}). Shrink it (lower resolution / crop the relevant region) and retry.`
        }
      }
      return [
        { type: 'text' as const, text: `Image loaded: ${input.path} (${outMediaType}, ${(outBuf.length / 1024).toFixed(1)} KB, md5: ${md5}${note})` },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: outMediaType, data: outBuf.toString('base64') } },
      ]
    },
  }

  const fileWrite: ToolDef = {
    name: 'file_write',
    description: [
      'Writes a file to the workspace, overwriting any existing content.',
      '',
      '- Use this for creating a new file or for a complete rewrite. Targeted',
      '  changes to an existing file land more cleanly via `file_edit`, which',
      '  only sends the diff and preserves the rest of the file verbatim.',
      '- Parent directories are created if missing.',
      '- Existing files are silently overwritten — there is no implicit append.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path — workspace-relative, absolute, or starting with ~/' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
    callback: async (_input: unknown) => {
      const input = _input as { path: string; content: string }
      const fullPath = resolvePath(input.path, workspaceRoot)
      await sandboxWriteFile(fullPath, input.content, sbOpts)
      return `File written: ${input.path}`
    },
  }

  const fileEdit: ToolDef = {
    name: 'file_edit',
    description: [
      'Performs an exact string replacement inside a file.',
      '',
      '- `old_string` is matched verbatim; whitespace, indentation and trailing',
      '  newlines all count. Use `file_read` first so the bytes you pass match',
      '  what is actually on disk.',
      '- When you copied `old_string` from `file_read` output, strip the leading',
      '  `<lineNumber>\\t` prefix that `file_read` adds — the file itself does',
      '  not contain those line numbers.',
      '- The edit fails when `old_string` is empty, identical to `new_string`,',
      '  or appears more than once in the file. Pass `replace_all: true` to',
      '  rewrite every occurrence (useful for renaming an identifier), or',
      '  enlarge `old_string` with surrounding context until it is unique.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path — workspace-relative, absolute, or starting with ~/' },
        old_string: { type: 'string', description: 'The exact text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string (default: false).' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    callback: async (_input: unknown) => {
      const input = _input as { path: string; old_string: string; new_string: string; replace_all?: boolean }
      const fullPath = resolvePath(input.path, workspaceRoot)
      if (input.old_string === '') {
        return `${TOOL_WARN_MARKER}\nError: old_string is empty. Provide the exact text to replace.`
      }
      if (input.old_string === input.new_string) {
        return `${TOOL_WARN_MARKER}\nError: old_string and new_string are identical — nothing to change.`
      }
      const content = await sandboxReadFile(fullPath, sbOpts)
      if (!content.includes(input.old_string)) {
        return `${TOOL_WARN_MARKER}\nError: old_string not found in ${input.path}. Re-read the file to verify the exact bytes (whitespace / line endings / indentation).`
      }
      // Count occurrences only when replace_all is off — bail before writing
      // if a single replacement would be ambiguous.
      if (!input.replace_all) {
        const first = content.indexOf(input.old_string)
        const second = content.indexOf(input.old_string, first + input.old_string.length)
        if (second !== -1) {
          return `${TOOL_WARN_MARKER}\nError: old_string appears more than once in ${input.path}. Either expand it with surrounding context until it's unique, or pass replace_all: true.`
        }
      }
      const newContent = input.replace_all
        ? content.split(input.old_string).join(input.new_string)
        : content.replace(input.old_string, input.new_string)
      await sandboxWriteFile(fullPath, newContent, sbOpts)
      return `File edited: ${input.path}`
    },
  }

  const fileList: ToolDef = {
    name: 'file_list',
    description: [
      'List files and directories at a path.',
      '',
      '- Path resolves workspace-relative, absolute, or `~/`-prefixed.',
      '- Pass `recursive: true` to walk the whole subtree. Recursive listings',
      '  cap at 500 entries to keep tool output manageable; use `glob` when',
      "  you're searching for files matching a pattern.",
      '- Always skips `node_modules` and `.git`.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path — workspace-relative, absolute, or starting with ~/ (default: workspace root)' },
        recursive: { type: 'boolean', description: 'Walk the whole subtree (default: false).' },
      },
      required: [],
    },
    callback: async (_input: unknown) => {
      const input = _input as { path?: string; recursive?: boolean }
      const dirPath = resolvePath(input.path ?? '.', workspaceRoot)
      const recursive = input.recursive === true
      const RECURSIVE_CAP = 500

      if (!recursive) {
        const entries = await sandboxReaddir(dirPath, sbOpts)
        const results: string[] = []
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          const prefix = entry.isDirectory ? '📁 ' : '📄 '
          results.push(`${prefix}${entry.name}`)
        }
        return results.join('\n')
      }

      // Recursive walk — bounded by RECURSIVE_CAP. We DFS so the listing
      // stays grouped by parent dir (more readable than BFS for picking
      // out which subtree a file belongs to).
      const results: string[] = []
      let truncated = false

      async function walk(dir: string, prefix: string): Promise<void> {
        if (results.length >= RECURSIVE_CAP) { truncated = true; return }
        let entries: Awaited<ReturnType<typeof sandboxReaddir>>
        try {
          entries = await sandboxReaddir(dir, sbOpts)
        } catch { return }
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          if (results.length >= RECURSIVE_CAP) { truncated = true; return }
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory) {
            results.push(`📁 ${relPath}/`)
            await walk(path.join(dir, entry.name), relPath)
          } else {
            results.push(`📄 ${relPath}`)
          }
        }
      }
      await walk(dirPath, '')
      if (truncated) {
        results.push(`… [truncated at ${RECURSIVE_CAP} entries — use glob with a more specific pattern]`)
      }
      return results.join('\n')
    },
  }

  const shellExec: ToolDef = {
    name: 'shell_exec',
    description: [
      'Execute a shell command in the workspace directory. Full shell access —',
      'install packages, run scripts, invoke any CLI tool.',
      '',
      'For routine file work, the dedicated tools land cleaner output and a',
      'cleaner permission trail than shelling out:',
      '- Reading files: `file_read` (NOT `cat` / `head` / `tail`)',
      '- Editing files: `file_edit` (NOT `sed` / `awk`)',
      '- Writing files: `file_write` (NOT `echo > file` / heredocs)',
      '- Searching content: `grep` (the dedicated tool)',
      '- Searching paths: `glob`',
      '',
      'shell_exec is the right call for things the dedicated tools can\'t do —',
      'package install, build / test, git, ad-hoc pipelines that combine many',
      'binaries.',
      '',
      'Output is capped at ~8000 chars; a longer combined stdout/stderr is',
      'truncated with an explicit `[Content truncated…]` marker. For commands',
      'that produce a lot of output, redirect to a file (`> /tmp/out.log`) and',
      'use `grep` / `file_read` with `offset`+`limit` to inspect what you need.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
    callback: async (_input: unknown, signal?: AbortSignal) => {
      const input = _input as { command: string }
      // Readonly sessions don't get secret substitution: any `{{params.x}}` /
      // `<<ENV>>` placeholders pass through as literals, so a readonly agent
      // can't borrow a more-privileged agent's keys via shell_exec. The cmd
      // simply fails (401 / unknown auth) — that's the desired behavior.
      const { cmd, secrets } = accessLevel === 'readonly'
        ? { cmd: input.command.trim(), secrets: [] as string[] }
        : await substituteSecrets(input.command.trim(), workspaceRoot, allowedNamespaces)
      const mask = (s: string) => secrets.length > 0 ? maskSecrets(s, secrets) : s

      try {
        const { stdout, stderr } = await sandboxExec(cmd, {
          ...sbOpts,
          timeout: config.timeout.shellExec,
          maxBuffer: config.limits.shellOutputBuffer,
          signal,
        })
        return mask((stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim() || '(no output)')
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; message: string }
        return mask(`${TOOL_ERROR_MARKER}\nCommand failed: ${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`)
      }
    },
  }

  const grepTool: ToolDef = {
    name: 'grep',
    description: 'Search file contents using a regex pattern. Returns matching lines in file:line:content format. Skips node_modules, .git, and binary files. Output is capped at ~8000 chars on top of `max_results` — narrow the pattern or path if you hit the truncation marker.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or single file to search in, relative to workspace root (default: workspace root)' },
        include: { type: 'string', description: 'Glob-like file filter, e.g. "*.ts", "*.{ts,tsx}", or a comma-separated list "*.ts,*.tsx"' },
        max_results: { type: 'number', description: 'Maximum number of matching lines to return (default: 50)' },
      },
      required: ['pattern'],
    },
    callback: async (_input: unknown, signal?: AbortSignal) => {
      const input = _input as { pattern: string; path?: string; include?: string; max_results?: number }
      const searchDir = resolvePath(input.path ?? '.', workspaceRoot)
      assertPathAllowed(searchDir, sbOpts)
      const maxResults = input.max_results ?? config.limits.grepDefaultMax

      let regex: RegExp
      try {
        regex = new RegExp(input.pattern)
      } catch (err) {
        return `${TOOL_WARN_MARKER}\nError: Invalid regex pattern: ${(err as Error).message}`
      }

      const results: string[] = []

      // `path` may point at a single file, not just a directory. walkDir uses
      // fs.readdir under the hood, which throws on a file path and would then
      // silently yield zero matches — detect a file target and search just it.
      let fileTarget = false
      try {
        fileTarget = (await fs.stat(searchDir)).isFile()
      } catch { /* missing path: walkDir yields nothing → honest "no matches" */ }
      const files: AsyncIterable<string> | Iterable<string> = fileTarget ? [searchDir] : walkDir(searchDir, signal)

      for await (const filePath of files) {
        if (results.length >= maxResults) break

        if (input.include && !matchInclude(path.basename(filePath), input.include)) {
          continue
        }

        if (await isBinaryFile(filePath)) continue

        let content: string
        try {
          content = await sandboxReadFile(filePath, sbOpts)
        } catch {
          continue
        }

        const relativePath = path.relative(workspaceRoot, filePath)
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break
          if (regex.test(lines[i])) {
            results.push(`${relativePath}:${i + 1}:${lines[i]}`)
          }
        }
      }

      if (results.length === 0) {
        return `No matches found for pattern "${input.pattern}"`
      }
      return results.join('\n')
    },
  }

  const globTool: ToolDef = {
    name: 'glob',
    description: [
      'Find FILES matching a glob pattern (e.g. "**/*.ts", "src/**/*.tsx", "*.json").',
      'Returns matching file paths relative to workspace root. Skips node_modules and .git.',
      '',
      'IMPORTANT: glob matches FILE paths, not directory names. A pattern like',
      '"**/foo" will NOT find a *directory* named foo (it only matches a file',
      'literally named foo). To check whether a directory exists or see what is',
      'inside it, match the files under it with a trailing "/**" — e.g. "**/foo/**"',
      '— or use the `list` tool / `shell_exec` with `ls`. A "No files found" result',
      'means no matching files, NOT necessarily that a directory is missing.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match FILE paths against (e.g. "**/*.ts", "src/**/*.tsx"). To target a directory, match its contents with "dir/**".' },
        path: { type: 'string', description: 'Starting directory relative to workspace root (default: workspace root)' },
      },
      required: ['pattern'],
    },
    callback: async (_input: unknown, signal?: AbortSignal) => {
      const input = _input as { pattern: string; path?: string }
      const searchDir = resolvePath(input.path ?? '.', workspaceRoot)
      assertPathAllowed(searchDir, sbOpts)
      const results: string[] = []

      for await (const filePath of walkDir(searchDir, signal)) {
        if (results.length >= GLOB_MAX_RESULTS) break
        const relativePath = path.relative(workspaceRoot, filePath)
        if (matchGlob(relativePath, input.pattern)) {
          results.push(relativePath)
        }
      }

      results.sort()

      if (results.length === 0) {
        // A pattern with no wildcard and no extension is very likely an attempt
        // to find a directory by name — which glob can't do (it matches files).
        // Nudge toward the right approach so a missing match isn't misread as
        // "this path doesn't exist".
        const looksLikeDirName = !/[*?]/.test(input.pattern) && !/\.[a-z0-9]+$/i.test(input.pattern.split('/').pop() ?? '')
        const hint = looksLikeDirName
          ? ` (glob matches files, not directory names — if "${input.pattern}" is a directory, try "${input.pattern.replace(/\/+$/, '')}/**" to list its files, or use the \`list\` tool)`
          : ''
        return `No files found matching pattern "${input.pattern}"${hint}`
      }
      return results.join('\n')
    },
  }

  const webFetch: ToolDef = {
    name: 'web_fetch',
    description: 'Fetch content from a URL. Returns status code, content-type, and response body (read-cap 50KB, then further truncated to ~8000 chars before being shown to you with an explicit `[Content truncated…]` marker). For long pages, fetch with a tighter URL fragment / query, or pipe through your own grep on the saved bytes if you need full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Optional HTTP headers as key-value pairs' },
      },
      required: ['url'],
    },
    callback: async (_input: unknown, externalSignal?: AbortSignal) => {
      const input = _input as { url: string; method?: string; headers?: Record<string, string> }
      const MAX_BODY_SIZE = config.limits.webFetchMaxBody

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.timeout.webFetch)
      const onExternalAbort = () => controller.abort()
      externalSignal?.addEventListener('abort', onExternalAbort)
      if (externalSignal?.aborted) controller.abort()

      try {
        const response = await fetch(input.url, {
          method: input.method ?? 'GET',
          headers: input.headers,
          signal: controller.signal,
        })

        const contentType = response.headers.get('content-type') ?? 'unknown'
        let body = await response.text()

        if (body.length > MAX_BODY_SIZE) {
          body = body.substring(0, MAX_BODY_SIZE) + `\n... [truncated to ${Math.round(MAX_BODY_SIZE / 1024)}KB]`
        }

        return `Status: ${response.status}\nContent-Type: ${contentType}\n\n${body}`
      } catch (err) {
        const error = err as Error
        if (error.name === 'AbortError') {
          if (externalSignal?.aborted) return `${TOOL_WARN_MARKER}\nError: Request aborted`
          return `${TOOL_ERROR_MARKER}\nError: Request timed out after ${config.timeout.webFetch / 1000} seconds`
        }
        return `${TOOL_ERROR_MARKER}\nError: ${error.message}`
      } finally {
        clearTimeout(timeout)
        externalSignal?.removeEventListener('abort', onExternalAbort)
      }
    },
  }

  // `view_image` only goes out when the model can ingest vision blocks —
  // otherwise the provider returns a 400 the moment the agent calls it.
  const visionTools = supportsVision ? [viewImage] : []
  const allTools = [fileRead, ...visionTools, fileWrite, fileEdit, fileList, shellExec, grepTool, globTool, webFetch]
  if (accessLevel === 'readonly' && !isBwrapCached()) {
    return [fileRead, ...visionTools, fileList, grepTool, globTool]
  }
  return allTools
}

/**
 * Read an image's pixel dimensions straight from its header — no full decode,
 * so view_image can cheaply decide whether to downscale without spinning up
 * jimp on every (often already-small) image. Covers PNG and JPEG, the formats
 * screenshots use; returns null for anything else (caller then falls back to
 * the byte-size check alone). Pure header parsing, best-effort.
 */
function imageDimensions(buf: Buffer, mediaType: string): { w: number; h: number } | null {
  try {
    if (mediaType === 'image/png') {
      // PNG: 8-byte sig, then IHDR whose width/height are big-endian u32 at 16/20.
      if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    }
    if (mediaType === 'image/jpeg') {
      // JPEG: walk markers to the first SOF (0xC0–0xCF, excluding non-frame
      // C4/C8/CC), whose payload holds height then width as big-endian u16.
      if (buf.readUInt16BE(0) !== 0xffd8) return null
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue }
        const marker = buf[off + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) }
        }
        off += 2 + buf.readUInt16BE(off + 2) // skip this segment by its length
      }
      return null
    }
  } catch { /* malformed header — fall back to byte-size check */ }
  return null
}

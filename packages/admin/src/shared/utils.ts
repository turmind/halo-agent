import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36)
}

/**
 * Cross-platform absolute-path test for workspace inputs. The server runs on
 * the user's own machine, so a path is "absolute" if it's POSIX-absolute
 * (`/Users/…`) OR Windows-absolute (`C:\…`, `C:/…`, or a `\\server\share`
 * UNC path). The browser has no `path` module, so we detect both shapes here
 * — using only `startsWith('/')` rejected every valid Windows path.
 */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/')) return true // POSIX
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true // Windows drive: C:\ or C:/
  if (p.startsWith('\\\\')) return true // Windows UNC \\server\share
  return false
}

/**
 * Text-input prompt that works in both the browser and the Electron desktop
 * shell. Electron disables the native (synchronous) `window.prompt` — it
 * returns null silently — which made "new file / folder / agent / skill"
 * appear to do nothing. The desktop preload injects an async
 * `window.haloPrompt`; we prefer it when present and fall back to the
 * native prompt in a plain browser. Always await this. Resolves to the
 * entered string, or null on cancel.
 */
export function promptInput(message: string, defaultValue?: string): Promise<string | null> {
  const w = window as unknown as { haloPrompt?: (m: string, d?: string) => Promise<string | null> }
  if (typeof w.haloPrompt === 'function') return w.haloPrompt(message, defaultValue)
  return Promise.resolve(window.prompt(message, defaultValue))
}

/**
 * Confirmation dialog that works in both the browser and the Electron desktop
 * shell. Electron can't honor the native (synchronous) `window.confirm` from
 * the renderer — its preload shim returns false immediately, so every
 * confirm-to-delete flow silently no-op'd (clicking OK did nothing). The
 * desktop preload injects an async `window.haloConfirm`; we prefer it when
 * present and fall back to the native confirm in a plain browser. Always
 * await this. Resolves true on confirm, false on cancel.
 */
export function confirmAction(message: string): Promise<boolean> {
  const w = window as unknown as { haloConfirm?: (m: string) => Promise<boolean> }
  if (typeof w.haloConfirm === 'function') return w.haloConfirm(message)
  return Promise.resolve(window.confirm(message))
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    yaml: 'yaml',
    yml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',
    toml: 'toml',
    xml: 'xml',
    svg: 'xml',
    env: 'plaintext',
    gitignore: 'plaintext',
    dockerfile: 'dockerfile',
  }
  return map[ext] ?? 'plaintext'
}

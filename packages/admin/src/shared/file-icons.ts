import {
  FileCode,
  FileJson,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileAudio,
  FileSpreadsheet,
  FileArchive,
  Settings,
  Terminal,
  Braces,
  Hash,
  Palette,
  Globe,
  Database,
  File,
  type LucideIcon,
} from 'lucide-react'

const EXT_ICON: Record<string, LucideIcon> = {
  // TypeScript / JavaScript
  ts: Braces, tsx: Braces, mts: Braces, cts: Braces,
  js: Braces, jsx: Braces, mjs: Braces, cjs: Braces,
  // JSON / Config
  json: FileJson, jsonc: FileJson,
  // Markup
  html: Globe, htm: Globe, svg: Globe, xml: Globe,
  // Style
  css: Palette, scss: Palette, sass: Palette, less: Palette,
  // Markdown / Text
  md: FileText, mdx: FileText, txt: FileText, rst: FileText, log: FileText,
  // Data
  csv: FileSpreadsheet, tsv: FileSpreadsheet, xlsx: FileSpreadsheet, xls: FileSpreadsheet,
  sql: Database,
  // Shell / Config
  sh: Terminal, bash: Terminal, zsh: Terminal,
  yaml: Settings, yml: Settings, toml: Settings, ini: Settings, env: Settings,
  // Python
  py: Hash,
  // Go / Rust / C / Java
  go: FileCode, rs: FileCode, c: FileCode, cpp: FileCode, h: FileCode, hpp: FileCode,
  java: FileCode, kt: FileCode, scala: FileCode, cs: FileCode, swift: FileCode, dart: FileCode,
  rb: FileCode, php: FileCode, lua: FileCode, r: FileCode,
  // Images
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, webp: FileImage, bmp: FileImage, ico: FileImage, avif: FileImage,
  // Video
  mp4: FileVideo, webm: FileVideo, mov: FileVideo, avi: FileVideo, mkv: FileVideo, ogg: FileVideo,
  // Audio
  mp3: FileAudio, wav: FileAudio, flac: FileAudio, aac: FileAudio, m4a: FileAudio, wma: FileAudio,
  // Archive
  zip: FileArchive, tar: FileArchive, gz: FileArchive, '7z': FileArchive, rar: FileArchive,
  // PDF / Docs
  pdf: FileType, docx: FileType, doc: FileType, pptx: FileType, ppt: FileType,
}

const EXT_COLOR: Record<string, string> = {
  ts: 'text-blue-400', tsx: 'text-blue-400', mts: 'text-blue-400', cts: 'text-blue-400',
  js: 'text-yellow-400', jsx: 'text-yellow-400', mjs: 'text-yellow-400', cjs: 'text-yellow-400',
  json: 'text-yellow-300', jsonc: 'text-yellow-300',
  html: 'text-orange-400', htm: 'text-orange-400',
  css: 'text-blue-300', scss: 'text-pink-400', sass: 'text-pink-400', less: 'text-blue-300',
  md: 'text-sky-300', mdx: 'text-sky-300',
  py: 'text-green-400',
  go: 'text-cyan-400', rs: 'text-orange-400',
  java: 'text-red-400', rb: 'text-red-300', php: 'text-indigo-300',
  sh: 'text-green-300', bash: 'text-green-300',
  svg: 'text-orange-300', xml: 'text-orange-300',
  yaml: 'text-red-300', yml: 'text-red-300',
  sql: 'text-cyan-300',
  png: 'text-purple-300', jpg: 'text-purple-300', jpeg: 'text-purple-300', gif: 'text-purple-300',
  webp: 'text-purple-300', avif: 'text-purple-300',
  mp4: 'text-pink-300', webm: 'text-pink-300', mov: 'text-pink-300',
  mp3: 'text-emerald-300', wav: 'text-emerald-300', flac: 'text-emerald-300',
  pdf: 'text-red-400', docx: 'text-blue-400', doc: 'text-blue-400',
  pptx: 'text-orange-400', ppt: 'text-orange-400',
  zip: 'text-amber-400', tar: 'text-amber-400', gz: 'text-amber-400',
}

export function getFileIcon(path: string): { Icon: LucideIcon; color: string } {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const name = path.split('/').pop()?.toLowerCase() ?? ''

  // Special filenames
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return { Icon: Terminal, color: 'text-cyan-400' }
  if (name === '.gitignore' || name === '.gitattributes') return { Icon: Settings, color: 'text-zinc-400' }
  if (name === '.env' || name.startsWith('.env.')) return { Icon: Settings, color: 'text-yellow-300' }
  if (name === 'makefile' || name === 'cmake') return { Icon: Terminal, color: 'text-zinc-400' }

  return {
    Icon: EXT_ICON[ext] ?? File,
    color: EXT_COLOR[ext] ?? 'text-[var(--muted-foreground)]',
  }
}

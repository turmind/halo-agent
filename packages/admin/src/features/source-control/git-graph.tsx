'use client'

import { useCallback, useEffect, useState } from 'react'
import { GitBranch, Tag } from 'lucide-react'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { timeAgo } from '@/shared/components/session-list-dropdown'
import { useT } from '@/shared/i18n'
import { cn } from '@/shared/utils'
import { getFileIcon } from '@/shared/file-icons'
import { useGitStore } from './git-store'
import { statusMeta } from './status-meta'

type Commit = Awaited<ReturnType<typeof api.git.log>>['commits'][number]
type CommitFile = Awaited<ReturnType<typeof api.git.commitFiles>>['files'][number]

// Track-rail geometry (px). DOT_CENTER must equal the commit header's top
// padding (py-2 = 8px) plus half the message line height (leading-4 = 16px →
// 8px), so the dot sits centered on the commit message line.
const TRACK_W = 24
const DOT = 10
const DOT_CENTER = 16

type RefKind = 'head' | 'branch' | 'remote' | 'tag'
interface RefInfo {
  kind: RefKind
  label: string
}

/** Split git's refs string ("HEAD -> main, origin/main, tag: v1") into trimmed
 *  labels. */
function parseRefs(refs: string): string[] {
  return refs.split(',').map((r) => r.trim()).filter(Boolean)
}

/** Classify one ref so the badge can mark the current branch (HEAD), tags, and
 *  remote branches differently. Returns null for noise (the symbolic
 *  `origin/HEAD` pointer) so it doesn't render. */
function classifyRef(ref: string): RefInfo | null {
  if (ref.startsWith('HEAD -> ')) return { kind: 'head', label: ref.slice('HEAD -> '.length) }
  if (ref === 'HEAD') return { kind: 'head', label: 'HEAD' }
  if (ref.startsWith('tag: ')) return { kind: 'tag', label: ref.slice('tag: '.length) }
  if (ref.endsWith('/HEAD')) return null
  if (ref.includes('/')) return { kind: 'remote', label: ref }
  return { kind: 'branch', label: ref }
}

/** Split a path into basename + dimmed parent dir for the file row. */
function splitPath(p: string): { name: string; dir: string } {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? { name: p, dir: '' } : { name: p.slice(idx + 1), dir: p.slice(0, idx) }
}

const REF_PILL = 'inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] leading-tight'

function RefBadge({ info }: { info: RefInfo }) {
  const Icon = info.kind === 'tag' ? Tag : GitBranch
  const tone =
    info.kind === 'head'
      ? 'bg-[var(--primary)] text-[var(--primary-foreground)] font-medium'
      : info.kind === 'tag'
        ? 'bg-amber-400/10 text-amber-300 ring-1 ring-inset ring-amber-400/30'
        : info.kind === 'remote'
          ? 'bg-[var(--secondary)] text-[var(--muted-foreground)]'
          : 'bg-[var(--secondary)] text-[var(--secondary-foreground)]'
  return (
    <span className={cn(REF_PILL, tone)}>
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{info.label}</span>
    </span>
  )
}

/** One changed file under an expanded commit. Mirrors change-tree's row (file
 *  icon + status-colored name + letter badge); clicking it shows that commit's
 *  own diff for the file in the main pane. */
function CommitFileRow({
  file,
  active,
  onSelect,
}: {
  file: CommitFile
  active: boolean
  onSelect: () => void
}) {
  const meta = statusMeta(file.status)
  const { Icon, color } = getFileIcon(file.path)
  const { name, dir } = splitPath(file.path)
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-xs',
        active ? 'bg-[var(--accent)]' : 'hover:bg-[var(--accent)]',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} />
      <span className="shrink-0 truncate" style={{ color: meta.color }}>{name}</span>
      {dir && <span className="truncate text-[10px] text-[var(--muted-foreground)]">{dir}</span>}
      <span className="flex-1" />
      <span
        className="w-4 shrink-0 text-center font-mono text-[11px] font-semibold"
        style={{ color: meta.color }}
        title={meta.label}
      >
        {meta.letter}
      </span>
    </button>
  )
}

/**
 * Commit history for the Source Control "Graph" view, styled after VSCode's
 * GRAPH: a continuous vertical track on the left with a node per commit (hollow
 * ring for HEAD/newest, filled dots below), then message / short hash / author
 * / relative time / ref badges on the right. A single straight track only —
 * real branching DAG lines are intentionally out of scope.
 *
 * Click a commit to expand its changed-file list; click a file to view that
 * commit's own diff (parent vs commit) in the main pane via the shared
 * git-store selection — the same viewer the Changes list drives.
 */
export function GitGraph({ projectId }: { projectId: string }) {
  const t = useT()
  const select = useGitStore((s) => s.select)
  const selected = useGitStore((s) => s.selected)
  const [commits, setCommits] = useState<Commit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  // Cache changed-files per commit hash. Hashes are immutable, so entries never
  // go stale across refreshes — only new commits (new hashes) need fetching.
  const [filesByHash, setFilesByHash] = useState<Record<string, CommitFile[]>>({})

  const refresh = useCallback(async () => {
    try {
      const res = await api.git.log(projectId)
      setCommits(res.commits)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoaded(true)
    }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])

  // New commits change the log; refresh on file:changed (debounced, no polling).
  // The server re-broadcasts file:changed after commit/stage/unstage/push/pull
  // (the watcher ignores .git, so those wouldn't otherwise reach us).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = wsClient.on('file:changed', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 400)
    })
    return () => { if (timer) clearTimeout(timer); unsub() }
  }, [refresh])

  const toggleCommit = useCallback((hash: string) => {
    setExpandedHash((cur) => (cur === hash ? null : hash))
    setFilesByHash((cache) => {
      if (cache[hash]) return cache
      api.git.commitFiles(projectId, hash)
        .then((res) => setFilesByHash((m) => ({ ...m, [hash]: res.files })))
        .catch(() => setFilesByHash((m) => ({ ...m, [hash]: [] })))
      return cache
    })
  }, [projectId])

  if (error) return <div className="px-3 py-4 text-xs text-red-400">{error}</div>
  if (loaded && commits.length === 0) {
    return <div className="px-3 py-4 text-xs text-[var(--muted-foreground)]">{t('sc.noCommits')}</div>
  }

  return (
    <div className="py-1">
      {commits.map((commit, i) => {
        const isFirst = i === 0
        const isExpanded = expandedHash === commit.hash
        const files = filesByHash[commit.hash]
        const refs = commit.refs
          ? parseRefs(commit.refs)
              .map(classifyRef)
              .filter((r): r is RefInfo => r !== null)
          : []
        return (
          <div key={commit.hash} className="flex px-3">
            {/* Track rail: continuous vertical line + this commit's node. The
                segment below the dot runs to the row bottom (which includes any
                expanded file list), so it abuts the next row's top segment into
                one unbroken track. */}
            <div className="relative shrink-0" style={{ width: TRACK_W }}>
              {!isFirst && (
                <div
                  className="absolute left-1/2 w-px -translate-x-1/2 bg-[var(--primary)] opacity-30"
                  style={{ top: 0, height: DOT_CENTER }}
                />
              )}
              <div
                className="absolute left-1/2 w-px -translate-x-1/2 bg-[var(--primary)] opacity-30"
                style={{ top: DOT_CENTER, bottom: 0 }}
              />
              <div
                className={cn(
                  'absolute left-1/2 z-10 -translate-x-1/2 rounded-full',
                  isFirst
                    ? 'border-2 border-[var(--primary)] bg-[var(--background)]'
                    : 'bg-[var(--primary)]',
                )}
                style={{ top: DOT_CENTER - DOT / 2, width: DOT, height: DOT }}
              />
            </div>

            {/* Commit detail + expandable file list */}
            <div className="min-w-0 flex-1">
              <div
                onClick={() => toggleCommit(commit.hash)}
                className={cn(
                  'cursor-pointer rounded-sm py-2',
                  isExpanded ? 'bg-[var(--accent)]' : 'hover:bg-[var(--accent)]',
                )}
              >
                <div className="truncate text-xs leading-4 text-[var(--foreground)]">{commit.message}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
                  <span className="font-mono">{commit.shortHash}</span>
                  <span className="truncate">{commit.author}</span>
                  <span className="shrink-0">· {timeAgo(commit.date)}</span>
                </div>
                {refs.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {refs.map((info) => (
                      <RefBadge key={`${info.kind}:${info.label}`} info={info} />
                    ))}
                  </div>
                )}
              </div>

              {isExpanded && (
                <div className="mb-1 ml-1 border-l border-[var(--border)] pl-2">
                  {files === undefined ? (
                    <div className="py-1 text-[10px] text-[var(--muted-foreground)]">…</div>
                  ) : files.length === 0 ? (
                    <div className="py-1 text-[10px] text-[var(--muted-foreground)]">{t('sc.noCommitFiles')}</div>
                  ) : (
                    files.map((file) => (
                      <CommitFileRow
                        key={file.path}
                        file={file}
                        active={selected?.commit === commit.hash && selected.path === file.path}
                        onSelect={() => select({ path: file.path, staged: false, from: file.from, commit: commit.hash })}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

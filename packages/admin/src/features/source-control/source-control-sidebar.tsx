'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  GitBranch,
  RefreshCw,
  Check,
  Plus,
  Minus,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Settings,
  ListTree,
  GitGraph as GitGraphIcon,
  FolderGit2,
  Upload,
} from 'lucide-react'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { useGitStore } from './git-store'
import { ChangeTree } from './change-tree'
import { CredentialsModal } from './credentials-modal'
import { GitGraph } from './git-graph'
import { isStagedChar, isWorkingChar } from './status-meta'
import type { GitStatus, GitFileStatus } from './types'

/** Auth/permission failures from push/pull, which we translate into a
 *  "configure credentials" prompt instead of dumping git's raw message. Covers
 *  both HTTPS (authentication / could not read Username / 401 / 403) and SSH
 *  (permission denied / publickey / passphrase). Other errors (conflicts,
 *  network) fall through and show verbatim. */
function isAuthError(msg: string): boolean {
  return /authentication|could not read username|permission denied|publickey|passphrase|\b401\b|\b403\b/i.test(msg)
}

export function SourceControlSidebar() {
  const t = useT()
  const projectId = useProjectStore((s) => s.activeProject?.id ?? null)
  const selected = useGitStore((s) => s.selected)
  const select = useGitStore((s) => s.select)
  const clearSelection = useGitStore((s) => s.clear)

  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notRepo, setNotRepo] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showCreds, setShowCreds] = useState(false)
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [changesCollapsed, setChangesCollapsed] = useState(false)
  const [view, setView] = useState<'changes' | 'graph'>('changes')
  // Remote-state gate (③): null = not loaded; [] = repo with no remote → guide
  // the user to add one. `hasCommits` gates the publish prompt (VSCode only
  // offers Publish after a first commit).
  const [remotes, setRemotes] = useState<Array<{ name: string; url: string }> | null>(null)
  const [hasCommits, setHasCommits] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')

  const refresh = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await api.git.status(projectId)
      // Not a git work-tree root → friendly "initialize" empty state (the
      // server reports this as a normal 200, isRepo:false — not an error).
      if (res.isRepo === false) {
        setNotRepo(true)
        setStatus(null)
        setRemotes(null)
        setError(null)
        return
      }
      setStatus(res)
      setNotRepo(false)
      setError(null)
      // Once we know it's a repo, learn whether a remote is configured. Only
      // probe for commits (cheap log(1)) when there's no remote — that's the
      // single case where the publish prompt needs to know if there's anything
      // to publish. With a remote, the normal push/pull UI applies.
      const r = await api.git.remotes(projectId)
      setRemotes(r.remotes)
      if (r.remotes.length === 0) {
        const log = await api.git.log(projectId, 1)
        setHasCommits(log.commits.length > 0)
      } else {
        setHasCommits(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])

  // Push-based refresh: the workspace file watcher already broadcasts
  // `file:changed` whenever the tree changes (it ignores .git, so our own
  // stage/commit don't loop). Debounce to collapse rapid bursts. No polling.
  useEffect(() => {
    if (!projectId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = wsClient.on('file:changed', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 400)
    })
    return () => { if (timer) clearTimeout(timer); unsub() }
  }, [projectId, refresh])

  const files = status?.files ?? []
  const stagedFiles = files.filter((f) => isStagedChar(f.index))
  const changedFiles = files.filter((f) => isWorkingChar(f.workingDir))

  async function runAction(fn: () => Promise<unknown>) {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onSelect = useCallback((file: GitFileStatus, staged: boolean) => {
    select({ path: file.path, staged, from: file.from })
  }, [select])

  function stage(paths: string[]) { void runAction(() => api.git.stage(projectId!, paths)) }
  function unstage(paths: string[]) { void runAction(() => api.git.unstage(projectId!, paths)) }

  async function commit() {
    if (!projectId || !message.trim()) return
    await runAction(async () => {
      await api.git.commit(projectId, message)
      setMessage('')
      clearSelection()
    })
  }

  function initRepo() { void runAction(() => api.git.init(projectId!)) }

  function addRemote() {
    if (!projectId || !remoteUrl.trim()) return
    void runAction(async () => {
      await api.git.addRemote(projectId, remoteUrl.trim())
      setRemoteUrl('')
    })
  }

  const hasRemote = (remotes?.length ?? 0) > 0

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--background)] p-6 text-center">
        <GitBranch className="h-8 w-8 text-zinc-700" />
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">{t('sc.noWorkspace')}</p>
      </div>
    )
  }

  // Gate ①: not a git repo → a clean empty state with one action, nothing else.
  // Every other git control (branch row, commit box, push/pull) is meaningless
  // here, so none of them render until the folder is initialized (VSCode-style).
  if (notRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--background)] p-6 text-center">
        <FolderGit2 className="h-8 w-8 text-zinc-700" />
        <p className="max-w-[240px] text-xs text-[var(--muted-foreground)]">{t('sc.initRepoDesc')}</p>
        <button
          onClick={initRepo}
          disabled={busy}
          className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
        >
          <FolderGit2 className="h-3.5 w-3.5" />
          {busy ? t('sc.initializing') : t('sc.initRepo')}
        </button>
        {actionError && <p className="max-w-[240px] text-[11px] text-red-400">{actionError}</p>}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      {/* Header: title + branch + ahead/behind + actions */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <GitBranch className="h-4 w-4 text-[var(--muted-foreground)]" />
        <span className="text-sm font-medium text-[var(--foreground)]">{t('nav.sourceControl')}</span>
        <div className="flex-1" />
        <div className="flex items-center rounded border border-[var(--border)]">
          <button
            onClick={() => setView('changes')}
            title={t('sc.viewChanges')}
            className={cn('rounded-l p-1', view === 'changes' ? 'bg-[var(--secondary)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]')}
          >
            <ListTree className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setView('graph')}
            title={t('sc.viewGraph')}
            className={cn('rounded-r p-1', view === 'graph' ? 'bg-[var(--secondary)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]')}
          >
            <GitGraphIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          onClick={() => setShowCreds(true)}
          title={t('sc.cred.title')}
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => { void refresh() }}
          title={t('sc.refresh')}
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        </button>
      </div>

      {/* Branch row with ahead/behind + push/pull */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
        <span className="truncate text-xs font-medium text-[var(--foreground)]">
          {status?.branch ?? '—'}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]">
            {status.behind > 0 && (<span className="flex items-center"><ArrowDown className="h-3 w-3" />{status.behind}</span>)}
            {status.ahead > 0 && (<span className="flex items-center"><ArrowUp className="h-3 w-3" />{status.ahead}</span>)}
          </span>
        )}
        <div className="flex-1" />
        {/* Push/pull only make sense once a remote exists — otherwise they'd
            error on click. The no-remote case is handled by the publish prompt
            below (gate ③). */}
        {hasRemote && (
          <>
            <button
              onClick={() => void runAction(() => api.git.pull(projectId))}
              disabled={busy}
              title={t('sc.pull')}
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => void runAction(() => api.git.push(projectId))}
              disabled={busy}
              title={t('sc.push')}
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Gate ③: repo has commits but no remote → guide the user to add one.
          Replaces the push affordance (there's nowhere to push yet). An empty
          repo with no commits shows nothing here — there's nothing to publish. */}
      {!hasRemote && hasCommits && view === 'changes' && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border)] p-2">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
            <Upload className="h-3.5 w-3.5 shrink-0" />
            <span>{t('sc.addRemoteDesc')}</span>
          </div>
          <input
            type="text"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && remoteUrl.trim()) addRemote() }}
            placeholder={t('sc.remotePlaceholder')}
            autoComplete="off"
            className="rounded border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 font-mono text-[11px] text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]"
          />
          <button
            onClick={addRemote}
            disabled={busy || !remoteUrl.trim()}
            className="flex items-center justify-center gap-1.5 rounded bg-[var(--primary)] px-2 py-1 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" /> {busy ? t('sc.adding') : t('sc.addRemote')}
          </button>
        </div>
      )}

      {/* Commit message + commit button (changes view only) */}
      {view === 'changes' && (
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border)] p-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void commit() }
          }}
          placeholder={t('sc.commitPlaceholder')}
          rows={2}
          className="resize-none rounded border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 text-xs text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]"
        />
        <button
          onClick={() => void commit()}
          disabled={busy || !message.trim() || stagedFiles.length === 0}
          className="flex items-center justify-center gap-1.5 rounded bg-[var(--primary)] px-2 py-1 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" /> {t('sc.commit')}
        </button>
      </div>
      )}

      {actionError && (
        <div className="shrink-0 border-b border-[var(--border)] bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
          {/* Gate ④: translate auth/permission failures into a human prompt +
              a button to the credentials panel, instead of git's raw message.
              Non-auth errors (conflict, network) still show verbatim. */}
          {isAuthError(actionError) ? t('sc.authError') : actionError}
          {isAuthError(actionError) && (
            <button onClick={() => setShowCreds(true)} className="ml-1 underline hover:text-red-300">
              {t('sc.openCreds')}
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {view === 'graph' ? (
          <GitGraph projectId={projectId} />
        ) : error ? (
          <div className="px-3 py-4 text-xs text-red-400">{error}</div>
        ) : files.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--muted-foreground)]">{t('sc.clean')}</div>
        ) : (
          <>
            {/* Staged Changes group */}
            {stagedFiles.length > 0 && (
              <div>
                <div className="group flex items-center gap-1 px-2 py-1">
                  <button onClick={() => setStagedCollapsed((v) => !v)} className="flex flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                    {stagedCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {t('sc.staged')}
                  </button>
                  <button
                    onClick={() => unstage(stagedFiles.map((f) => f.path))}
                    title={t('sc.unstageAll')}
                    className="hidden rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] group-hover:block"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="rounded bg-[var(--secondary)] px-1.5 text-[10px] text-[var(--muted-foreground)]">{stagedFiles.length}</span>
                </div>
                {!stagedCollapsed && (
                  <ChangeTree
                    files={stagedFiles}
                    group="staged"
                    selectedPath={selected?.staged ? selected.path : null}
                    onSelect={(f) => onSelect(f, true)}
                    onAction={unstage}
                  />
                )}
              </div>
            )}

            {/* Changes group (unstaged + untracked) */}
            {changedFiles.length > 0 && (
              <div>
                <div className="group flex items-center gap-1 px-2 py-1">
                  <button onClick={() => setChangesCollapsed((v) => !v)} className="flex flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                    {changesCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {t('sc.changes')}
                  </button>
                  <button
                    onClick={() => stage(changedFiles.map((f) => f.path))}
                    title={t('sc.stageAll')}
                    className="hidden rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] group-hover:block"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <span className="rounded bg-[var(--secondary)] px-1.5 text-[10px] text-[var(--muted-foreground)]">{changedFiles.length}</span>
                </div>
                {!changesCollapsed && (
                  <ChangeTree
                    files={changedFiles}
                    group="changes"
                    selectedPath={selected && !selected.staged ? selected.path : null}
                    onSelect={(f) => onSelect(f, false)}
                    onAction={stage}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

      {showCreds && (
        <CredentialsModal projectId={projectId} onClose={() => setShowCreds(false)} onSaved={() => { /* status reflected in modal */ }} />
      )}
    </div>
  )
}

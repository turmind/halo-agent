'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/shared/api-client'
import { X, Lock, LockOpen, RefreshCw, ExternalLink, Trash2 } from 'lucide-react'
import { useT } from '@/shared/i18n'
import { cn } from '@/shared/utils'

interface CredentialsModalProps {
  projectId: string
  onClose: () => void
  onSaved: () => void
}

type Tab = 'https' | 'ssh'

export function CredentialsModal({ projectId, onClose, onSaved }: CredentialsModalProps) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('https')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[460px] rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <h3 className="text-sm font-medium text-[var(--foreground)]">{t('sc.cred.title')}</h3>
          <button onClick={onClose} className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 border-b border-[var(--border)] px-4 pt-3">
          {(['https', 'ssh'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'rounded-t px-3 py-1.5 text-xs font-medium',
                tab === key
                  ? 'bg-[var(--secondary)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
              )}
            >
              {key === 'https' ? t('sc.cred.tabHttps') : t('sc.cred.tabSsh')}
            </button>
          ))}
        </div>

        {tab === 'https'
          ? <HttpsTab onClose={onClose} onSaved={onSaved} />
          : <SshTab projectId={projectId} onClose={onClose} />}
      </div>
    </div>
  )
}

const FIELD =
  'rounded border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]'

interface GitCredential { host: string; username: string }

function HttpsTab({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const [creds, setCreds] = useState<GitCredential[]>([])
  const [confirmingHost, setConfirmingHost] = useState<string | null>(null)
  const [host, setHost] = useState('github.com')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.git.getCredentials().then((r) => setCreds(r.credentials)).catch(() => setCreds([]))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function handleSave() {
    if (!host.trim() || !username.trim() || !token) {
      setError(t('sc.cred.required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.git.saveCredentials({ host: host.trim(), username: username.trim(), token })
      setToken('') // keep host/username so the user can keep adding; don't close the modal
      refresh()
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Inline two-step delete: first click arms (confirmingHost = host), second fires.
  async function handleDelete(targetHost: string) {
    setError(null)
    try {
      await api.git.deleteCredential(targetHost)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfirmingHost(null)
    }
  }

  return (
    <>
      <div className="flex max-h-[420px] flex-col gap-3 overflow-y-auto px-4 py-4">
        <p className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.httpsDesc')}</p>

        {/* Configured credentials list */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.configuredList')}</span>
          {creds.length === 0 ? (
            <p className="rounded border border-dashed border-[var(--border)] px-2 py-3 text-center text-[10px] text-[var(--muted-foreground)]">
              {t('sc.cred.noCredsYet')}
            </p>
          ) : (
            creds.map((cred) => (
              <div key={cred.host} className="flex items-center gap-2 rounded border border-[var(--border)] px-2.5 py-1.5 text-xs">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-[var(--foreground)]">{cred.host}</span>
                  <span className="truncate text-[10px] text-[var(--muted-foreground)]">{cred.username}</span>
                </div>
                {confirmingHost === cred.host ? (
                  <button
                    onClick={() => handleDelete(cred.host)}
                    className="shrink-0 rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-400 hover:bg-red-500/25"
                  >
                    {t('sc.cred.confirmDelete')}
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmingHost(cred.host)}
                    title={t('sc.cred.delete')}
                    className="shrink-0 rounded p-1 text-[var(--muted-foreground)] hover:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-[var(--border)]" />

        {/* Add a new credential */}
        <div className="flex flex-col gap-3">
          <span className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.addNew')}</span>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.host')}</span>
            <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" className={FIELD} />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.username')}</span>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className={FIELD} />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.token')}</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              className={FIELD}
            />
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {t('sc.cred.tokenHint')}{' '}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-[var(--primary)] hover:underline"
              >
                {t('sc.cred.tokenLink')}<ExternalLink className="h-2.5 w-2.5" />
              </a>
            </span>
          </label>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2.5">
        <button onClick={onClose} className="rounded px-3 py-1 text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--secondary)]">
          {t('sc.cred.cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-[var(--primary)] px-3 py-1 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
        >
          {saving ? t('sc.cred.saving') : t('sc.cred.save')}
        </button>
      </div>
    </>
  )
}

interface SshKey { name: string; path: string; encrypted: boolean }

function SshTab({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useT()
  const [keys, setKeys] = useState<SshKey[]>([])
  const [agentRunning, setAgentRunning] = useState(false)
  const [loadedKeys, setLoadedKeys] = useState<string[]>([])
  const [protocol, setProtocol] = useState<'https' | 'ssh' | 'other'>('other')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Path of the key whose passphrase input is open (only one at a time).
  const [unlockingKey, setUnlockingKey] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [unlockBusy, setUnlockBusy] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.git.sshKeys().then((r) => setKeys(r.keys)).catch(() => setKeys([]))
    api.git.sshAgent().then((r) => { setAgentRunning(r.agentRunning); setLoadedKeys(r.loadedKeys) }).catch(() => {})
    api.git.getRemoteProtocol(projectId).then((r) => { setProtocol(r.protocol); setRemoteUrl(r.url) }).catch(() => {})
  }, [projectId])

  useEffect(() => { refresh() }, [refresh])

  function openUnlock(key: SshKey) {
    setUnlockingKey(key.path)
    setPassphrase('')
    setUnlockError(null)
  }

  function cancelUnlock() {
    setUnlockingKey(null)
    setPassphrase('')
    setUnlockError(null)
  }

  async function handleUnlock(key: SshKey) {
    setUnlockBusy(true)
    setUnlockError(null)
    try {
      const r = await api.git.unlockSshKey({ keyPath: key.path, passphrase })
      if (r.ok) {
        cancelUnlock()
        refresh() // key flips to "Loaded"
      } else {
        setUnlockError(r.error ?? t('sc.cred.sshUnlockFailed'))
      }
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : String(err))
    } finally {
      setUnlockBusy(false)
    }
  }

  async function handleSwitch(to: 'https' | 'ssh') {
    setBusy(true)
    setError(null)
    try {
      const r = await api.git.setRemoteProtocol(projectId, to)
      setProtocol(to)
      setRemoteUrl(r.url)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex max-h-[420px] flex-col gap-3 overflow-y-auto px-4 py-4">
        <p className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.sshDesc')}</p>

        {/* Agent status */}
        <div className="flex items-center gap-2 rounded bg-[var(--secondary)] px-2.5 py-1.5 text-xs">
          <span className={cn('h-2 w-2 rounded-full', agentRunning ? 'bg-emerald-400' : 'bg-[var(--muted-foreground)]')} />
          <span className="text-[var(--muted-foreground)]">
            {agentRunning ? t('sc.cred.sshAgentOn', { count: String(loadedKeys.length) }) : t('sc.cred.sshAgentOff')}
          </span>
          <button onClick={refresh} className="ml-auto rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" title={t('sc.cred.sshRefresh')}>
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>

        {/* Key list */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.sshKeys')}</span>
          {keys.length === 0 ? (
            <p className="rounded border border-dashed border-[var(--border)] px-2 py-3 text-center text-[10px] text-[var(--muted-foreground)]">
              {t('sc.cred.sshNoKeys')}
            </p>
          ) : (
            keys.map((key) => {
              const isLoaded = loadedKeys.some((l) => l.includes(key.path) || l.includes(key.name))
              const isUnlocking = unlockingKey === key.path
              return (
                <div key={key.path} className="rounded border border-[var(--border)]">
                  <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                    {key.encrypted
                      ? <Lock className="h-3 w-3 shrink-0 text-amber-400" />
                      : <LockOpen className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />}
                    <span className="truncate text-[var(--foreground)]">{key.name}</span>
                    {isLoaded ? (
                      <span className="ml-auto text-[10px] text-emerald-400">{t('sc.cred.sshLoaded')}</span>
                    ) : !isUnlocking && (
                      <button
                        onClick={() => openUnlock(key)}
                        className="ml-auto shrink-0 rounded bg-[var(--secondary)] px-2 py-0.5 text-[10px] font-medium text-[var(--foreground)] hover:opacity-90"
                      >
                        {t('sc.cred.sshUnlock')}
                      </button>
                    )}
                  </div>
                  {/* Not yet loaded → unlock in place: type the passphrase, it goes
                      straight to ssh-add (never stored). */}
                  {!isLoaded && isUnlocking && (
                    <div className="flex flex-col gap-1.5 border-t border-[var(--border)] px-2.5 py-2">
                      <span className="text-[10px] leading-relaxed text-[var(--muted-foreground)]">{t('sc.cred.sshUnlockHint')}</span>
                      <input
                        type="password"
                        autoFocus
                        autoComplete="off"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !unlockBusy) handleUnlock(key) }}
                        placeholder={t('sc.cred.sshPassphrase')}
                        className={FIELD}
                      />
                      {unlockError && <span className="text-[10px] leading-relaxed text-red-400">{unlockError}</span>}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={cancelUnlock}
                          disabled={unlockBusy}
                          className="rounded px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--secondary)] disabled:opacity-40"
                        >
                          {t('sc.cred.cancel')}
                        </button>
                        <button
                          onClick={() => handleUnlock(key)}
                          disabled={unlockBusy}
                          className="rounded bg-[var(--primary)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
                        >
                          {unlockBusy ? t('sc.cred.sshUnlocking') : t('sc.cred.sshUnlock')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Remote protocol */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted-foreground)]">{t('sc.cred.sshRemote')}</span>
          <div className="flex items-center gap-2 rounded bg-[var(--secondary)] px-2.5 py-1.5">
            <span className="truncate text-[10px] text-[var(--muted-foreground)]" title={remoteUrl}>{remoteUrl || '—'}</span>
            <div className="ml-auto flex shrink-0 overflow-hidden rounded border border-[var(--border)]">
              {(['https', 'ssh'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => handleSwitch(p)}
                  disabled={busy || protocol === p}
                  className={cn(
                    'px-2 py-0.5 text-[10px] font-medium',
                    protocol === p ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-40',
                  )}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-[var(--muted-foreground)]">{t('sc.cred.sshRestartNote')}</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2.5">
        <button onClick={onClose} className="rounded px-3 py-1 text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--secondary)]">
          {t('sc.cred.close')}
        </button>
      </div>
    </>
  )
}

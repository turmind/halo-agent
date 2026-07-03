/**
 * Workspace runtime ownership marker — gates reconcileOrphansOnBoot.
 *
 * Root cause this exists for: TWO server processes (different HALO_HOME /
 * ports — e.g. prod on :9527 and dev on :8527) can each build a SessionManager
 * over the SAME workspace directory. reconcileOrphansOnBoot assumes "nothing
 * of this workspace is running in ANY process yet" — true for a single server,
 * broken the moment a second server first-touches the workspace while the
 * first is mid-run: the second's boot reconcile batch-marks the first's LIVE
 * sub-sessions stopped (db says stopped, the agent loop never re-reads
 * stoppedAt and keeps running — db state splits from reality). The global
 * `server.lock` can't arbitrate this: it lives under each server's own
 * HALO_HOME, while the workspace is the shared resource — so the ownership
 * marker must live in the workspace itself: `<workspace>/.halo/runtime.lock`,
 * containing the owner's pid.
 *
 * Protocol (single-machine scope; NFS / cross-host is explicitly out):
 *   - claim = O_EXCL create with own pid. First claimer owns the runtime.
 *   - later process, holder pid ALIVE  → do not touch the file, return false
 *     (caller skips reconcile — prefer missing a cleanup over stopping
 *     another process's live sessions).
 *   - holder pid DEAD / unreadable / garbage → stale (server crashed):
 *     take over via write-tmp + atomic rename, return true — the crash-orphan
 *     cleanup that reconcile exists for is preserved across restarts.
 *   - holder == own pid → already owned (registry rebuilt in-process), true.
 *   - no explicit release: pid liveness IS the release. Graceful exit and
 *     SIGKILL converge on the same "pid dead → next boot takes over" path,
 *     so there is no exit hook to forget or crash past.
 *
 * Race windows (analysed, accepted):
 *   1. Two servers, disjoint in time (the prod/dev incident): the owner's pid
 *      is on disk before its SessionManager constructor returns, and running
 *      any session requires that SessionManager — so by the time a second
 *      process can observe live sessions, the claim is always visible.
 *      Second process reads a live pid → skips. Window closed.
 *   2. Simultaneous first-touch, no existing file: O_EXCL admits exactly one
 *      creator; the loser reads the winner's live pid → skips.
 *   3. Simultaneous stale takeover (both read the same dead pid): both rename
 *      over the file and both return true → both run boot reconcile. Benign:
 *      both processes are first-touching, neither can have live sessions in
 *      this workspace yet, so the double reconcile acts on the same set of
 *      genuine crash orphans (same effect as today's unconditional reconcile).
 *      The rename-based takeover (instead of unlink + O_EXCL retry) keeps the
 *      file existent at all times, so a third comer always sees SOME holder.
 *   4. pid reuse: a stale pid recycled by an unrelated live process reads as
 *      "alive" → reconcile skipped until the next restart after that process
 *      exits. Deliberate bias: false-alive costs one missed cleanup round,
 *      false-dead could stop live sessions. (Same residual accepted by
 *      index.ts's server.lock pid-probe fallback.)
 *
 * Known residual (documented, out of scope): when two servers BOTH actively
 * use one workspace long-term, the non-owner never reconciles — its own crash
 * orphans stay un-cleaned until the owner restarts and takes over. Fixing
 * that needs per-session owner tracking (schema change), not a boot gate.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Marker file name under `<workspace>/.halo/`. */
export const RUNTIME_LOCK_FILE = 'runtime.lock'

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = the pid exists but belongs to another uid — that IS a live
    // process. Opposite bias from index.ts's isProcessAlive (where false-alive
    // only blocks a redundant server start): here false-DEAD is the dangerous
    // direction, so anything but a clean ESRCH counts as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Try to claim (or re-confirm) ownership of a workspace's runtime.
 * Returns true when THIS process owns it — freshly created, already held by
 * our own pid, or taken over from a dead holder. Returns false when another
 * live process holds the claim, or when ownership can't be established
 * (unwritable fs etc.) — callers must treat false as "do not reconcile".
 */
export function claimWorkspaceRuntime(workspaceRoot: string): boolean {
  const lockPath = path.join(workspaceRoot, '.halo', RUNTIME_LOCK_FILE)
  try {
    // Fast path: exclusive create — the common single-server boot.
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      // Can't create (permissions, missing .halo, …) → can't prove ownership.
      console.warn(`[WorkspaceRuntimeLock] cannot claim ${lockPath}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  // File exists — inspect the holder.
  let holder = 0
  try {
    holder = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10) || 0
  } catch { /* unreadable → treat as stale */ }

  if (holder === process.pid) return true
  if (holder > 0 && isPidAlive(holder)) return false

  // Stale (dead pid / garbage content) → take over. Write-tmp + rename is
  // atomic and never leaves the path missing (see race note 3 above).
  const tmpPath = `${lockPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmpPath, String(process.pid))
    fs.renameSync(tmpPath, lockPath)
    console.debug(`[WorkspaceRuntimeLock] took over stale runtime.lock in ${workspaceRoot} (previous holder pid ${holder || 'unreadable'})`)
    return true
  } catch (renameErr) {
    try { fs.unlinkSync(tmpPath) } catch { /* best-effort tmp cleanup */ }
    console.warn(`[WorkspaceRuntimeLock] stale takeover failed for ${lockPath}: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`)
    return false
  }
}

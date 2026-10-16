/**
 * Commit durability of the AgentCore workspace's dbs — halo.db, a2a.db and
 * runs.db under `<ws>/.halo`, on EFS (a2a/agentcore.ts).
 *
 * WAL mode defaults to `synchronous=NORMAL`: a commit writes its WAL frames
 * but doesn't fsync them. On NFS those frames sit in the client's page cache
 * until writeback or a checkpoint (SQLite's unlock is on -shm and flushes
 * nothing of -wal), so a microVM that dies — stop timeout, crash, the 8 h
 * maxLifetime — takes the last seconds of commits with its kernel: a run
 * ledger row (the killed run is never resumed), a created task (the caller's
 * taskId is unknown), a completed one (marked FAILED on the next boot). FULL
 * fsyncs the WAL at every commit that wrote something; a statement that
 * changes no row writes no frame and syncs nothing.
 *
 * Registered by agentcore.ts before it opens anything; never set in server
 * mode (local disk, one long-lived host — unchanged), and HOME-side dbs are
 * never in the registered dir. Per connection: every factory opening a db in
 * the dir applies it.
 */
import type Database from 'better-sqlite3'
import path from 'node:path'

let durableDir: string | null = null

/** The `.halo` dir whose dbs commit with fsync (null = none). */
export function setDurableDbDir(dir: string | null): void {
  durableDir = dir === null ? null : path.resolve(dir)
}

/** Call right after opening a connection in `dataDir`, before any write. */
export function applyCommitDurability(sqlite: Database.Database, dataDir: string): void {
  if (durableDir !== null && path.resolve(dataDir) === durableDir) sqlite.pragma('synchronous = FULL')
}

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import path from 'node:path'
import fs from 'node:fs'

export const channelAccounts = sqliteTable('channel_accounts', {
  accountId: text('account_id').primaryKey(),
  channelType: text('channel_type').notNull(),
  workspacePath: text('workspace_path').notNull(),
  label: text('label').notNull().default(''),
  enabled: integer('enabled').notNull().default(1),
  accessLevel: text('access_level').notNull().default('readonly'),
  language: text('language').notNull().default('en'),
  config: text('config').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS channel_accounts (
  account_id      TEXT PRIMARY KEY,
  channel_type    TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  access_level    TEXT NOT NULL DEFAULT 'readonly',
  language        TEXT NOT NULL DEFAULT 'en',
  config          TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_accounts_type ON channel_accounts(channel_type);
`

export function createChannelDb(secretsDir: string) {
  const channelsDir = path.join(secretsDir, 'channels')
  fs.mkdirSync(channelsDir, { recursive: true })
  const dbPath = path.join(channelsDir, 'channels.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(CREATE_SQL)
  return drizzle(sqlite, { schema: { channelAccounts } })
}

export type ChannelDb = ReturnType<typeof createChannelDb>

/** Singleton accessor for code paths that need the channel db without the
 *  caller having to thread it through (cron dispatcher, scheduled tasks, etc.).
 *  Set once during server boot via `setChannelDb(...)`. */
let _channelDb: ChannelDb | null = null
export function setChannelDb(db: ChannelDb): void { _channelDb = db }
export function getChannelDb(): ChannelDb {
  if (!_channelDb) throw new Error('[channel-db] getChannelDb() called before setChannelDb()')
  return _channelDb
}

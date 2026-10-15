import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  agentId: text('agent_id').notNull(),
  agentName: text('agent_name').notNull().default(''),
  description: text('description').notNull().default(''),
  workingDir: text('working_dir'),
  accessLevel: text('access_level'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  stoppedAt: integer('stopped_at'),
  archivedAt: integer('archived_at'),
  // Goal mode (see docs/plans/loop-mode.md): on G's row, `goal` holds the
  // binding JSON ({workerSessionId, round, caps, ...}); on W's row,
  // `goalSessionId` back-points to G so the delivery point routes without scanning.
  goal: text('goal'),
  goalSessionId: text('goal_session_id'),
  // Relay (see agents/relay.ts): on a dispatched session's row, JSON
  // `{ workspace, sessionId }` of the caller to report back to when the
  // subtree goes quiet. Cleared after delivery (one dispatch → one report).
  replyTo: text('reply_to'),
  // List-visible metadata, maintained on every UI-log write (see
  // SessionManager.persistUILog) — the row is their only home, session
  // files carry no header. `null` = row predates the columns; the list route
  // backfills it from the 1.x `.json` on first read.
  title: text('title'),
  exchangeCount: integer('exchange_count'),
  contextTokens: integer('context_tokens'),
  totalOutputTokens: integer('total_output_tokens'),
  // Latest turn output + last activity (ISO), written with the raw history by
  // SessionStateStore — session files hold no metadata (design/storage.md).
  output: text('output'),
  lastActivityAt: text('last_activity_at'),
})

export const disabledItems = sqliteTable('disabled_items', {
  itemType: text('item_type').notNull(),
  itemId: text('item_id').notNull(),
  scope: text('scope').notNull(),
  disabledAt: integer('disabled_at').notNull(),
})

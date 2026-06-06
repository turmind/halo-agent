import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default(''),
  messages: text('messages').notNull(),
  messageCount: integer('message_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

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
})

export const disabledItems = sqliteTable('disabled_items', {
  itemType: text('item_type').notNull(),
  itemId: text('item_id').notNull(),
  scope: text('scope').notNull(),
  disabledAt: integer('disabled_at').notNull(),
})

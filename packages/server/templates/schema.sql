CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  working_dir TEXT,
  access_level TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stopped_at INTEGER,
  archived_at INTEGER,
  goal TEXT,
  goal_session_id TEXT,
  reply_to TEXT,
  -- List-visible metadata mirrored from the session file's header on every
  -- write, so the listing path never opens (multi-MB) session files.
  -- NULL = written before these columns existed; the list route backfills.
  title TEXT,
  exchange_count INTEGER,
  context_tokens INTEGER,
  total_output_tokens INTEGER
);

CREATE TABLE IF NOT EXISTS disabled_items (
  item_type TEXT NOT NULL CHECK(item_type IN ('agent', 'skill')),
  item_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('global', 'workspace')),
  disabled_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id, scope)
);

-- Acta schema (design-spec §1). SQLite dialect, D1-portable.
-- Every entity row carries workspace_id (multi-tenant readiness).

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actor (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  on_behalf_of TEXT REFERENCES actor(id),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, handle)
);

CREATE TABLE IF NOT EXISTS auth_token (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  kind TEXT NOT NULL CHECK (kind IN ('session', 'agent')),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'read,write',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS otp_challenge (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS board (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  next_seq INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS list (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  board_id TEXT NOT NULL REFERENCES board(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'none'
    CHECK (role IN ('backlog', 'active', 'blocked', 'review', 'done', 'inbox', 'none')),
  pos REAL NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_list_board ON list(board_id, pos);

CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  board_id TEXT NOT NULL REFERENCES board(id),
  list_id TEXT NOT NULL REFERENCES list(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pos REAL NOT NULL,
  due INTEGER,
  completed INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES actor(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  imported_meta TEXT,
  UNIQUE (workspace_id, key)
);
CREATE INDEX IF NOT EXISTS idx_item_list ON item(list_id, pos);
CREATE INDEX IF NOT EXISTS idx_item_board ON item(board_id, updated_at);

-- Old keys keep resolving after cross-board moves (design-spec §1).
CREATE TABLE IF NOT EXISTS item_key_alias (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  key TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES item(id),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS label_group (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  board_id TEXT REFERENCES board(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS label (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  group_id TEXT NOT NULL REFERENCES label_group(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'gray'
);

CREATE TABLE IF NOT EXISTS item_label (
  item_id TEXT NOT NULL REFERENCES item(id),
  label_id TEXT NOT NULL REFERENCES label(id),
  PRIMARY KEY (item_id, label_id)
);

CREATE TABLE IF NOT EXISTS item_assignee (
  item_id TEXT NOT NULL REFERENCES item(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  PRIMARY KEY (item_id, actor_id)
);

CREATE TABLE IF NOT EXISTS checklist (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  item_id TEXT NOT NULL REFERENCES item(id),
  name TEXT NOT NULL,
  pos REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_item (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES checklist(id),
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  pos REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS comment (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  item_id TEXT NOT NULL REFERENCES item(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  imported_meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_comment_item ON comment(item_id, created_at);

CREATE TABLE IF NOT EXISTS document (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT REFERENCES document(id),
  board_id TEXT REFERENCES board(id),
  pos REAL NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  layout TEXT NOT NULL DEFAULT 'default' CHECK (layout IN ('default', 'wide')),
  tags TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  imported_meta TEXT,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS doc_version (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES document(id),
  rev INTEGER NOT NULL,
  body TEXT NOT NULL,
  title TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actor(id),
  created_at INTEGER NOT NULL,
  UNIQUE (document_id, rev)
);

-- Typed references extracted from markdown on save (backlinks both ways).
CREATE TABLE IF NOT EXISTS link (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  src_kind TEXT NOT NULL CHECK (src_kind IN ('item', 'doc', 'comment')),
  src_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('item', 'board', 'doc', 'actor', 'query')),
  target TEXT NOT NULL,
  PRIMARY KEY (src_kind, src_id, ref_type, target)
);
CREATE INDEX IF NOT EXISTS idx_link_target ON link(workspace_id, ref_type, target);

CREATE TABLE IF NOT EXISTS attachment (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('item', 'doc')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'url')),
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  url TEXT,
  content_hash TEXT,
  actor_id TEXT NOT NULL REFERENCES actor(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhook(id),
  event TEXT NOT NULL,
  status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  condition TEXT,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_token (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  token_hash TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL REFERENCES actor(id),
  board_id TEXT NOT NULL REFERENCES board(id),
  list_id TEXT REFERENCES list(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  ts INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actor(id),
  actor_kind TEXT NOT NULL,
  on_behalf_of TEXT,
  verb TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT,
  caused_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_ws ON event(workspace_id, id);

-- Idempotency: op_id replay returns the recorded result (design-spec §1).
CREATE TABLE IF NOT EXISTS op_log (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  op_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, op_id)
);

-- Full-text search over items, comments, docs (mvp F7).
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind, ref, title, body, board_key, tokenize = 'unicode61'
);

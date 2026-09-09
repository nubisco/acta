// Canonical schema. Kept as a TS constant so both bundlers (bun, wrangler)
// and both drivers (bun:sqlite, D1) consume one source.
export const SCHEMA_SQL = `
-- Acta schema (design-spec §1). SQLite dialect, D1-portable.
-- Every entity row carries workspace_id (multi-tenant readiness).

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The URL segment this workspace is addressed by, the way an org is on
  -- GitHub. Nullable so the ALTER below can add it to databases that predate
  -- it, and bootstrap backfills those from the name.
  slug TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actor (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
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

-- Comments on documents. A separate table rather than a nullable rework of
-- comment: the migration model is additive CREATE IF NOT EXISTS only.
CREATE TABLE IF NOT EXISTS doc_comment (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  document_id TEXT NOT NULL REFERENCES document(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  imported_meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_comment_doc ON doc_comment(document_id, created_at);

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

-- Inbound provider webhooks. Unlike ingest_token, the URL is not the
-- credential: a provider signs each delivery and we verify the signature,
-- so the endpoint can be pasted into GitHub's UI without leaking anything.
CREATE TABLE IF NOT EXISTS connection (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actor(id),
  board_id TEXT NOT NULL REFERENCES board(id),
  list_id TEXT REFERENCES list(id),
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_event_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

-- What an item IS somewhere else, as opposed to imported_meta which records
-- where it CAME FROM. The primary key is the dedup: a provider redelivering
-- the same issue finds the existing card instead of creating a second one.
CREATE TABLE IF NOT EXISTS external_link (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES item(id),
  url TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_external_link_item ON external_link(item_id);

-- Starred boards, per person rather than per workspace: a favourite is an
-- opinion about your own attention, not a property of the board.
CREATE TABLE IF NOT EXISTS board_star (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  board_id TEXT NOT NULL REFERENCES board(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, board_id)
);

-- Full-text search over items, comments, docs (mvp F7).
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind, ref, title, body, board_key, tokenize = 'unicode61'
);
`

/**
 * Columns added after a table already shipped. CREATE IF NOT EXISTS is a
 * no-op on existing databases, so these run separately on every migrate;
 * the drivers swallow the "duplicate column" error that means the column
 * is already there. Append only, never edit or reorder.
 */
export const ADDITIVE_COLUMNS = [
  'ALTER TABLE actor ADD COLUMN avatar_url TEXT',
  // The URL segment a workspace is addressed by, the way an org is on GitHub.
  // Nullable because it is added to an existing table; bootstrap backfills the
  // rows that predate it, and the unique index keeps two from colliding.
  'ALTER TABLE workspace ADD COLUMN slug TEXT',
  // After the column exists, never inside SCHEMA_SQL: on a fresh database the
  // table is created before the ALTER runs, so an index declared up there
  // would name a column that is not there yet.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_slug ON workspace(slug)',
  // How a destination wants the payload shaped. Slack rejects our own
  // envelope, so the format lives on the webhook rather than forcing a
  // second delivery pipeline with its own retries and failure handling.
  "ALTER TABLE webhook ADD COLUMN format TEXT NOT NULL DEFAULT 'generic'",
]

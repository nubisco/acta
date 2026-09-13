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
  -- Where the avatar came from, so a personal upload survives the next SSO
  -- sign-in. See ADDITIVE_COLUMNS for existing databases.
  avatar_source TEXT NOT NULL DEFAULT 'sso',
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

CREATE TABLE IF NOT EXISTS space (
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
  space_id TEXT NOT NULL REFERENCES space(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'none'
    CHECK (role IN ('backlog', 'active', 'blocked', 'review', 'done', 'inbox', 'none')),
  pos REAL NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_list_space ON list(space_id, pos);

CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  space_id TEXT NOT NULL REFERENCES space(id),
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
  -- Unitless estimate. Null means unsized.
  size REAL,
  -- A checkpoint rather than a piece of work: "we can ship" rather than
  -- something somebody does.
  is_milestone INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, key)
);
CREATE INDEX IF NOT EXISTS idx_item_list ON item(list_id, pos);
CREATE INDEX IF NOT EXISTS idx_item_space ON item(space_id, updated_at);

-- Old keys keep resolving after cross-space moves (design-spec §1).
CREATE TABLE IF NOT EXISTS item_key_alias (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  key TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES item(id),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS label_group (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  space_id TEXT REFERENCES space(id),
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
  space_id TEXT REFERENCES space(id),
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
  ref_type TEXT NOT NULL CHECK (ref_type IN ('item', 'space', 'doc', 'actor', 'query')),
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
  space_id TEXT NOT NULL REFERENCES space(id),
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
  space_id TEXT NOT NULL REFERENCES space(id),
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

-- Starred spaces, per person rather than per workspace: a favourite is an
-- opinion about your own attention, not a property of the space.
CREATE TABLE IF NOT EXISTS space_star (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  space_id TEXT NOT NULL REFERENCES space(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, space_id)
);

-- "This before that."
--
-- A relation of its own rather than a link ref: [[ST-4]] in a description
-- means "see also", and a plan cannot be built from prose that might be a
-- dependency. Direction is explicit, blocker first.
--
-- The pair is the key, so asserting the same edge twice is the same edge.
-- A cycle is refused at write time: a plan that contains one has no order,
-- and the moment to say so is when it is drawn, not when it is read.
CREATE TABLE IF NOT EXISTS item_dependency (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  -- The card that must be done first.
  blocker_id TEXT NOT NULL REFERENCES item(id),
  -- The card that waits for it.
  blocked_id TEXT NOT NULL REFERENCES item(id),
  created_by TEXT NOT NULL REFERENCES actor(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_dependency_blocked
  ON item_dependency(blocked_id);

-- How big a card is thought to be, for ordering and for saying how far away
-- something is. Unitless on purpose: teams that estimate in days and teams
-- that estimate in points both want the same arithmetic.
-- See ADDITIVE_COLUMNS for databases that predate it.

-- Who needs telling, and whether they have seen it.
--
-- A row per (event, recipient) rather than a flag on the event: the same
-- comment is news to three people and already-read by a fourth, and that is
-- state about a person, not about the event.
--
-- Derived at write time rather than queried at read time, because "did this
-- concern me" depends on who was assigned and who had commented AT THAT
-- MOMENT, which a later query cannot reconstruct.
CREATE TABLE IF NOT EXISTS notification (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  -- Who is being told.
  actor_id TEXT NOT NULL REFERENCES actor(id),
  event_id TEXT NOT NULL REFERENCES event(id),
  -- Why they are being told: 'mention', 'assigned', 'involved'.
  reason TEXT NOT NULL CHECK (reason IN ('mention', 'assigned', 'involved')),
  verb TEXT NOT NULL,
  summary TEXT NOT NULL,
  -- The card or document to open. Null for workspace-level news.
  item_key TEXT,
  doc_slug TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  UNIQUE (actor_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_inbox
  ON notification(actor_id, read_at, created_at DESC);

-- Full-text search over items, comments, docs (mvp F7).
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind, ref, title, body, space_key, tokenize = 'unicode61'
);
`

/**
 * One-way renames applied before the schema is created, for databases that
 * predate a name change.
 *
 * These run FIRST and exactly once each. CREATE TABLE IF NOT EXISTS cannot do
 * this job: on a database that still has `space`, it would happily create an
 * empty `space` beside it and every read would come back empty against a
 * table holding a thousand rows.
 *
 * Each statement is idempotent by failure: once applied, re-running raises
 * "no such table" or "no such column", which the drivers treat as "already
 * done". That is the same bargain ADDITIVE_COLUMNS makes with "duplicate
 * column", and it is why the list is append-only and order matters. The table
 * rename comes before the column renames that reference it.
 *
 * Renaming the table also rewrites the REFERENCES clauses pointing at it, so
 * the foreign keys follow without being restated.
 */
export const RENAMES = [
  // board -> space. The container is the space; Board, Table, Calendar and
  // Timeline are views OF it, so the old name called the container after one
  // of its own views.
  //
  // These deliberately name the OLD identifiers. A blanket rename across the
  // codebase turned them into no-ops once already (ALTER TABLE space RENAME
  // TO space), which migrated nothing and reported success.
  'ALTER TABLE board RENAME TO space',
  'ALTER TABLE board_star RENAME TO space_star',
  'ALTER TABLE list RENAME COLUMN board_id TO space_id',
  'ALTER TABLE item RENAME COLUMN board_id TO space_id',
  'ALTER TABLE label_group RENAME COLUMN board_id TO space_id',
  'ALTER TABLE document RENAME COLUMN board_id TO space_id',
  'ALTER TABLE ingest_token RENAME COLUMN board_id TO space_id',
  'ALTER TABLE connection RENAME COLUMN board_id TO space_id',
  'ALTER TABLE space_star RENAME COLUMN board_id TO space_id',
  // Values, not just identifiers. A rename that moves the columns and leaves
  // the rows saying "board" produces an activity feed and a set of links that
  // quietly stop matching anything the code now asks for.
  "UPDATE event SET entity = 'space' WHERE entity = 'board'",
  "UPDATE event SET verb = 'space' || substr(verb, 6) WHERE verb LIKE 'board.%'",
  // Only the leading noun of a summary the server itself wrote ("created
  // board ST (Stagewright)"). A blanket replace would reach into names and
  // titles that legitimately contain the word.
  "UPDATE event SET summary = 'created space' || substr(summary, 14) WHERE summary LIKE 'created board %'",
  "UPDATE event SET summary = 'archived space' || substr(summary, 15) WHERE summary LIKE 'archived board %'",
  // Markdown references written as [[board:KEY]] resolve on the prefix, so
  // they stop resolving the moment the prefix changes.
  "UPDATE document SET body = replace(body, '[[board:', '[[space:') WHERE body LIKE '%[[board:%'",
  "UPDATE item SET description = replace(description, '[[board:', '[[space:') WHERE description LIKE '%[[board:%'",
  "UPDATE comment SET body = replace(body, '[[board:', '[[space:') WHERE body LIKE '%[[board:%'",
  "UPDATE doc_comment SET body = replace(body, '[[board:', '[[space:') WHERE body LIKE '%[[board:%'",
]

/**
 * Rebuilds that cannot be expressed as a rename.
 *
 * FTS5 has no RENAME COLUMN, so a column rename means dropping the index and
 * reindexing from the rows it covers. Guarded on the old column still being
 * there, since dropping and rebuilding a search index on every boot would be
 * an expensive way to change nothing.
 */
/**
 * The link table is REBUILT, not updated.
 *
 * Its CHECK constraint lists the permitted ref_types and still says 'board',
 * so an UPDATE to 'space' is refused by the table itself, and SQLite cannot
 * alter a CHECK in place. Guarded on the old constraint still being there,
 * because dropping and recreating a table on every boot would leave a window,
 * however brief, where a request could find no link table at all.
 */
export const LINK_REBUILD = {
  /** Truthy while the table still permits 'board' rather than 'space'. */
  detect: `SELECT 1 AS needed FROM sqlite_master
             WHERE type = 'table' AND name = 'link' AND sql LIKE '%''board''%'`,
  steps: [
    `CREATE TABLE link_rebuild (
       workspace_id TEXT NOT NULL REFERENCES workspace(id),
       src_kind TEXT NOT NULL CHECK (src_kind IN ('item', 'doc', 'comment')),
       src_id TEXT NOT NULL,
       ref_type TEXT NOT NULL CHECK (ref_type IN ('item', 'space', 'doc', 'actor', 'query')),
       target TEXT NOT NULL,
       PRIMARY KEY (src_kind, src_id, ref_type, target)
     )`,
    `INSERT OR IGNORE INTO link_rebuild (workspace_id, src_kind, src_id, ref_type, target)
       SELECT workspace_id, src_kind, src_id,
              CASE ref_type WHEN 'board' THEN 'space' ELSE ref_type END,
              target
         FROM link`,
    'DROP TABLE link',
    'ALTER TABLE link_rebuild RENAME TO link',
  ],
}

export const FTS_COLUMN_RENAME = {
  detect: 'SELECT space_key FROM fts LIMIT 1',
  drop: 'DROP TABLE IF EXISTS fts',
  create: `CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind, ref, title, body, space_key, tokenize = 'unicode61'
)`,
}

/** Repopulates a freshly rebuilt FTS index from the rows it covers. */
export const REINDEX_FTS = [
  `INSERT INTO fts (kind, ref, title, body, space_key)
     SELECT 'item', i.key, i.title, i.description, s.key
       FROM item i JOIN space s ON s.id = i.space_id`,
  `INSERT INTO fts (kind, ref, title, body, space_key)
     SELECT 'doc', d.slug, d.title, d.body, '' FROM document d`,
  `INSERT INTO fts (kind, ref, title, body, space_key)
     SELECT 'comment', c.id, '', c.body, s.key
       FROM comment c JOIN item i ON i.id = c.item_id
       JOIN space s ON s.id = i.space_id`,
]

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
  // Where the current avatar came from. An identity provider seeds one so a
  // new member arrives with a face, but a person who uploads their own has
  // made a choice, and the next sign-in must not quietly undo it.
  "ALTER TABLE actor ADD COLUMN avatar_source TEXT NOT NULL DEFAULT 'sso'",
  // When this person finished the welcome. Null means they have not, which is
  // what the app asks before showing it. On the actor rather than in the
  // browser: it is a fact about a person, and greeting someone again because
  // they opened a second browser is how a welcome becomes an annoyance.
  'ALTER TABLE actor ADD COLUMN onboarded_at INTEGER',
  // Size, for sequencing. Null means unsized, which the plan treats as 1 so
  // an unestimated card still takes a position rather than collapsing.
  'ALTER TABLE item ADD COLUMN size REAL',
  // A card can stand for a checkpoint rather than a piece of work.
  'ALTER TABLE item ADD COLUMN is_milestone INTEGER NOT NULL DEFAULT 0',
  // After the column exists, never inside SCHEMA_SQL: on a fresh database the
  // table is created before the ALTER runs, so an index declared up there
  // would name a column that is not there yet.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_slug ON workspace(slug)',
  // How a destination wants the payload shaped. Slack rejects our own
  // envelope, so the format lives on the webhook rather than forcing a
  // second delivery pipeline with its own retries and failure handling.
  "ALTER TABLE webhook ADD COLUMN format TEXT NOT NULL DEFAULT 'generic'",
]

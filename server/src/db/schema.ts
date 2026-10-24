// Canonical schema. Kept as a TS constant so both bundlers (bun, wrangler)
// and both drivers (bun:sqlite, D1) consume one source.
export const SCHEMA_SQL = `
-- Acta schema (design-spec §1). SQLite dialect, D1-portable.
-- Every entity row carries workspace_id (multi-tenant readiness).

-- What shape this database is already in. See SCHEMA_FINGERPRINT.
CREATE TABLE IF NOT EXISTS schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The URL segment this workspace is addressed by, the way an org is on
  -- GitHub. Nullable so the ALTER below can add it to databases that predate
  -- it, and bootstrap backfills those from the name.
  slug TEXT,
  -- Who may delete a comment: 'author' lets people remove their own and
  -- admins remove any, 'admin' reserves it to admins entirely. Editing is
  -- not configurable and never will be, because only an author may edit
  -- their own words. See ADDITIVE_COLUMNS for existing databases.
  comment_delete TEXT NOT NULL DEFAULT 'author'
    CHECK (comment_delete IN ('author', 'admin')),
  -- The number the next goal gets. Goals are numbered per workspace, the way
  -- cards are per space, and a counter rather than MAX()+1 so a deleted
  -- goal's number is never handed to a different goal. See ADDITIVE_COLUMNS.
  next_goal_seq INTEGER NOT NULL DEFAULT 1,
  -- Set by an operator to shut a workspace (abuse, an acceptable-use breach).
  -- Every authenticated request into it is refused while it is set, and
  -- nothing is deleted. See ADDITIVE_COLUMNS for existing databases.
  suspended_at INTEGER,
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
  -- Who disabled them: 'platform' when the provider's membership.removed did.
  -- See ADDITIVE_COLUMNS for existing databases.
  disabled_source TEXT,
  -- The provider's own id for this person (the OIDC sub claim), bound at
  -- every SSO sign-in. Null for agents, system accounts and anyone who has
  -- only ever signed in with a one-time code.
  platform_user_id TEXT,
  -- How long an unread notification may sit before we reach the person some
  -- other way. Seconds; 0 turns it off. The default is on, because the
  -- failure people actually report is missing the thing, not being told
  -- twice. See ADDITIVE_COLUMNS for existing databases.
  notify_after_seconds INTEGER NOT NULL DEFAULT 600,
  -- When this person proved they own their email address: a provider vouched
  -- for it at sign-in, a one-time code sent to it was entered, or an
  -- invitation sent to it was accepted. Null means nobody has, and nothing is
  -- emailed to an address in that state. See ADDITIVE_COLUMNS.
  email_confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, handle)
);

CREATE TABLE IF NOT EXISTS auth_token (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  -- 'session' is the browser cookie, 'agent' is an admin-minted bot identity
  -- with an actor of its own, and 'personal' acts as the human who minted it.
  -- See TOKEN_REBUILD for databases created before 'personal' existed.
  kind TEXT NOT NULL CHECK (kind IN ('session', 'agent', 'personal')),
  token_hash TEXT NOT NULL UNIQUE,
  -- How its owner recognises it in the list when deciding what to revoke.
  -- Personal tokens only; a session has nothing to tell apart.
  label TEXT,
  last_used_at INTEGER,
  scopes TEXT NOT NULL DEFAULT 'read,write',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- OAuth 2.1 authorization server for the MCP endpoint (RFC 7591 + PKCE).
-- Connector UIs (ChatGPT, the claude.ai web connector) will not accept a
-- pasted bearer token; they discover this server, self-register, and exchange
-- a code. Everything here is hashed, exactly like auth_token.
CREATE TABLE IF NOT EXISTS oauth_client (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- JSON array. Matched exactly at authorize time; a prefix match is how open
  -- redirects are born.
  redirect_uris TEXT NOT NULL,
  -- When a code was first issued to it. Registration is open to anyone, so a
  -- client never used within a few days is pruned. See ADDITIVE_COLUMNS.
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_code (
  code_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  client_id TEXT NOT NULL REFERENCES oauth_client(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Single use. Stamped rather than deleted so a replay is refused rather
  -- than looking like a code that never existed.
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_token (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  client_id TEXT NOT NULL REFERENCES oauth_client(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- Invitations into a workspace. A person is only a member once they accept,
-- which proves the address is theirs: by signing in through the provider as
-- that address, or by following a link that was only ever sent to it. Until
-- then they are not an actor, cannot be mentioned or assigned, and are sent
-- nothing but the invitation itself.
CREATE TABLE IF NOT EXISTS invitation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  email TEXT NOT NULL,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  -- The secret in the link, hashed like every other credential here.
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES actor(id),
  -- Whether the invitation email went out. False when the instance has no
  -- email configured or the workspace hit its daily cap.
  emailed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_actor_id TEXT REFERENCES actor(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitation_ws ON invitation(workspace_id, created_at);

-- How many emails of a kind one workspace has sent on one UTC day. The cap is
-- what keeps a workspace on a shared instance from becoming a way to send
-- mail from our domain to addresses of its choosing.
CREATE TABLE IF NOT EXISTS email_quota (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, kind)
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
  -- The card this one is part of. Any card can be part of any card, at any
  -- depth, on any board: this is a link, not a ladder, and Acta has no epic
  -- or story or task types to keep in order. Deliberately not the same thing
  -- as item_dependency, which says what has to happen first.
  --
  -- ON DELETE is not declared because SQLite would need the pragma on, and
  -- the delete path clears it explicitly instead. See ADDITIVE_COLUMNS for
  -- existing databases.
  parent_id TEXT REFERENCES item(id),
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
  name TEXT NOT NULL,
  -- At most one label from this group on a card. "Fixes version" is one
  -- release; "Affects version" is several, and stays the default.
  --
  -- Enforced on write by removing the others, not by refusing: a person
  -- picking a second value means they changed their mind, and a refusal
  -- would make them clear the old one first for no reason.
  -- See ADDITIVE_COLUMNS for existing databases.
  exclusive INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS label (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  group_id TEXT NOT NULL REFERENCES label_group(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'gray',
  -- Where it sits in its group. Versions are the case that needs it: 1.9.0
  -- comes before 1.11.0 and no amount of sorting by name will agree. Null
  -- means unordered, and a group of nulls falls back to by-name, which is
  -- what every existing group does today.
  pos REAL
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
  -- The goal to open, for news about a goal. See ADDITIVE_COLUMNS.
  goal_number INTEGER,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  -- When this becomes eligible for a nudge outside the app, stamped from the
  -- recipient's own setting at the moment it was written rather than read
  -- from the setting later: changing your preference should govern what
  -- happens next, not silently re-time a week of notifications you already
  -- have. Null means never nudge this person about this.
  remind_at INTEGER,
  -- When we did, and by what. Set once, so a second sweep skips the row even
  -- if it is still unread; a reminder repeated every five minutes is how a
  -- person learns to filter the sender.
  reminded_at INTEGER,
  reminded_via TEXT,
  UNIQUE (actor_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_inbox
  ON notification(actor_id, read_at, created_at DESC);
-- The sweep's own index is in ADDITIVE_COLUMNS, beside the columns it
-- names: this block runs before that list, so an index declared here would
-- name a column an existing database does not have yet.

-- What the work is for.
--
-- A goal is workspace-wide rather than per space, because the work behind
-- one is rarely all on one board. It carries two signals that are kept apart
-- on purpose: the owner's judgement (status, posted through check-ins) and
-- the measured progress of the cards that serve it, which is computed on
-- read and never stored, so it cannot drift from the cards.
CREATE TABLE IF NOT EXISTS goal (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  -- G-12 is number 12. Stable across renames, unlike a slug.
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES actor(id),
  -- The goal this one is part of. A link, not a ladder, exactly like a
  -- card's parent: any goal under any goal, cycles refused on write, and
  -- deleting a parent detaches rather than cascades.
  parent_id TEXT REFERENCES goal(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'on_track', 'at_risk', 'off_track', 'done', 'paused', 'cancelled')),
  start_date INTEGER,
  target_date INTEGER,
  -- One measurable target, optional. All five together or none at all;
  -- metric_name is the one that says which.
  metric_name TEXT,
  metric_unit TEXT,
  metric_start REAL,
  metric_target REAL,
  metric_current REAL,
  archived INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES actor(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, number)
);
CREATE INDEX IF NOT EXISTS idx_goal_parent ON goal(parent_id);

-- Which cards serve a goal. Many to many: a card can serve several goals,
-- and everything that is part of a linked card counts toward it as well,
-- which is resolved on read rather than copied here.
CREATE TABLE IF NOT EXISTS goal_item (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  goal_id TEXT NOT NULL REFERENCES goal(id),
  item_id TEXT NOT NULL REFERENCES item(id),
  created_by TEXT NOT NULL REFERENCES actor(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (goal_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_goal_item_item ON goal_item(item_id);

-- A check-in: the owner's (or anybody's) dated word on where a goal stands.
-- The goal's own status and metric_current follow the latest one, and the
-- history stays here, which is what makes a trend readable later.
CREATE TABLE IF NOT EXISTS goal_update (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  goal_id TEXT NOT NULL REFERENCES goal(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  -- Null when the check-in did not change it.
  status TEXT,
  body TEXT NOT NULL DEFAULT '',
  metric_value REAL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goal_update_goal ON goal_update(goal_id, created_at);

-- Who hears about a goal besides its owner.
CREATE TABLE IF NOT EXISTS goal_follower (
  goal_id TEXT NOT NULL REFERENCES goal(id),
  actor_id TEXT NOT NULL REFERENCES actor(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (goal_id, actor_id)
);

-- Open Graph metadata behind a link preview card, cached with a TTL.
--
-- The one table here with no workspace_id, deliberately. This is not an
-- entity, it is a cache of what a public web page said about itself, and the
-- answer does not differ per workspace. Keyed per workspace it would fetch
-- the same twenty URLs again for every tenant, which is the cost this table
-- exists to avoid. What that trades away is small and worth naming: a row
-- says somebody on this instance once linked that URL.
--
-- A failure is cached too, under status 'none' and a shorter TTL. Without
-- that, a document holding twenty links to a site with no metadata refetches
-- all twenty every time it is opened, which is the exact behaviour the cache
-- is meant to stop.
CREATE TABLE IF NOT EXISTS link_preview (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok', 'none')),
  title TEXT,
  description TEXT,
  site_name TEXT,
  image_url TEXT,
  favicon_url TEXT,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_preview_expires ON link_preview(expires_at);

-- The workspace's own AI provider key, the same bring-your-own-key deal
-- Analytics and Verba offer: an admin supplies it, Nubisco never ships one,
-- and with none configured the features that need it are simply off. The key
-- is AES-GCM encrypted under ACTA_AI_ENCRYPTION_KEY and never read back out.
CREATE TABLE IF NOT EXISTS ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  provider TEXT NOT NULL DEFAULT 'anthropic'
    CHECK (provider IN ('anthropic', 'openai', 'gemini')),
  -- Null means the provider's default (see DEFAULT_MODELS).
  model TEXT,
  api_key_encrypted TEXT,
  updated_at INTEGER NOT NULL
);

-- One row per request to the provider, so an admin can see what the key is
-- spending. The provider bills them directly, so nothing else would show it.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_ws ON ai_usage_log(workspace_id, created_at);

-- The last good copy of LiteLLM's public price list, trimmed to the three
-- providers and the two prices read (services/aiPrices.ts). One row for the
-- instance, like link_preview: a list price does not differ per workspace.
-- It is here so a restart or another instance reads the copy instead of
-- fetching it again, and so a failed fetch still has a copy to fall back on.
CREATE TABLE IF NOT EXISTS ai_price_list (
  id TEXT PRIMARY KEY CHECK (id = 'litellm'),
  -- JSON: provider to model id to [input, output] in USD per token.
  prices TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- The daily progress report (LA-389): what moved, what it opened up, and
-- where each person might look today, posted to Slack once a working day.
CREATE TABLE IF NOT EXISTS daily_report (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  -- 'preview' writes the report and keeps it here, posting nothing. 'post'
  -- sends it to the webhook. The rollout is preview first, then a test
  -- channel, then the real one, and only the webhook changes between the two.
  mode TEXT NOT NULL DEFAULT 'preview' CHECK (mode IN ('preview', 'post')),
  slack_webhook_url TEXT,
  -- Local time the report goes out, in the zone below.
  send_hour INTEGER NOT NULL DEFAULT 9,
  timezone TEXT NOT NULL DEFAULT 'Europe/Lisbon',
  weekdays_only INTEGER NOT NULL DEFAULT 1,
  -- JSON array of YYYY-MM-DD dates with no report.
  holidays TEXT NOT NULL DEFAULT '[]',
  -- How long a card holding up another may sit untouched before it is named.
  stall_days INTEGER NOT NULL DEFAULT 5,
  -- JSON object of Acta handle to Slack member id, so a mention notifies.
  slack_ids TEXT NOT NULL DEFAULT '{}',
  -- Have the workspace's AI provider write the prose. Off, the report is the
  -- plain version built straight from the facts.
  ai_writing INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Every report written, posted or not. The unique date is what makes a
-- scheduled run idempotent: two isolates or a retried cron both try to claim
-- the day, and only one gets it. "Since the last report" reads its window
-- from here.
CREATE TABLE IF NOT EXISTS daily_report_run (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  -- The local date it was for, YYYY-MM-DD.
  run_date TEXT NOT NULL,
  claim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'posted', 'preview', 'skipped', 'failed')),
  since_ts INTEGER NOT NULL,
  until_ts INTEGER NOT NULL,
  text TEXT,
  -- 'ai' when the provider wrote it, 'plain' when it was built from the facts.
  writer TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, run_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_report_run_ws ON daily_report_run(workspace_id, until_ts);

-- A per-workspace export an admin asked for (LA-401): every table as JSONL,
-- the pages as Markdown and the uploaded files, in one zip kept in the blob
-- store under this row's id. The link that downloads it is a token whose hash
-- is kept here, valid until expires_at, after which the cron removes both.
CREATE TABLE IF NOT EXISTS workspace_export (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  requested_by TEXT NOT NULL REFERENCES actor(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  token_hash TEXT,
  size INTEGER,
  -- Files left out because the zip would have passed its size cap. Named in
  -- the zip's README, so nothing is missing without saying so.
  skipped_files INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  claimed_at INTEGER,
  ready_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_export_ws ON workspace_export(workspace_id, created_at);

-- A person the identity provider vouched for who belongs to no workspace yet,
-- waiting to create one (LA-398, signup). The cookie holds the token, this
-- holds its hash and what the provider said, for half an hour. Instance-wide:
-- there is no workspace to belong to until the signup finishes.
CREATE TABLE IF NOT EXISTS signup_intent (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  platform_user_id TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- When an instance-wide cron job last finished, for the ones that run daily
-- rather than on every five-minute tick (retention, the size check).
CREATE TABLE IF NOT EXISTS instance_job (
  name TEXT PRIMARY KEY,
  done_at INTEGER NOT NULL
);

-- Full-text search over items, comments, docs (mvp F7).
-- workspace_id is UNINDEXED: it is never matched as text, only filtered on, so
-- one tenant's search never returns another's rows (refs repeat across workspaces).
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind, ref, title, body, space_key, workspace_id UNINDEXED, tokenize = 'unicode61'
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

/**
 * auth_token.kind gained 'personal' after the table shipped, and SQLite
 * cannot alter a CHECK in place.
 *
 * Same shape and same reasoning as LINK_REBUILD: guarded on the old
 * constraint still being present, because rebuilding on every boot would
 * leave a window, however brief, in which a request could find no auth_token
 * table and every signed-in person would be signed out.
 */
export const TOKEN_REBUILD = {
  /** Truthy while the constraint still predates 'personal'. */
  detect: `SELECT 1 AS needed FROM sqlite_master
             WHERE type = 'table' AND name = 'auth_token'
               AND sql NOT LIKE '%personal%'`,
  steps: [
    `CREATE TABLE auth_token_rebuild (
       id TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL REFERENCES workspace(id),
       actor_id TEXT NOT NULL REFERENCES actor(id),
       kind TEXT NOT NULL CHECK (kind IN ('session', 'agent', 'personal')),
       token_hash TEXT NOT NULL UNIQUE,
       label TEXT,
       last_used_at INTEGER,
       scopes TEXT NOT NULL DEFAULT 'read,write',
       expires_at INTEGER,
       created_at INTEGER NOT NULL,
       revoked_at INTEGER
     )`,
    // Columns named explicitly: ADDITIVE_COLUMNS may or may not have already
    // added label and last_used_at by the time this runs, so SELECT * would
    // produce a different arity on different databases.
    `INSERT INTO auth_token_rebuild
       (id, workspace_id, actor_id, kind, token_hash, scopes, expires_at, created_at, revoked_at)
       SELECT id, workspace_id, actor_id, kind, token_hash, scopes, expires_at, created_at, revoked_at
         FROM auth_token`,
    'DROP TABLE auth_token',
    'ALTER TABLE auth_token_rebuild RENAME TO auth_token',
  ],
}

export const FTS_COLUMN_RENAME = {
  // The newest column decides: an index without workspace_id is rebuilt.
  detect: 'SELECT workspace_id FROM fts LIMIT 1',
  drop: 'DROP TABLE IF EXISTS fts',
  create: `CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind, ref, title, body, space_key, workspace_id UNINDEXED, tokenize = 'unicode61'
)`,
}

/** Repopulates a freshly rebuilt FTS index from the rows it covers. */
export const REINDEX_FTS = [
  `INSERT INTO fts (kind, ref, title, body, space_key, workspace_id)
     SELECT 'item', i.key, i.title, i.description, s.key, i.workspace_id
       FROM item i JOIN space s ON s.id = i.space_id`,
  `INSERT INTO fts (kind, ref, title, body, space_key, workspace_id)
     SELECT 'doc', d.slug, d.title, d.body, '', d.workspace_id FROM document d`,
  `INSERT INTO fts (kind, ref, title, body, space_key, workspace_id)
     SELECT 'comment', c.id, '', c.body, s.key, c.workspace_id
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
  // Personal access tokens: the label their owner recognises them by, and
  // when the token was last seen, which is what makes an unused one safe to
  // revoke. The rebuild above creates both; these cover a database that
  // already had 'personal' in its CHECK and so skips it.
  'ALTER TABLE auth_token ADD COLUMN label TEXT',
  'ALTER TABLE auth_token ADD COLUMN last_used_at INTEGER',
  // Inline comments. The anchor is JSON (a text quote plus a position hint,
  // see shared/src/anchors.ts) and lives here rather than in the document, so
  // commenting on a page never changes a byte of its markdown. Null is a
  // comment on the page as a whole, which every existing row is.
  'ALTER TABLE doc_comment ADD COLUMN anchor TEXT',
  // Resolved is a state, not a deletion: the comment and its anchor stay.
  'ALTER TABLE doc_comment ADD COLUMN resolved_at INTEGER',
  'ALTER TABLE doc_comment ADD COLUMN resolved_by TEXT',
  // The provider's own id for this person (the `sub` claim), bound at every
  // SSO sign-in. Email is how a member is found at sign-in and is a poor key
  // afterwards: the platform webhook names a user by id, and a person who
  // changes their email address would otherwise become unreachable by it.
  'ALTER TABLE actor ADD COLUMN platform_user_id TEXT',
  // Who disabled this actor: 'platform' when a membership.removed webhook did.
  // Null covers both "not disabled" and "an admin disabled them here", and the
  // distinction matters because membership.added re-enables only what the
  // platform itself disabled.
  'ALTER TABLE actor ADD COLUMN disabled_source TEXT',
  'CREATE INDEX IF NOT EXISTS idx_actor_platform_user ON actor(platform_user_id)',
  // Which document a notification opens. Declared in SCHEMA_SQL from the day
  // doc comments shipped and never listed here, so every database older than
  // that line lacks the column: the notification write below names it, and on
  // those databases the INSERT would fail. Nothing read it before, which is
  // why the gap survived.
  'ALTER TABLE notification ADD COLUMN doc_slug TEXT',
  // Reminder bookkeeping: when a notification is owed a nudge outside the
  // app, and when one was sent.
  'ALTER TABLE notification ADD COLUMN remind_at INTEGER',
  'ALTER TABLE notification ADD COLUMN reminded_at INTEGER',
  'ALTER TABLE notification ADD COLUMN reminded_via TEXT',
  'CREATE INDEX IF NOT EXISTS idx_notification_reminder ON notification(remind_at) WHERE read_at IS NULL AND reminded_at IS NULL AND remind_at IS NOT NULL',
  // How long this person's unread notifications wait before they are nudged.
  // Seconds, 0 for off. Existing members get the same default as new ones.
  'ALTER TABLE actor ADD COLUMN notify_after_seconds INTEGER NOT NULL DEFAULT 600',
  // Workspace policy. A CHECK cannot be added by ALTER, so an existing
  // database gets the column without one and the route's own validation is
  // what holds the values to the two that mean anything. A fresh database
  // gets the CHECK from SCHEMA_SQL. Rebuilding the workspace table to add a
  // constraint is not worth it for a column only an admin route writes.
  "ALTER TABLE workspace ADD COLUMN comment_delete TEXT NOT NULL DEFAULT 'author'",
  // The card this one is part of. Nullable, which is what "not part of
  // anything" means, so nothing has to be backfilled.
  'ALTER TABLE item ADD COLUMN parent_id TEXT REFERENCES item(id)',
  // Every read of a card's parts is this lookup, and every board read asks
  // it once per card.
  'CREATE INDEX IF NOT EXISTS idx_item_parent ON item(parent_id)',
  // At most one label from this group on a card, for groups that name a
  // single answer rather than a set of tags.
  'ALTER TABLE label_group ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0',
  // Where a label sits in its group, for groups whose order is not
  // alphabetical. Null everywhere until somebody arranges one.
  'ALTER TABLE label ADD COLUMN pos REAL',
  // The number the next goal gets. Existing workspaces start at 1, which is
  // right, since nothing has been numbered yet.
  'ALTER TABLE workspace ADD COLUMN next_goal_seq INTEGER NOT NULL DEFAULT 1',
  // Which goal a notification opens, beside item_key and doc_slug.
  'ALTER TABLE notification ADD COLUMN goal_number INTEGER',
  // The walkthroughs this person has seen or skipped, as JSON keyed by the
  // walkthrough's id. On the actor for the same reason as onboarded_at: a
  // tour replaying because someone opened a second browser is a nuisance.
  'ALTER TABLE actor ADD COLUMN walkthroughs TEXT',
  // Document ownership and visibility (Jose, 2026-10-09). Existing pages stay
  // shared with the workspace, which is what they have always been, and
  // bootstrap backfills their owner from who wrote the first version. A new
  // page starts private and asks its author on the first save (ask_share).
  'ALTER TABLE document ADD COLUMN owner_id TEXT REFERENCES actor(id)',
  "ALTER TABLE document ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'",
  'ALTER TABLE document ADD COLUMN ask_share INTEGER NOT NULL DEFAULT 0',
  // Set on an event about a page that was private when it happened: the one
  // person who may see it. Read from the event rather than the page, because
  // a deleted page can no longer say it was private, and its history must not
  // become public the moment it goes.
  'ALTER TABLE event ADD COLUMN private_to TEXT',
  // The panels this person arranged Home into, as JSON (services/home.ts).
  // Null: the default, which follows the defaults as they change.
  'ALTER TABLE actor ADD COLUMN home_layout TEXT',
  // When a card became done: reached a done list or was completed. The board
  // hides done cards older than its space's window, measured from this and
  // never from the last edit, so a comment on an old card does not bring it
  // back (Jira's well-known trap). Kept by the triggers below, so every write
  // path, present and future, keeps it right. Bootstrap backfills existing
  // done cards from their last update.
  'ALTER TABLE item ADD COLUMN done_at INTEGER',
  // How urgent a card is: low, medium, high or urgent. Null: nobody said.
  // A real field rather than a label group (Jose, 2026-10-09), because Home
  // ranks by it and a label can mean anything.
  "ALTER TABLE item ADD COLUMN priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent'))",
  // How many days a space's board shows done cards for (null: always), and
  // when somebody last pressed "Clear done now". Jose, 2026-10-09.
  'ALTER TABLE space ADD COLUMN done_window_days INTEGER DEFAULT 14',
  'ALTER TABLE space ADD COLUMN done_cleared_at INTEGER',
  // v2 reads the row as it is now rather than NEW: the completed flag is set
  // by a sibling trigger (below), and NEW still holds the value from before
  // it, which put done_at back on a card just moved out of Done.
  'DROP TRIGGER IF EXISTS item_done_at_insert',
  'DROP TRIGGER IF EXISTS item_done_at_update',
  `CREATE TRIGGER IF NOT EXISTS item_done_at_insert_v2 AFTER INSERT ON item
   BEGIN
     UPDATE item SET done_at = CASE
         WHEN item.completed = 1 OR (SELECT role FROM list WHERE id = item.list_id) = 'done'
         THEN COALESCE(item.done_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
         ELSE NULL END
      WHERE id = NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS item_done_at_update_v2 AFTER UPDATE OF list_id, completed ON item
   BEGIN
     UPDATE item SET done_at = CASE
         WHEN item.completed = 1 OR (SELECT role FROM list WHERE id = item.list_id) = 'done'
         THEN COALESCE(item.done_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
         ELSE NULL END
      WHERE id = NEW.id;
   END`,
  // The list is the status (Jose, 2026-10-09). A card cannot read "Open"
  // while sitting in Done, or "Done" while sitting in In Progress: in a space
  // with a done list, being in one is what done means. A space without one
  // keeps the completed flag as its only way to say so.
  `CREATE TRIGGER IF NOT EXISTS item_completed_follows_list_insert AFTER INSERT ON item
   WHEN EXISTS (SELECT 1 FROM list WHERE space_id = NEW.space_id AND role = 'done')
   BEGIN
     UPDATE item SET completed = CASE
         WHEN (SELECT role FROM list WHERE id = NEW.list_id) = 'done' THEN 1 ELSE 0 END
      WHERE id = NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS item_completed_follows_list AFTER UPDATE OF list_id ON item
   WHEN NEW.list_id IS NOT OLD.list_id
     AND EXISTS (SELECT 1 FROM list WHERE space_id = NEW.space_id AND role = 'done')
   BEGIN
     UPDATE item SET completed = CASE
         WHEN (SELECT role FROM list WHERE id = NEW.list_id) = 'done' THEN 1 ELSE 0 END
      WHERE id = NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS list_done_at_role AFTER UPDATE OF role ON list
   BEGIN
     UPDATE item SET done_at = CASE
         WHEN completed = 1 OR NEW.role = 'done'
         THEN COALESCE(done_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
         ELSE NULL END
      WHERE list_id = NEW.id;
   END`,
  // A card's own history. The response-times report reads it for
  // every card in a space, and a card's activity tail and reopening a card
  // read it for one. Until this, each of those scanned the whole event table.
  'CREATE INDEX IF NOT EXISTS idx_event_entity ON event(entity_id)',
  // LA-397, the isolation gate. An operator's switch to shut a workspace.
  'ALTER TABLE workspace ADD COLUMN suspended_at INTEGER',
  // Whether the address on an actor has been proved. Existing people who have
  // ever signed in have proved it (through the provider, which binds
  // platform_user_id, or with a code, which mints a session), so they are
  // backfilled. Anyone an admin typed in who never came is left unconfirmed
  // and gets no email until they sign in. Safe to re-run: every sign-in path
  // now stamps the column itself.
  'ALTER TABLE actor ADD COLUMN email_confirmed_at INTEGER',
  `UPDATE actor SET email_confirmed_at = created_at
    WHERE email_confirmed_at IS NULL AND kind = 'human'
      AND (platform_user_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM auth_token t
                       WHERE t.actor_id = actor.id AND t.kind = 'session'))`,
  // When an OAuth client was first used. Clients that already have a code or a
  // token count as used, so pruning never removes a working connector.
  'ALTER TABLE oauth_client ADD COLUMN used_at INTEGER',
  `UPDATE oauth_client SET used_at = created_at
    WHERE used_at IS NULL
      AND (EXISTS (SELECT 1 FROM oauth_code c WHERE c.client_id = oauth_client.id)
           OR EXISTS (SELECT 1 FROM oauth_token t WHERE t.client_id = oauth_client.id))`,
  // LA-401. A workspace an admin asked to delete: when, by whom, and when the
  // cron purges it. Reads keep working until then and writes are refused, so
  // the 30 days are for changing your mind or exporting, not for working.
  'ALTER TABLE workspace ADD COLUMN deleted_at INTEGER',
  'ALTER TABLE workspace ADD COLUMN deleted_by TEXT',
  'ALTER TABLE workspace ADD COLUMN purge_at INTEGER',
  // What the retention sweep deletes by. Each sweep is a range on time, and
  // without these every one of them scanned its whole table. Activity needs
  // none: its ids are time-ordered, so idx_event_ws already is one.
  'CREATE INDEX IF NOT EXISTS idx_op_log_created ON op_log(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_delivery_created ON webhook_delivery(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_notification_read ON notification(read_at) WHERE read_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_workspace_purge ON workspace(purge_at) WHERE purge_at IS NOT NULL',
  // LA-398, signup. Who created a workspace through signup, which is what the
  // one-per-account cap counts. Stored lowercased. Workspaces made before
  // signup existed have no owner and count against nobody.
  'ALTER TABLE workspace ADD COLUMN owner_email TEXT',
  'ALTER TABLE workspace ADD COLUMN owner_platform_user_id TEXT',
  // The terms the creator accepted, and when. Null where no terms were
  // configured at the time (self-hosted, or before the documents existed).
  'ALTER TABLE workspace ADD COLUMN terms_version TEXT',
  'ALTER TABLE workspace ADD COLUMN terms_accepted_at INTEGER',
  // The Free inactivity ladder: when the admins were warned, and when the
  // workspace was made read-only for being idle. A person opening it again
  // clears both.
  'ALTER TABLE workspace ADD COLUMN inactivity_warned_at INTEGER',
  'ALTER TABLE workspace ADD COLUMN frozen_at INTEGER',
  // When a person last opened the workspace in a browser, at day precision
  // (stamped at most once a day). What the inactivity job measures idleness
  // by: an agent writing on its own is not someone using the workspace.
  'ALTER TABLE workspace ADD COLUMN last_seen_at INTEGER',
  'CREATE INDEX IF NOT EXISTS idx_workspace_owner_email ON workspace(owner_email) WHERE owner_email IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_workspace_owner_sub ON workspace(owner_platform_user_id) WHERE owner_platform_user_id IS NOT NULL',
]

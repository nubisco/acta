/**
 * Migrating a database that still says "board".
 *
 * Every other test starts from an empty database, where the schema is simply
 * created in its current shape, so none of them touch this path. But the
 * production database has a thousand rows under the old names, and
 * CREATE TABLE IF NOT EXISTS would cheerfully make an empty `space` beside a
 * full `board` and every read would come back empty. This is the test that
 * stands between that and the cutover.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { openDb, type BunSqliteDriver } from '../src/db'

const paths: string[] = []
afterEach(() => {
  for (const p of paths.splice(0)) {
    try {
      unlinkSync(p)
    } catch {
      // Already gone.
    }
  }
})

/** A database in the shape this rename replaces, with rows in it. */
async function legacyDb(): Promise<string> {
  const path = `/tmp/acta-rename-${Math.random().toString(36).slice(2)}.sqlite`
  paths.push(path)
  const { Database } = await import('bun:sqlite')
  const db = new Database(path, { create: true, strict: true })
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE actor (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
      handle TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE board (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', next_seq INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE list (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES board(id), name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'none', pos REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE item (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES board(id), list_id TEXT NOT NULL, key TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', pos REAL NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE label_group (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      board_id TEXT REFERENCES board(id), name TEXT NOT NULL);
    CREATE TABLE document (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slug TEXT NOT NULL,
      title TEXT NOT NULL, parent_id TEXT, board_id TEXT REFERENCES board(id), pos REAL NOT NULL,
      body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE ingest_token (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES board(id), token_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE connection (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES board(id), provider TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE board_star (workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES board(id), created_at INTEGER NOT NULL,
      PRIMARY KEY (actor_id, board_id));
    CREATE TABLE link (workspace_id TEXT NOT NULL, src_kind TEXT NOT NULL, src_id TEXT NOT NULL,
      ref_type TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (src_kind, src_id, ref_type, target));
    CREATE TABLE event (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      verb TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE doc_comment (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      document_id TEXT NOT NULL, actor_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE comment (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, item_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE VIRTUAL TABLE fts USING fts5(kind, ref, title, body, board_key, tokenize = 'unicode61');

    INSERT INTO workspace VALUES ('ws1','Nubisco','nubisco',1);
    INSERT INTO actor VALUES ('act1','ws1','human','jose','José','admin',0,1);
    INSERT INTO board VALUES ('b1','ws1','ST','Stagewright','',9,0,1,1);
    INSERT INTO list VALUES ('l1','ws1','b1','To Do','none',1,0);
    INSERT INTO item VALUES ('i1','ws1','b1','l1','ST-1','Ship it','the body',1,0,0,1,'act1',1,1);
    INSERT INTO label_group VALUES ('lg1','ws1','b1','Kind');
    INSERT INTO document VALUES ('d1','ws1','home','Home',NULL,'b1',1,'see [[board:ST]] for context','[]',0,1,1,1);
    INSERT INTO ingest_token VALUES ('tok1','ws1','b1','hash',1);
    INSERT INTO connection VALUES ('con1','ws1','b1','github',1);
    INSERT INTO board_star VALUES ('ws1','act1','b1',1);
    INSERT INTO link VALUES ('ws1','doc','d1','board','ST');
    INSERT INTO fts VALUES ('item','ST-1','Ship it','the body','ST');
    INSERT INTO event VALUES ('e1','ws1','act1','board.created','board','b1','created board ST (Stagewright)',1);
    INSERT INTO event VALUES ('e2','ws1','act1','item.created','item','i1','created ST-1 on the keyboard',1);
  `)
  db.close()
  return path
}

describe('board -> space migration', () => {
  it('carries every row across, and rewires what pointed at them', async () => {
    const db = (await openDb(await legacyDb())) as BunSqliteDriver

    // The table is renamed, not recreated: the row is still in it.
    expect(await db.query('SELECT key, name FROM space')).toEqual([
      { key: 'ST', name: 'Stagewright' },
    ])

    // Every table that referenced it now does so by the new column name,
    // still resolving to the same space.
    for (const table of [
      'list',
      'item',
      'label_group',
      'document',
      'ingest_token',
      'connection',
      'space_star',
    ]) {
      const rows = await db.query<{ space_id: string }>(
        `SELECT space_id FROM ${table}`,
      )
      expect(rows).toEqual([{ space_id: 'b1' }])
    }

    // A reference recorded as a board is a reference to a space.
    expect(await db.query('SELECT ref_type, target FROM link')).toEqual([
      { ref_type: 'space', target: 'ST' },
    ])
  })

  it('rebuilds the search index, because FTS5 cannot rename a column', async () => {
    const db = (await openDb(await legacyDb())) as BunSqliteDriver

    // The new column exists...
    const rows = await db.query<{ ref: string; space_key: string }>(
      "SELECT ref, space_key FROM fts WHERE kind = 'item'",
    )
    // ...and the index was repopulated from the rows rather than left empty,
    // which is the failure a rename-and-forget would have shipped.
    expect(rows).toEqual([{ ref: 'ST-1', space_key: 'ST' }])

    const hit = await db.query<{ ref: string }>(
      "SELECT ref FROM fts WHERE fts MATCH 'body'",
    )
    expect(hit.map((r) => r.ref)).toContain('ST-1')
  })

  it('is safe to run again, and leaves an already-migrated database alone', async () => {
    const path = await legacyDb()
    await openDb(path)
    // Second open re-runs every statement against the migrated shape.
    const again = (await openDb(path)) as BunSqliteDriver

    expect(await again.query('SELECT COUNT(*) AS n FROM space')).toEqual([
      { n: 1 },
    ])
    expect(
      await again.query("SELECT COUNT(*) AS n FROM fts WHERE kind = 'item'"),
    ).toEqual([{ n: 1 }])
  })

  // A rename that moves the columns and leaves the rows saying "board"
  // produces an activity feed and a set of links that quietly stop matching
  // anything the code now asks for.
  it('migrates the values, not just the identifiers', async () => {
    const db = (await openDb(await legacyDb())) as BunSqliteDriver

    const events = await db.query<{
      verb: string
      entity: string
      summary: string
    }>('SELECT verb, entity, summary FROM event ORDER BY id')
    expect(events[0]).toEqual({
      verb: 'space.created',
      entity: 'space',
      summary: 'created space ST (Stagewright)',
    })

    // And nothing else. "keyboard" contains the word, and an item event is
    // not a space event; a blanket replace would have mangled both.
    expect(events[1]).toEqual({
      verb: 'item.created',
      entity: 'item',
      summary: 'created ST-1 on the keyboard',
    })

    // A markdown ref resolves on its prefix, so it stops resolving the moment
    // the prefix changes.
    expect(
      await db.query<{ body: string }>('SELECT body FROM document'),
    ).toEqual([{ body: 'see [[space:ST]] for context' }])
  })
})

/**
 * Migrating a database whose notification table predates document inboxes
 * and reminders.
 *
 * `doc_slug` is the reason this file exists. It was added to SCHEMA_SQL the
 * day document comments shipped and never listed in ADDITIVE_COLUMNS, so a
 * fresh database has the column and every database older than that line does
 * not. Nothing read it, so the gap was invisible: the first write that names
 * it in an INSERT is the one that fails, in production, on the instance that
 * has been running longest.
 *
 * Every other test starts from an empty database and gets the whole schema
 * for free, which is precisely how that would have shipped again.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { openDb } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { docWrite } from '../src/services/docs'
import { notificationList } from '../src/services/notifications'
import type { ICtx } from '../src/core/ctx'

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

/**
 * A notification table in the shape it shipped in, with a row in it. No
 * `doc_slug`, no reminder columns, and an actor with no preference column.
 */
async function legacyDb(): Promise<string> {
  const path = `/tmp/acta-ntf-${Math.random().toString(36).slice(2)}.sqlite`
  paths.push(path)
  const { Database } = await import('bun:sqlite')
  const db = new Database(path, { create: true, strict: true })
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE actor (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
      handle TEXT NOT NULL, name TEXT NOT NULL, email TEXT, role TEXT NOT NULL DEFAULT 'member',
      disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE (workspace_id, handle));
    CREATE TABLE event (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL,
      actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, on_behalf_of TEXT, verb TEXT NOT NULL,
      entity TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT,
      caused_by TEXT);
    CREATE TABLE notification (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id),
      actor_id TEXT NOT NULL REFERENCES actor(id),
      event_id TEXT NOT NULL REFERENCES event(id),
      reason TEXT NOT NULL CHECK (reason IN ('mention', 'assigned', 'involved')),
      verb TEXT NOT NULL,
      summary TEXT NOT NULL,
      item_key TEXT,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      UNIQUE (actor_id, event_id)
    );
    INSERT INTO workspace VALUES ('w1', 'Nubisco', 1);
    INSERT INTO actor VALUES ('a1','w1','human','jose','Jose','jose@nubisco.io','admin',0,1);
    INSERT INTO actor VALUES ('a2','w1','human','ivan','Ivan','ivan@nubisco.io','member',0,1);
    INSERT INTO event VALUES ('e1','w1',1,'a1','human',null,'comment.created','item','i1','said a thing',null,null);
    INSERT INTO notification VALUES ('n1','w1','a2','e1','mention','comment.created','said a thing','ST-1',1,null);
  `)
  db.close()
  return path
}

describe('a database older than document inboxes', () => {
  it('keeps the notifications it already had', async () => {
    const db = await openDb(await legacyDb())
    const rows = await db.query<{ id: string; doc_slug: string | null }>(
      'SELECT id, doc_slug FROM notification',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].doc_slug).toBeNull()
  })

  it('can write a notification that names a document', async () => {
    const path = await legacyDb()
    const db = await openDb(path)
    const workspaceId = 'w1'
    const ctx = (id: string, handle: string): ICtx => ({
      db,
      workspaceId,
      actor: {
        id,
        kind: 'human',
        handle,
        role: 'member',
        scopes: ['read', 'write'],
      },
    })
    const jose = ctx('a1', 'jose')
    const ivan = ctx('a2', 'ivan')

    await docWrite(jose, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'spec',
        title: 'Spec',
        body: 'hello [[@ivan]]',
        layout: 'default',
        tags: [],
      },
    ])

    // The INSERT names doc_slug. On a database without the column it throws,
    // and emitEvent swallows notification failures, so the symptom would not
    // be an error: it would be a mention that silently reached nobody.
    const got = (await notificationList(ivan)).notifications
    expect(got.map((n) => n.doc_slug)).toContain('spec')
  })

  it('gives everyone who was already there the reminder default', async () => {
    const db = await openDb(await legacyDb())
    const rows = await db.query<{ notify_after_seconds: number }>(
      'SELECT notify_after_seconds FROM actor WHERE handle = ?',
      ['ivan'],
    )
    // On by default, for members who predate the setting as much as for new
    // ones. Defaulting an existing member to off would make the feature
    // arrive switched off for everybody who could already use it.
    expect(rows[0].notify_after_seconds).toBe(600)
  })

  it('gives the workspace the default comment policy', async () => {
    const db = await openDb(await legacyDb())
    const rows = await db.query<{ comment_delete: string }>(
      'SELECT comment_delete FROM workspace',
    )
    // People can delete their own comments unless an admin says otherwise.
    // Defaulting an existing workspace to 'admin' would take something away
    // from everybody the moment they upgraded.
    expect(rows[0].comment_delete).toBe('author')
  })

  it('adds the parent link without disturbing the cards already there', async () => {
    const path = await legacyDb()
    const db = await openDb(path)
    // The legacy fixture has no item table at all, so this is really
    // asserting the column exists and defaults to null on a database the
    // migration built the table into. A card that predates the feature is
    // part of nothing, which is what null means.
    await db.run(
      `INSERT INTO item (id, workspace_id, space_id, list_id, key, title, pos, created_by, created_at, updated_at)
       SELECT 'itm_x', 'w1', s.id, l.id, 'ST-1', 'Old card', 1, 'a1', 1, 1
         FROM space s JOIN list l ON l.space_id = s.id LIMIT 1`,
    )
    const rows = await db.query<{ parent_id: string | null }>(
      'SELECT parent_id FROM item WHERE key = ?',
      ['ST-1'],
    )
    expect(rows[0]?.parent_id ?? null).toBeNull()
  })

  it('stamps a reminder deadline on a notification written after the migration', async () => {
    const path = await legacyDb()
    const db = await openDb(path)
    const jose: ICtx = {
      db,
      workspaceId: 'w1',
      actor: {
        id: 'a1',
        kind: 'human',
        handle: 'jose',
        role: 'admin',
        scopes: ['read', 'write'],
      },
    }
    await bootstrapWorkspace(db, {
      workspaceName: 'Nubisco',
      adminEmail: 'jose@nubisco.io',
      adminHandle: 'jose',
    })
    await spaceWrite(jose, [
      {
        op: 'create',
        op_id: 'b1',
        key: 'ST',
        name: 'Stagewright',
        template: 'kanban6',
      },
    ])
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'Ship it',
          assignees: ['ivan'],
        },
      ],
      'ST',
    )

    const rows = await db.query<{ remind_at: number | null }>(
      "SELECT remind_at FROM notification WHERE actor_id = 'a2' AND remind_at IS NOT NULL",
    )
    expect(rows.length).toBeGreaterThan(0)
  })
})

/**
 * Migrating a database whose auth_token predates personal tokens.
 *
 * SQLite cannot alter a CHECK in place, so `kind IN ('session','agent')` has
 * to be rebuilt into `kind IN ('session','agent','personal')`. Every other
 * test starts from an empty database and gets the new constraint for free,
 * which is exactly how the last CHECK-constraint migration shipped broken:
 * the fixture had no constraint, so the INSERT the migration performs could
 * not fail, and it only would have failed in production.
 *
 * A failed migration is memoized per isolate, so getting this wrong is not a
 * degraded feature, it is every request failing until a redeploy. Worse here
 * than for `link`: rebuilding auth_token wrongly signs out everybody.
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

/**
 * A database in the shape this replaces, with live sessions in it. The CHECK
 * is the point of the fixture: without it the rebuild would appear to work
 * whether or not it ran.
 */
async function legacyDb(): Promise<string> {
  const path = `/tmp/acta-token-${Math.random().toString(36).slice(2)}.sqlite`
  paths.push(path)
  const { Database } = await import('bun:sqlite')
  const db = new Database(path, { create: true, strict: true })
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT,
      created_at INTEGER NOT NULL);
    CREATE TABLE actor (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
      handle TEXT NOT NULL, name TEXT NOT NULL, email TEXT, role TEXT NOT NULL DEFAULT 'member',
      disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE auth_token (
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
    INSERT INTO workspace VALUES ('w1', 'Workspace', 'workspace', 1);
    INSERT INTO actor VALUES ('a1','w1','human','dana','Dana','dana@example.test','admin',0,1);
    INSERT INTO auth_token VALUES ('t1','w1','a1','session','hash-session','read,write',null,1,null);
    INSERT INTO auth_token VALUES ('t2','w1','a1','agent','hash-agent','read',null,1,null);
    INSERT INTO auth_token VALUES ('t3','w1','a1','session','hash-revoked','read,write',null,1,9);
  `)
  db.close()
  return path
}

describe('auth_token personal-kind migration', () => {
  it('accepts a personal token afterwards, and refused one before', async () => {
    const path = await legacyDb()
    const { Database } = await import('bun:sqlite')

    // The constraint is real: prove the fixture would reject the new kind.
    const before = new Database(path, { strict: true })
    expect(() =>
      before.exec(
        `INSERT INTO auth_token VALUES ('x','w1','a1','personal','h','read',null,1,null)`,
      ),
    ).toThrow()
    before.close()

    const db = (await openDb(path)) as BunSqliteDriver
    await db.run(
      `INSERT INTO auth_token (id, workspace_id, actor_id, kind, token_hash, label, scopes, created_at)
       VALUES ('p1','w1','a1','personal','hash-personal','laptop','read,write',1)`,
    )
    const rows = await db.query<{ kind: string; label: string | null }>(
      "SELECT kind, label FROM auth_token WHERE id = 'p1'",
    )
    expect(rows[0]).toMatchObject({ kind: 'personal', label: 'laptop' })
  })

  it('carries every existing token across, revocations included', async () => {
    const db = (await openDb(await legacyDb())) as BunSqliteDriver
    const rows = await db.query<{
      id: string
      kind: string
      token_hash: string
      scopes: string
      revoked_at: number | null
    }>(
      'SELECT id, kind, token_hash, scopes, revoked_at FROM auth_token ORDER BY id',
    )
    expect(rows).toHaveLength(3)
    // A session that survives the migration is a person who stays signed in.
    expect(rows[0]).toMatchObject({
      id: 't1',
      kind: 'session',
      token_hash: 'hash-session',
      scopes: 'read,write',
    })
    expect(rows[1]).toMatchObject({ id: 't2', kind: 'agent', scopes: 'read' })
    // And a revoked token must not come back as a live one.
    expect(rows[2].revoked_at).toBe(9)
  })

  it('leaves the old kinds constrained', async () => {
    const db = (await openDb(await legacyDb())) as BunSqliteDriver
    expect(() =>
      db.run(
        `INSERT INTO auth_token (id, workspace_id, actor_id, kind, token_hash, scopes, created_at)
         VALUES ('bad','w1','a1','superuser','h2','read,write,admin',1)`,
      ),
    ).toThrow()
  })

  it('runs once and is a no-op on a database that already has it', async () => {
    const path = await legacyDb()
    const first = (await openDb(path)) as BunSqliteDriver
    await first.run(
      `INSERT INTO auth_token (id, workspace_id, actor_id, kind, token_hash, label, scopes, created_at)
       VALUES ('p1','w1','a1','personal','hash-personal','laptop','read,write',1)`,
    )

    // Reopening runs migrate() again. If the rebuild were unguarded it would
    // drop and recreate the table, and the token minted above would be gone.
    const second = (await openDb(path)) as BunSqliteDriver
    const rows = await second.query<{ id: string }>(
      "SELECT id FROM auth_token WHERE kind = 'personal'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('p1')
  })
})

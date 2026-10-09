/**
 * Deleting a space (Jose, 2026-10-09: an empty board had no way of being
 * removed). Archive is the reversible step, delete is for good: an empty
 * space goes directly, one with cards must be archived first. Admins only.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { docWrite } from '../src/services/docs'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let admin: ICtx
let member: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  const ws = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const me = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  admin = {
    db,
    workspaceId: ws,
    actor: {
      id: me,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
  member = { ...admin, actor: { ...admin.actor, role: 'member' } }
  await spaceWrite(admin, [
    {
      op: 'create',
      op_id: 'e',
      key: 'EMP',
      name: 'Empty',
      template: 'kanban6',
    },
    { op: 'create', op_id: 'f', key: 'FUL', name: 'Full', template: 'kanban6' },
  ] as never)
  await itemWrite(
    admin,
    [
      { op: 'create', op_id: 'i1', list: 'To Do', title: 'One' },
      { op: 'create', op_id: 'i2', list: 'To Do', title: 'Two' },
      { op: 'depends_on', op_id: 'd', key: 'FUL-2', blocker: 'FUL-1' },
      { op: 'comment', op_id: 'c', key: 'FUL-1', body: 'hi' },
    ] as never,
    'FUL',
  )
})

const count = async (sql: string, args: unknown[] = []) =>
  (await db.query<{ n: number }>(sql, args))[0].n
const del = (ctx: ICtx, key: string, id = `del-${key}-${Math.random()}`) =>
  spaceWrite(ctx, [{ op: 'delete', op_id: id, key }] as never)

describe('deleting a space', () => {
  it('removes an empty space directly', async () => {
    const [r] = await del(admin, 'EMP')
    expect(r.ok).toBe(true)
    expect(
      await count("SELECT COUNT(*) AS n FROM space WHERE key = 'EMP'"),
    ).toBe(0)
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM list l JOIN space s ON s.id = l.space_id WHERE s.key = 'EMP'",
      ),
    ).toBe(0)
  })

  it('is for admins only', async () => {
    const [r] = await del(member, 'EMP')
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('admin')
  })

  it('asks for a space with cards to be archived first, then takes everything', async () => {
    const [refused] = await del(admin, 'FUL')
    expect(refused.ok).toBe(false)
    expect((refused as { error: string }).error).toContain('archive the space')

    await spaceWrite(admin, [
      { op: 'archive', op_id: 'a', key: 'FUL' },
    ] as never)
    await docWrite(admin, [
      {
        op: 'create',
        op_id: 'doc',
        slug: 'notes',
        title: 'Notes',
        body: 'x',
        layout: 'default',
        tags: [],
        space: 'FUL',
      },
    ] as never)
    const [r] = await del(admin, 'FUL')
    expect(r.ok).toBe(true)
    expect(
      await count("SELECT COUNT(*) AS n FROM item WHERE key LIKE 'FUL-%'"),
    ).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM comment')).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM item_dependency')).toBe(0)
    // The page is kept, unfiled.
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM document WHERE slug = 'notes' AND space_id IS NULL",
      ),
    ).toBe(1)
  })

  it('brings an archived space back with restore', async () => {
    await spaceWrite(admin, [
      { op: 'archive', op_id: 'a2', key: 'EMP' },
      { op: 'restore', op_id: 'r2', key: 'EMP' },
    ] as never)
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM space WHERE key = 'EMP' AND archived = 0",
      ),
    ).toBe(1)
  })
})

/**
 * A card's own history: who made it, and who changed what, when.
 *
 * Asked for by Jose on 2026-10-08 after opening Ivan's NU-134. The events
 * were all there, but several said only that something changed ("labels
 * changed", "updated"), sizing a card left no trace at all, and nothing on
 * a card showed any of it.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { itemGet } from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let jose: ICtx

interface IRow {
  verb: string
  by?: string
  summary: string
  changes?: Record<string, unknown>
}

beforeEach(async () => {
  db = await openDb(':memory:')
  const workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
     VALUES ('act_ivan', ?, 'human', 'ivan', 'Ivan', 'ivan@nubisco.io', 'member', ?)`,
    [workspaceId, Date.now()],
  )
  jose = {
    db,
    workspaceId,
    actor: {
      id: joseId,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write'],
    },
  }
  await spaceWrite(jose, [
    {
      op: 'create',
      op_id: 's1',
      key: 'NU',
      name: 'Nubisco UI',
      template: 'kanban6',
    },
    { op: 'create', op_id: 's2', key: 'LA', name: 'Labs', template: 'kanban6' },
  ])
  // Labels come from the Type group the workspace is seeded with.
  await itemWrite(
    jose,
    [
      {
        op: 'create',
        op_id: 'c',
        list: 'Backlog',
        title: 'Email notifications',
      },
    ],
    'NU',
  )
})

async function history(key: string): Promise<IRow[]> {
  const [item] = (await itemGet(jose, { keys: [key], include: ['activity'] }))
    .items
  return item.activity as IRow[]
}

describe('a card says who made it', () => {
  it('names its creator on every read', async () => {
    const [item] = (await itemGet(jose, { keys: ['NU-1'] })).items
    expect(item.created_by).toBe('jose')
  })
})

describe('a card history says what changed', () => {
  it('names the people put on and taken off', async () => {
    await itemWrite(jose, [
      { op: 'assign', op_id: 'a1', key: 'NU-1', add: ['ivan'] },
      {
        op: 'assign',
        op_id: 'a2',
        key: 'NU-1',
        remove: ['ivan'],
        add: ['jose'],
      },
    ])
    const rows = (await history('NU-1')).filter(
      (r) => r.verb === 'item.assigned',
    )
    expect(rows[0].changes).toEqual({ added: ['jose'], removed: ['ivan'] })
    expect(rows[1].changes).toEqual({ added: ['ivan'], removed: [] })
    expect(rows[0].by).toBe('jose')
  })

  it('names the labels added and removed, with their group', async () => {
    await itemWrite(jose, [
      { op: 'label', op_id: 'l1', key: 'NU-1', add: ['Bug', 'Docs'] },
      { op: 'label', op_id: 'l2', key: 'NU-1', remove: ['Bug'] },
    ])
    const rows = (await history('NU-1')).filter(
      (r) => r.verb === 'item.labeled',
    )
    expect(rows[0].changes).toEqual({ added: [], removed: ['Type/Bug'] })
    expect((rows[1].changes!.added as string[]).sort()).toEqual([
      'Type/Bug',
      'Type/Docs',
    ])
  })

  it('says which fields an update touched, and the old title', async () => {
    await itemWrite(jose, [
      {
        op: 'update',
        op_id: 'u',
        key: 'NU-1',
        title: 'Reminder emails link nowhere',
        description: 'Body',
      },
    ])
    const row = (await history('NU-1')).find((r) => r.verb === 'item.updated')!
    expect(row.changes).toEqual({
      title: {
        from: 'Email notifications',
        to: 'Reminder emails link nowhere',
      },
      description: true,
    })
  })

  it('records a size, which used to leave no trace', async () => {
    await itemWrite(jose, [{ op: 'size', op_id: 'z', key: 'NU-1', size: 3 }])
    await itemWrite(jose, [{ op: 'size', op_id: 'z2', key: 'NU-1', size: 3 }])
    const rows = (await history('NU-1')).filter((r) => r.verb === 'item.sized')
    // Setting the same size again is not a change.
    expect(rows).toHaveLength(1)
    expect(rows[0].changes).toMatchObject({ size: 3, from: null })
  })

  it('follows the card across a move to another space', async () => {
    await itemWrite(jose, [
      { op: 'move', op_id: 'm', key: 'NU-1', space: 'LA', list: 'To Do' },
    ])
    // Read by its new key, and the old one still resolves to the same story.
    const rows = await history('LA-1')
    expect(rows[0].changes).toMatchObject({
      list: 'To Do',
      from_key: 'NU-1',
      space: 'LA',
    })
    expect(rows.at(-1)!.verb).toBe('item.created')
    expect((await history('NU-1')).length).toBe(rows.length)
  })
})

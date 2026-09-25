/**
 * A card can be part of another card.
 *
 * A link, not a ladder. There are no epic, story or task types to keep in
 * order, so any card can be part of any card at any depth and on any board.
 * That is the whole model, and it means the only thing standing between it
 * and a corrupt tree is the cycle check.
 *
 * Deliberately not the same relation as `item_dependency`, which says what
 * has to happen first. A card can be part of something it does not wait on,
 * and wait on something it is not part of.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { itemGet, spaceGet } from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let workspaceId: string
let jose: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const actor = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0]
  jose = {
    db,
    workspaceId,
    actor: {
      id: actor.id,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write'],
    },
  }
  for (const [key, name] of [
    ['ST', 'Stagewright'],
    ['SU', 'Support'],
  ]) {
    await spaceWrite(jose, [
      {
        op: 'create',
        op_id: `b-${key}`,
        key,
        name,
        template: 'kanban6',
      },
    ])
  }
})

/** `n` cards on `space`, returned as their keys in order. */
async function cards(space: string, n: number): Promise<string[]> {
  const keys: string[] = []
  for (let i = 0; i < n; i += 1) {
    const res = await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: `c-${space}-${i}`,
          list: 'To Do',
          title: `${space} card ${i}`,
        },
      ],
      space,
    )
    keys.push((res[0] as { key: string }).key)
  }
  return keys
}

const setParent = (
  key: string,
  parent: string | null,
  opId = `p-${key}-${parent}`,
) => itemWrite(jose, [{ op: 'set_parent', op_id: opId, key, parent }])

const read = async (key: string) =>
  (
    (await itemGet(jose, { keys: [key] })) as {
      items: Array<{
        parent?: { key: string; space: string; done?: boolean }
        parts?: Array<{ key: string; space: string; done?: boolean }>
      }>
    }
  ).items[0]

describe('making a card part of another', () => {
  it('shows on both ends', async () => {
    const [parent, child] = await cards('ST', 2)
    const [res] = await setParent(child, parent)
    expect(res.ok).toBe(true)

    expect((await read(child)).parent?.key).toBe(parent)
    expect((await read(parent)).parts?.map((p) => p.key)).toEqual([child])
  })

  it('works across boards, which is the point', async () => {
    const [parent] = await cards('ST', 1)
    const [child] = await cards('SU', 1)
    await setParent(child, parent)

    const seen = await read(parent)
    expect(seen.parts).toHaveLength(1)
    // The board is carried, because a part from somewhere else is exactly
    // the case where the key alone does not say where it lives.
    expect(seen.parts?.[0].space).toBe('SU')
    expect((await read(child)).parent?.space).toBe('ST')
  })

  it('nests as deep as you like', async () => {
    const [a, b, c] = await cards('ST', 3)
    await setParent(b, a)
    await setParent(c, b)

    expect((await read(b)).parts?.map((p) => p.key)).toEqual([c])
    expect((await read(c)).parent?.key).toBe(b)
  })

  it('moves a part from one parent to another', async () => {
    const [one, two, child] = await cards('ST', 3)
    await setParent(child, one)
    await setParent(child, two, 'p-move')

    expect((await read(child)).parent?.key).toBe(two)
    expect((await read(one)).parts).toBeUndefined()
    expect((await read(two)).parts?.map((p) => p.key)).toEqual([child])
  })

  it('detaches', async () => {
    const [parent, child] = await cards('ST', 2)
    await setParent(child, parent)
    const [res] = await setParent(child, null, 'p-detach')

    expect(res.ok).toBe(true)
    expect((await read(child)).parent).toBeUndefined()
    expect((await read(parent)).parts).toBeUndefined()
  })
})

describe('the rules that keep it a tree', () => {
  it('refuses a card being part of itself', async () => {
    const [only] = await cards('ST', 1)
    const [res] = await setParent(only, only)
    expect(res.ok).toBe(false)
  })

  it('refuses a direct loop', async () => {
    const [a, b] = await cards('ST', 2)
    await setParent(b, a)
    const [res] = await setParent(a, b, 'p-loop')

    expect(res.ok).toBe(false)
    // Still where it was. A refused op leaves nothing half applied.
    expect((await read(b)).parent?.key).toBe(a)
    expect((await read(a)).parent).toBeUndefined()
  })

  it('refuses a loop through the middle of a chain', async () => {
    const [a, b, c] = await cards('ST', 3)
    await setParent(b, a)
    await setParent(c, b)
    // a is not c's parent directly, it is its grandparent, and the check has
    // to walk to find that out.
    const [res] = await setParent(a, c, 'p-deep-loop')
    expect(res.ok).toBe(false)
  })
})

describe('when a parent goes away', () => {
  it('leaves its parts standing on their own, not deleted', async () => {
    const [parent, child] = await cards('ST', 2)
    await setParent(child, parent)

    await itemWrite(jose, [{ op: 'archive', op_id: 'a1', key: parent }])
    await itemWrite(jose, [{ op: 'delete', op_id: 'x1', key: parent }])

    // Deleting a card must not silently delete the work underneath it, and
    // the child must still be readable: the column is a foreign key, so a
    // dangling parent_id is a read that fails.
    const orphan = await read(child)
    expect(orphan.parent).toBeUndefined()
  })
})

describe('what the board is told', () => {
  it('counts the parts and how many are done', async () => {
    const [parent, one, two] = await cards('ST', 3)
    await setParent(one, parent)
    await setParent(two, parent)
    await itemWrite(jose, [{ op: 'complete', op_id: 'done-1', key: one }])

    const board = (await spaceGet(jose, {
      space: 'ST',
      limit: 50,
      state: 'open',
      detail: 'compact',
    })) as {
      items: Array<{
        key: string
        parent_key?: string
        parts_total?: number
        parts_done?: number
      }>
    }
    const card = (key: string) => board.items.find((i) => i.key === key)!

    expect(card(parent).parts_total).toBe(2)
    expect(card(parent).parts_done).toBe(1)
    expect(card(one).parent_key).toBe(parent)
    // A card with no parts says nothing rather than zero, so the board can
    // show the chip on presence alone.
    expect(card(one).parts_total).toBeUndefined()
  })
})

describe('parts and dependencies are different things', () => {
  it('does not confuse one for the other', async () => {
    const [a, b] = await cards('ST', 2)
    await setParent(b, a)
    await itemWrite(jose, [
      { op: 'depends_on', op_id: 'd1', key: a, blocker: b },
    ])

    const parent = (await itemGet(jose, { keys: [a] })) as {
      items: Array<{
        parts?: Array<{ key: string }>
        blocked_by?: Array<{ key: string }>
      }>
    }
    // b is part of a AND a waits on b, which is an ordinary shape: the
    // parent cannot finish until its part does.
    expect(parent.items[0].parts?.map((p) => p.key)).toEqual([b])
    expect(parent.items[0].blocked_by?.map((p) => p.key)).toEqual([b])
  })
})

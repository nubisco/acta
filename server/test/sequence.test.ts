/**
 * The order work has to happen in.
 *
 * A timeline needs dates and software rarely has them; people know that one
 * card blocks another long before anyone commits to a Tuesday. So this is
 * built from dependencies, and these pin the two numbers that come out of
 * it: which layer a card sits in, and which chain decides the finish.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { sequenceGet } from '../src/services/sequence'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let ctx: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  const workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const actor = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0]
  ctx = {
    db,
    workspaceId,
    actor: {
      id: actor.id,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
  await spaceWrite(ctx, [
    {
      op: 'create',
      op_id: 'b1',
      key: 'ST',
      name: 'Stagewright',
      template: 'kanban6',
    },
  ])
})

/** Create n cards named A, B, C… in Backlog. */
async function cards(n: number): Promise<string[]> {
  const names = 'ABCDEFGH'.slice(0, n).split('')
  await itemWrite(
    ctx,
    names.map((t, i) => ({
      op: 'create' as const,
      op_id: `i${i}`,
      list: 'Backlog',
      title: t,
    })),
    'ST',
  )
  return names.map((_, i) => `ST-${i + 1}`)
}

const dep = (blocked: string, blocker: string, id = `${blocked}<${blocker}`) =>
  itemWrite(ctx, [{ op: 'depends_on', op_id: id, key: blocked, blocker }], 'ST')

describe('sequence', () => {
  it('puts everything unblocked in the first layer', async () => {
    const [a, b, c] = await cards(3)
    await dep(b, a)
    await dep(c, b)

    const { nodes, layers } = await sequenceGet(ctx, 'ST')
    const layerOf = new Map(nodes.map((n) => [n.key, n.layer]))
    expect(layerOf.get(a)).toBe(0)
    expect(layerOf.get(b)).toBe(1)
    expect(layerOf.get(c)).toBe(2)
    expect(layers).toBe(3)
  })

  it('waits for every blocker, not just the first', async () => {
    const [a, b, c] = await cards(3)
    // C waits on both A and B, so it cannot sit beside B.
    await dep(c, a)
    await dep(c, b)

    const nodes = (await sequenceGet(ctx, 'ST')).nodes
    const layerOf = new Map(nodes.map((n) => [n.key, n.layer]))
    expect(layerOf.get(a)).toBe(0)
    expect(layerOf.get(b)).toBe(0)
    expect(layerOf.get(c)).toBe(1)
    expect(nodes.find((n) => n.key === c)!.blocked_by.sort()).toEqual(
      [a, b].sort(),
    )
  })

  /**
   * The point of the whole exercise: the longest chain by size is the one
   * that decides the finish, and it is not always the one with most cards.
   */
  it('marks the chain that decides the finish, by size not by count', async () => {
    const [a, b, c, d] = await cards(4)
    // A -> B -> D is three cards but small. A -> C -> D is two steps and big.
    await dep(b, a)
    await dep(c, a)
    await dep(d, b)
    await dep(d, c)
    await itemWrite(
      ctx,
      [
        { op: 'size', op_id: 's-a', key: a, size: 1 },
        { op: 'size', op_id: 's-b', key: b, size: 1 },
        { op: 'size', op_id: 's-c', key: c, size: 8 },
        { op: 'size', op_id: 's-d', key: d, size: 1 },
      ],
      'ST',
    )

    const { nodes, critical_size } = await sequenceGet(ctx, 'ST')
    const critical = nodes.filter((n) => n.critical).map((n) => n.key)
    expect(critical.sort()).toEqual([a, c, d].sort())
    expect(critical).not.toContain(b)
    expect(critical_size).toBe(10)
  })

  // A finished card that still blocked its successors would hold the chain
  // back forever. A plan is about what is left.
  it('drops finished work and frees what it was blocking', async () => {
    const [a, b] = await cards(2)
    await dep(b, a)
    await itemWrite(ctx, [{ op: 'complete', op_id: 'done-a', key: a }], 'ST')

    const { nodes } = await sequenceGet(ctx, 'ST')
    expect(nodes.map((n) => n.key)).toEqual([b])
    expect(nodes[0].layer).toBe(0)
    expect(nodes[0].blocked_by).toEqual([])
  })

  it('refuses an edge that would close a loop', async () => {
    const [a, b, c] = await cards(3)
    await dep(b, a)
    await dep(c, b)

    const res = await itemWrite(
      ctx,
      [{ op: 'depends_on', op_id: 'loop', key: a, blocker: c }],
      'ST',
    )
    expect(res[0].ok).toBe(false)
    expect((res[0] as { error: string }).error).toContain('already waits')

    // And the plan is still readable, which is the point of refusing early.
    expect((await sequenceGet(ctx, 'ST')).nodes).toHaveLength(3)
  })

  it('refuses a card blocking itself', async () => {
    const [a] = await cards(1)
    const res = await itemWrite(
      ctx,
      [{ op: 'depends_on', op_id: 'self', key: a, blocker: a }],
      'ST',
    )
    expect(res[0].ok).toBe(false)
    expect((res[0] as { error: string }).error).toContain('cannot block itself')
  })

  it('treats an unsized card as taking a position rather than none', async () => {
    const [a, b] = await cards(2)
    await dep(b, a)
    const { critical_size } = await sequenceGet(ctx, 'ST')
    // Two unsized cards in a chain are two steps, not zero.
    expect(critical_size).toBe(2)
  })
})

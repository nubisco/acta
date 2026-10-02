/**
 * Label groups that name a single answer, and groups with an order.
 *
 * Jose asked for custom fields, with "affects version" and "fixes version"
 * as the example. Most of that was already here: a label group is scoped to
 * a space, so a version group on the Stagewright board never appears on
 * Marketing. What was missing is the two things that make a group a field
 * rather than a bag of tags.
 *
 * **Exclusive**, because one release contains the fix. **Ordered**, because
 * 1.9.0 comes before 1.11.0 and sorting by name says otherwise, which is the
 * single most convincing argument that versions are not strings.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { labelWrite } from '../src/services/labels'
import { itemGet, workspaceOverview } from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let jose: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  const workspaceId = await bootstrapWorkspace(db, {
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
    [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
    'ST',
  )
})

/** A version group on the Stagewright board, as Jose described it. */
async function versionGroups(): Promise<void> {
  await labelWrite(jose, [
    {
      op: 'group_create',
      op_id: 'g1',
      name: 'Fixes version',
      space: 'ST',
      exclusive: true,
    },
    { op: 'group_create', op_id: 'g2', name: 'Affects version', space: 'ST' },
  ])
  const versions = ['1.9.0', '1.11.0', '1.12.0']
  await labelWrite(
    jose,
    versions.flatMap((v, i) => [
      {
        op: 'label_create' as const,
        op_id: `f-${v}`,
        group: 'Fixes version',
        name: v,
        color: 'blue',
        pos: (i + 1) * 1024,
      },
      {
        op: 'label_create' as const,
        op_id: `a-${v}`,
        group: 'Affects version',
        name: v,
        color: 'orange',
        pos: (i + 1) * 1024,
      },
    ]),
  )
}

const labelsOn = async (key: string) =>
  (
    (await itemGet(jose, { keys: [key] })) as {
      items: Array<{ labels?: string[] }>
    }
  ).items[0].labels ?? []

describe('a group that names one answer', () => {
  it('replaces rather than accumulating', async () => {
    await versionGroups()
    await itemWrite(jose, [
      { op: 'label', op_id: 'l1', key: 'ST-1', add: ['Fixes version/1.11.0'] },
    ])
    await itemWrite(jose, [
      { op: 'label', op_id: 'l2', key: 'ST-1', add: ['Fixes version/1.12.0'] },
    ])

    const on = await labelsOn('ST-1')
    expect(on.filter((l) => l.includes('1.1'))).toHaveLength(1)
    expect(on.some((l) => l.includes('1.12.0'))).toBe(true)
    expect(on.some((l) => l.includes('1.11.0'))).toBe(false)
  })

  it('does not refuse the second pick', async () => {
    // Picking a second value means somebody changed their mind. Refusing
    // would make them clear the old one first for no reason.
    await versionGroups()
    await itemWrite(jose, [
      { op: 'label', op_id: 'l1', key: 'ST-1', add: ['Fixes version/1.11.0'] },
    ])
    const [res] = await itemWrite(jose, [
      { op: 'label', op_id: 'l2', key: 'ST-1', add: ['Fixes version/1.12.0'] },
    ])
    expect(res.ok).toBe(true)
  })

  it('leaves an ordinary group alone', async () => {
    await versionGroups()
    await itemWrite(jose, [
      {
        op: 'label',
        op_id: 'l1',
        key: 'ST-1',
        add: ['Affects version/1.9.0', 'Affects version/1.11.0'],
      },
    ])
    // A bug affects several releases. That is the default and stays it.
    expect((await labelsOn('ST-1')).sort()).toEqual(['1.11.0', '1.9.0'])
  })

  it('does not reach across groups', async () => {
    await versionGroups()
    await itemWrite(jose, [
      {
        op: 'label',
        op_id: 'l1',
        key: 'ST-1',
        add: ['Fixes version/1.12.0', 'Affects version/1.9.0'],
      },
    ])
    expect(await labelsOn('ST-1')).toHaveLength(2)
  })

  it('can be turned on later without pruning what is already there', async () => {
    await labelWrite(jose, [
      { op: 'group_create', op_id: 'g1', name: 'Phase', space: 'ST' },
      {
        op: 'label_create',
        op_id: 'l1',
        group: 'Phase',
        name: 'Alpha',
        color: 'blue',
      },
      {
        op: 'label_create',
        op_id: 'l2',
        group: 'Phase',
        name: 'Beta',
        color: 'green',
      },
    ])
    await itemWrite(jose, [
      {
        op: 'label',
        op_id: 'x1',
        key: 'ST-1',
        add: ['Phase/Alpha', 'Phase/Beta'],
      },
    ])

    await labelWrite(jose, [
      { op: 'group_update', op_id: 'g2', group: 'Phase', exclusive: true },
    ])

    // Quietly deleting somebody's data to satisfy a setting is not a thing a
    // settings screen should do. The next edit of the card settles it.
    expect(await labelsOn('ST-1')).toHaveLength(2)
    await itemWrite(jose, [
      { op: 'label', op_id: 'x2', key: 'ST-1', add: ['Phase/Beta'] },
    ])
    expect(await labelsOn('ST-1')).toHaveLength(1)
  })
})

describe('a group with an order', () => {
  it('comes back in it, not alphabetically', async () => {
    await versionGroups()
    const seen = (await workspaceOverview(jose)) as {
      labels: Array<{ group_name: string; name: string }>
    }
    const fixes = seen.labels
      .filter((l) => l.group_name === 'Fixes version')
      .map((l) => l.name)

    // Sorted by name this is 1.11.0, 1.12.0, 1.9.0, which is why versions
    // are not strings.
    expect(fixes).toEqual(['1.9.0', '1.11.0', '1.12.0'])
  })

  it('takes a whole new order in one op', async () => {
    await versionGroups()
    await labelWrite(jose, [
      {
        op: 'label_reorder',
        op_id: 'r1',
        group: 'Fixes version',
        labels: [
          'Fixes version/1.12.0',
          'Fixes version/1.9.0',
          'Fixes version/1.11.0',
        ],
      },
    ])
    const seen = (await workspaceOverview(jose)) as {
      labels: Array<{ group_name: string; name: string }>
    }
    expect(
      seen.labels
        .filter((l) => l.group_name === 'Fixes version')
        .map((l) => l.name),
    ).toEqual(['1.12.0', '1.9.0', '1.11.0'])
  })

  it('keeps an unarranged group by name, and puts a stray label last', async () => {
    await labelWrite(jose, [
      { op: 'group_create', op_id: 'g1', name: 'Phase', space: 'ST' },
      {
        op: 'label_create',
        op_id: 'l1',
        group: 'Phase',
        name: 'Zeta',
        color: 'blue',
      },
      {
        op: 'label_create',
        op_id: 'l2',
        group: 'Phase',
        name: 'Alpha',
        color: 'green',
      },
    ])
    const byName = (await workspaceOverview(jose)) as {
      labels: Array<{ group_name: string; name: string }>
    }
    expect(
      byName.labels.filter((l) => l.group_name === 'Phase').map((l) => l.name),
    ).toEqual(['Alpha', 'Zeta'])

    // Arrange one of them and the unplaced one goes to the end rather than
    // the front, which is what NULLs would do by default.
    await labelWrite(jose, [
      { op: 'label_update', op_id: 'u1', label: 'Phase/Zeta', pos: 10 },
    ])
    const arranged = (await workspaceOverview(jose)) as {
      labels: Array<{ group_name: string; name: string }>
    }
    expect(
      arranged.labels
        .filter((l) => l.group_name === 'Phase')
        .map((l) => l.name),
    ).toEqual(['Zeta', 'Alpha'])
  })
})

describe('what the browser is told', () => {
  it('says which groups name a single answer', async () => {
    await versionGroups()
    const seen = (await workspaceOverview(jose)) as {
      labels: Array<{ group_name: string; exclusive?: true }>
    }
    const fixes = seen.labels.find((l) => l.group_name === 'Fixes version')
    const affects = seen.labels.find((l) => l.group_name === 'Affects version')

    expect(fixes?.exclusive).toBe(true)
    // Absent rather than false, the way every other flag in this payload
    // reads, so a group that behaves as it always did says nothing.
    expect(affects?.exclusive).toBeUndefined()
  })
})

describe('telling two groups apart on a card', () => {
  it('returns ids, because the same value lives in both groups', async () => {
    await versionGroups()
    await itemWrite(jose, [
      {
        op: 'label',
        op_id: 'l1',
        key: 'ST-1',
        add: ['Affects version/1.12.0', 'Fixes version/1.12.0'],
      },
    ])

    const card = (
      (await itemGet(jose, { keys: ['ST-1'] })) as {
        items: Array<{ labels?: string[]; label_ids?: string[] }>
      }
    ).items[0]

    // The names alone are indistinguishable, which is the whole problem:
    // without the ids this card says 1.12.0 twice and means two different
    // things by it.
    expect(card.labels).toEqual(['1.12.0', '1.12.0'])
    expect(card.label_ids).toHaveLength(2)
    expect(new Set(card.label_ids).size).toBe(2)
  })

  it('resolves a qualified reference to the right group', async () => {
    await versionGroups()
    await itemWrite(jose, [
      { op: 'label', op_id: 'l1', key: 'ST-1', add: ['Fixes version/1.12.0'] },
    ])
    const ids = (
      (await itemGet(jose, { keys: ['ST-1'] })) as {
        items: Array<{ label_ids?: string[] }>
      }
    ).items[0].label_ids!
    const group = (
      await db.query<{ name: string }>(
        `SELECT g.name FROM label l JOIN label_group g ON g.id = l.group_id
          WHERE l.id = ?`,
        [ids[0]],
      )
    )[0]
    expect(group.name).toBe('Fixes version')
  })
})

describe('two boards each wanting their own version group', () => {
  beforeEach(async () => {
    await spaceWrite(jose, [
      {
        op: 'create',
        op_id: 'b2',
        key: 'AC',
        name: 'Acta',
        template: 'kanban6',
      },
    ])
    await labelWrite(jose, [
      {
        op: 'group_create',
        op_id: 'g1',
        name: 'Fixes version',
        space: 'ST',
        exclusive: true,
      },
      {
        op: 'group_create',
        op_id: 'g2',
        name: 'Fixes version',
        space: 'AC',
        exclusive: true,
      },
    ])
  })

  it('refuses an ambiguous name instead of picking one', async () => {
    // A group is scoped to a space precisely so each product board carries
    // its own versions, so a second product guarantees this collision.
    // Guessing would write the label into the wrong board's vocabulary.
    const [res] = await labelWrite(jose, [
      {
        op: 'label_create',
        op_id: 'l1',
        group: 'Fixes version',
        name: '1.0.0',
        color: 'blue',
      },
    ])
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('more than one')
  })

  it('says how to disambiguate', async () => {
    const [res] = await labelWrite(jose, [
      {
        op: 'label_create',
        op_id: 'l1',
        group: 'Fixes version',
        name: '1.0.0',
        color: 'blue',
      },
    ])
    expect((res as { error: string }).error).toContain('SPACE/')
  })

  it('takes SPACE/Name', async () => {
    const [res] = await labelWrite(jose, [
      {
        op: 'label_create',
        op_id: 'l1',
        group: 'ST/Fixes version',
        name: '1.0.0',
        color: 'blue',
      },
    ])
    expect(res.ok).toBe(true)

    const where = await db.query<{ key: string }>(
      `SELECT b.key FROM label l JOIN label_group g ON g.id = l.group_id
           JOIN space b ON b.id = g.space_id WHERE l.name = ?`,
      ['1.0.0'],
    )
    expect(where.map((w) => w.key)).toEqual(['ST'])
  })

  it('takes a group id, which is what the catalogue hands the browser', async () => {
    const seen = (await workspaceOverview(jose)) as {
      labels: Array<{
        group_id: string
        group_name: string
        space_key: string | null
      }>
    }
    // The catalogue carries the id for exactly this reason.
    await labelWrite(jose, [
      {
        op: 'label_create',
        op_id: 'seed',
        group: 'AC/Fixes version',
        name: '2.0.0',
        color: 'blue',
      },
    ])
    const after = (await workspaceOverview(jose)) as {
      labels: Array<{ group_id: string; space_key: string | null }>
    }
    const acta = after.labels.find((l) => l.space_key === 'AC')!
    expect(acta.group_id).toBeTruthy()

    const [res] = await labelWrite(jose, [
      {
        op: 'group_update',
        op_id: 'u1',
        group: acta.group_id,
        name: 'Shipped in',
      },
    ])
    expect(res.ok).toBe(true)
    expect(seen.labels.length >= 0).toBe(true)
  })
})

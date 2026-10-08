/**
 * What a board card needs to show, read in one go.
 *
 * Asked for by Jose on 2026-10-08: MA-16 served G-6 and only the inspector
 * said so. Cards now keep one shape (summary, goal, labels, a fixed footer),
 * so the board read carries the summary, size, open blockers, attachment
 * count and goals, and only when asked, because agents read spaces compact.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { goalWrite } from '../src/services/goals'
import { descriptionSummary, spaceGet } from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let jose: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  const workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
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
      op_id: 's',
      key: 'MA',
      name: 'Marketing',
      template: 'kanban6',
    },
  ])
  await itemWrite(
    jose,
    [
      {
        op: 'create',
        op_id: 'c1',
        list: 'Backlog',
        title: 'Epic',
        description:
          '## Scope\n\nShip the **home** page, see [the spec](https://x.y).',
      },
      { op: 'create', op_id: 'c2', list: 'Backlog', title: 'Part' },
      { op: 'create', op_id: 'c3', list: 'Backlog', title: 'Blocker' },
    ],
    'MA',
  )
})

async function board(detail: 'compact' | 'board' = 'board') {
  const { items } = await spaceGet(jose, {
    space: 'MA',
    state: 'open',
    detail,
    limit: 100,
  })
  return new Map(items.map((i) => [i.key, i as Record<string, unknown>]))
}

describe('a board read', () => {
  it('names the goals a card serves, its own and its parent’s', async () => {
    await goalWrite(jose, [
      { op: 'create', op_id: 'g1', title: 'Shipped and selling' },
      { op: 'create', op_id: 'g2', title: 'One voice' },
      { op: 'link', op_id: 'l1', goal: 1, add: ['MA-1'] },
      { op: 'link', op_id: 'l2', goal: 2, add: ['MA-2'] },
    ])
    await itemWrite(jose, [
      { op: 'set_parent', op_id: 'p', key: 'MA-2', parent: 'MA-1' },
    ])
    const cards = await board()
    expect(cards.get('MA-1')!.goals).toEqual([
      {
        number: 1,
        key: 'G-1',
        title: 'Shipped and selling',
        status: 'pending',
      },
    ])
    // Its own goal first, then the one it inherits from what it is part of.
    expect(
      (cards.get('MA-2')!.goals as { key: string }[]).map((g) => g.key),
    ).toEqual(['G-2', 'G-1'])
    expect(cards.get('MA-3')!.goals).toBeUndefined()
  })

  it('carries the summary, size, open blockers and attachments', async () => {
    await itemWrite(jose, [
      { op: 'size', op_id: 'z', key: 'MA-1', size: 3 },
      { op: 'depends_on', op_id: 'd', key: 'MA-1', blocker: 'MA-3' },
    ])
    await db.run(
      `INSERT INTO attachment (id, workspace_id, owner_kind, owner_id, kind, filename, url, actor_id, created_at)
       SELECT 'att_1', workspace_id, 'item', id, 'url', 'spec', 'https://x.y', created_by, 0 FROM item WHERE key = 'MA-1'`,
    )
    let card = (await board()).get('MA-1')!
    expect(card.summary).toBe('Scope')
    expect(card.size).toBe(3)
    expect(card.blocked_by).toEqual(['MA-3'])
    expect(card.atts).toBe(1)

    // A finished blocker no longer holds anything up.
    await itemWrite(jose, [{ op: 'complete', op_id: 'done', key: 'MA-3' }])
    card = (await board()).get('MA-1')!
    expect(card.blocked_by).toBeUndefined()
  })

  it('stays compact for agents unless asked', async () => {
    await goalWrite(jose, [
      { op: 'create', op_id: 'g1', title: 'x' },
      { op: 'link', op_id: 'l1', goal: 1, add: ['MA-1'] },
    ])
    const card = (await board('compact')).get('MA-1')!
    for (const field of ['summary', 'size', 'blocked_by', 'atts', 'goals'])
      expect(card).not.toHaveProperty(field)
  })
})

describe('a description summary', () => {
  it('is the first line that says something, without its markup', () => {
    expect(descriptionSummary('## Scope\n\nShip it')).toBe('Scope')
    expect(descriptionSummary('\n- [ ] **Add** the `opt-in`')).toBe(
      'Add the opt-in',
    )
    expect(descriptionSummary('See [the spec](https://x.y) and [[ST-4]]')).toBe(
      'See the spec and ST-4',
    )
    expect(descriptionSummary('```ts\nconst a = 1\n```\nAfter the code')).toBe(
      'After the code',
    )
    expect(descriptionSummary('---\n> quoted *words*')).toBe('quoted words')
  })

  it('leaves snake_case and lone asterisks alone', () => {
    expect(descriptionSummary('Pass op_id on every write * always')).toBe(
      'Pass op_id on every write * always',
    )
  })

  it('is empty for an empty description and cut when long', () => {
    expect(descriptionSummary('')).toBe('')
    expect(descriptionSummary(null)).toBe('')
    expect(descriptionSummary('x'.repeat(300))).toHaveLength(160)
  })
})

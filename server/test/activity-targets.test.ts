/**
 * What an activity row opens.
 *
 * The feed stores `entity_id`, which is an internal id. It is no use to a
 * browser and no use to a person: the summaries talk about ST-1 and about
 * spec, so the feed has to hand back ST-1 and spec. Without them every line
 * in the Activity view is dead text, which is exactly how it shipped.
 *
 * The join is the part that can go quietly wrong: a wrong condition returns
 * rows with every target null and the page still renders, just inert.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { docWrite } from '../src/services/docs'
import { activityQuery } from '../src/services/reads'
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
})

const feed = async (params: Record<string, unknown> = {}) =>
  (
    (await activityQuery(jose, {
      limit: 50,
      ...params,
    } as never)) as {
      events: Array<{
        verb: string
        summary: string
        item_key?: string
        doc_slug?: string
      }>
    }
  ).events

describe('an activity row knows what it is about', () => {
  it('carries the card key, not an internal id', async () => {
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    const created = (await feed()).find((e) => e.verb === 'item.created')
    expect(created?.item_key).toBe('ST-1')
    expect(created?.doc_slug).toBeUndefined()
  })

  it('carries the document slug', async () => {
    await docWrite(jose, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'spec',
        title: 'Spec',
        body: 'hello',
        layout: 'default',
        tags: [],
      },
    ])
    const created = (await feed()).find((e) => e.verb === 'doc.created')
    expect(created?.doc_slug).toBe('spec')
    expect(created?.item_key).toBeUndefined()
  })

  it('leaves both empty for an event that is about neither', async () => {
    // A label or a space event opens nothing in particular, and saying so is
    // what stops the browser rendering a control that goes nowhere.
    const spaceCreated = (await feed()).find((e) => e.verb === 'space.created')
    expect(spaceCreated).toBeDefined()
    expect(spaceCreated?.item_key).toBeUndefined()
    expect(spaceCreated?.doc_slug).toBeUndefined()
  })

  it('still filters, now that every column is qualified', async () => {
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    // The join introduced a second `id` and a second `workspace_id` into the
    // query. An unqualified filter is ambiguous, and SQLite would rather
    // guess than complain.
    expect(await feed({ verb: 'item.*' })).not.toHaveLength(0)
    expect((await feed({ actor: 'jose' })).length).toBeGreaterThan(0)
    expect(await feed({ actor_kind: 'agent' })).toHaveLength(0)
  })

  it('pages without losing the target', async () => {
    for (let n = 0; n < 3; n += 1) {
      await itemWrite(
        jose,
        [{ op: 'create', op_id: `i${n}`, list: 'To Do', title: `Card ${n}` }],
        'ST',
      )
    }
    const firstPage = (await activityQuery(jose, { limit: 2 } as never)) as {
      events: Array<{ item_key?: string }>
      cursor?: string
    }
    expect(firstPage.cursor).toBeDefined()
    const second = (await activityQuery(jose, {
      limit: 50,
      cursor: firstPage.cursor,
    } as never)) as { events: Array<{ verb: string; item_key?: string }> }
    const created = second.events.filter((e) => e.verb === 'item.created')
    expect(created.length).toBeGreaterThan(0)
    expect(created.every((e) => typeof e.item_key === 'string')).toBe(true)
  })
})

/**
 * The moments that told nobody.
 *
 * Every case here is a thing a person would expect to hear about and did
 * not. Documents were the worst of it: a comment on a page produced zero
 * notifications however many people were named in it, because the write
 * passed no body for mentions to be found in and the recipient lookup only
 * understood cards. Being taken off a card was the other kind of hole, one
 * involvement cannot close by design, since by the time the event is emitted
 * the person is no longer on the card to be found.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { docWrite } from '../src/services/docs'
import { notificationList } from '../src/services/notifications'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let workspaceId: string

const ctxFor = (id: string, handle: string): ICtx => ({
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

let jose: ICtx
let ivan: ICtx
let daniela: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const id = async (handle: string, email: string) => {
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM actor WHERE handle = ?',
      [handle],
    )
    if (existing[0]) return existing[0].id
    const newId = `act_${handle}`
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, 'member', ?)`,
      [newId, workspaceId, handle, handle, email, Date.now()],
    )
    return newId
  }
  jose = ctxFor(await id('jose', 'jose@nubisco.io'), 'jose')
  ivan = ctxFor(await id('ivan', 'ivan@nubisco.io'), 'ivan')
  daniela = ctxFor(await id('daniela', 'daniela@nubisco.io'), 'daniela')

  await spaceWrite({ ...jose, actor: { ...jose.actor, role: 'admin' } }, [
    {
      op: 'create',
      op_id: 'b1',
      key: 'ST',
      name: 'Stagewright',
      template: 'kanban6',
    },
  ])
})

const inbox = async (who: ICtx) => (await notificationList(who)).notifications
const verbs = async (who: ICtx) => (await inbox(who)).map((n) => n.verb)

describe('documents', () => {
  it('tells someone named in a comment on a page', async () => {
    await docWrite(jose, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'spec',
        title: 'Spec',
        body: '# Spec',
        layout: 'default',
        tags: [],
      },
    ])
    await docWrite(jose, [
      {
        op: 'comment',
        op_id: 'd2',
        ref: 'spec',
        body: 'does this hold up, [[@ivan]]?',
      },
    ])

    const got = await inbox(ivan)
    expect(got).toHaveLength(1)
    expect(got[0].reason).toBe('mention')
    expect(got[0].verb).toBe('comment.created')
    // The inbox has to be able to open the thing it is talking about, and a
    // document is not addressed by an item key.
    expect(got[0].doc_slug).toBe('spec')
    expect(got[0].item_key).toBeNull()
  })

  it('tells someone named in the body of a page', async () => {
    await docWrite(jose, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'spec',
        title: 'Spec',
        body: 'owner: [[@daniela]]',
        layout: 'default',
        tags: [],
      },
    ])
    expect(await verbs(daniela)).toEqual(['doc.created'])
  })

  it('tells someone named by an edit, and only them, and only once', async () => {
    await docWrite(jose, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'spec',
        title: 'Spec',
        body: 'owner: [[@daniela]]',
        layout: 'default',
        tags: [],
      },
    ])
    const rev = (
      await db.query<{ rev: number }>(
        'SELECT rev FROM document WHERE slug = ?',
        ['spec'],
      )
    )[0].rev

    await docWrite(jose, [
      {
        op: 'replace',
        op_id: 'd2',
        ref: 'spec',
        if_rev: rev,
        body: 'owner: [[@daniela]], reviewer: [[@ivan]]',
      },
    ])

    // Ivan is new to the page, so he hears about it.
    expect(await verbs(ivan)).toEqual(['doc.updated'])
    // Daniela was already named and is named again. Saving a page must not
    // ring for everyone in it every time.
    expect(await verbs(daniela)).toEqual(['doc.created'])
  })

  it('stays quiet about a page being saved when nobody new is named', async () => {
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
    await docWrite(ivan, [
      { op: 'comment', op_id: 'd2', ref: 'spec', body: 'looks fine' },
    ])
    const rev = (
      await db.query<{ rev: number }>(
        'SELECT rev FROM document WHERE slug = ?',
        ['spec'],
      )
    )[0].rev
    await docWrite(daniela, [
      {
        op: 'replace',
        op_id: 'd3',
        ref: 'spec',
        if_rev: rev,
        body: 'hello, again',
      },
    ])

    // Ivan commented, so he is part of the conversation. He is not part of
    // every subsequent edit, which is the difference between a document and
    // a card: pages get saved dozens of times a day.
    expect(await verbs(ivan)).toEqual([])
  })

  it('tells the people already talking on a page about a new comment', async () => {
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
    await docWrite(ivan, [
      { op: 'comment', op_id: 'd2', ref: 'spec', body: 'first' },
    ])
    await docWrite(daniela, [
      { op: 'comment', op_id: 'd3', ref: 'spec', body: 'second' },
    ])

    const got = await inbox(ivan)
    expect(got.map((n) => n.verb)).toEqual(['comment.created'])
    expect(got[0].reason).toBe('involved')
    // Daniela wrote it. Nobody is told what they just did.
    expect(await verbs(daniela)).toEqual([])
  })

  it('tells the author when their comment is resolved', async () => {
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
    const written = await docWrite(ivan, [
      { op: 'comment', op_id: 'd2', ref: 'spec', body: 'is this right?' },
    ])
    const commentId = (written[0] as { id: string }).id

    await docWrite(jose, [
      {
        op: 'comment_resolve',
        op_id: 'd3',
        ref: 'spec',
        comment_id: commentId,
        resolved: true,
      },
    ])

    // Just the one: he wrote the comment himself, and nobody is told what
    // they just did.
    expect(await verbs(ivan)).toEqual(['comment.resolved'])
  })
})

describe('assignment', () => {
  const card = async (opId: string) => {
    const res = await itemWrite(
      jose,
      [{ op: 'create', op_id: opId, list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    return (res[0] as { key: string }).key
  }

  it('tells the person taken off a card', async () => {
    const key = await card('i1')
    await itemWrite(jose, [{ op: 'assign', op_id: 'a1', key, add: ['ivan'] }])
    await itemWrite(jose, [
      { op: 'assign', op_id: 'a2', key, remove: ['ivan'] },
    ])

    // Involvement alone can never produce this one: the DELETE has already
    // run by the time the event is emitted, so he is not on the card to be
    // found.
    expect(await verbs(ivan)).toContain('item.unassigned')
  })

  it('tells the person put on a card that it is theirs', async () => {
    const key = await card('i1')
    await itemWrite(jose, [
      { op: 'assign', op_id: 'a1', key, add: ['daniela'] },
    ])
    const got = await inbox(daniela)
    expect(got[0].verb).toBe('item.assigned')
    expect(got[0].reason).toBe('assigned')
    expect(got[0].item_key).toBe(key)
  })
})

describe('dependencies', () => {
  it('tells whoever holds the blocker that work is queued behind them', async () => {
    const one = (
      (
        await itemWrite(
          jose,
          [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Foundation' }],
          'ST',
        )
      )[0] as { key: string }
    ).key
    const two = (
      (
        await itemWrite(
          jose,
          [{ op: 'create', op_id: 'i2', list: 'To Do', title: 'Roof' }],
          'ST',
        )
      )[0] as { key: string }
    ).key
    await itemWrite(jose, [
      { op: 'assign', op_id: 'a1', key: one, add: ['ivan'] },
    ])

    await itemWrite(jose, [
      { op: 'depends_on', op_id: 'd1', key: two, blocker: one },
    ])
    expect(await verbs(ivan)).toContain('item.blocked')

    await itemWrite(jose, [
      { op: 'undepend', op_id: 'd2', key: two, blocker: one },
    ])
    expect(await verbs(ivan)).toContain('item.unblocked')
  })
})

describe('comment edits', () => {
  it('tells someone added to a comment by editing it', async () => {
    const key = (
      (
        await itemWrite(
          jose,
          [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
          'ST',
        )
      )[0] as { key: string }
    ).key
    const written = await itemWrite(jose, [
      { op: 'comment', op_id: 'c1', key, body: 'needs a look' },
    ])
    const commentId = (written[0] as { id: string }).id

    await itemWrite(jose, [
      {
        op: 'comment_update',
        op_id: 'c2',
        key,
        comment_id: commentId,
        body: 'needs a look, [[@daniela]]',
      },
    ])

    const got = await inbox(daniela)
    expect(got.map((n) => n.verb)).toEqual(['comment.updated'])
    expect(got[0].reason).toBe('mention')
  })
})

describe('the face on a row', () => {
  it('says who caused it, so the inbox is not a wall of anonymous sentences', async () => {
    const key = (
      (
        await itemWrite(
          jose,
          [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
          'ST',
        )
      )[0] as { key: string }
    ).key
    await itemWrite(daniela, [
      { op: 'comment', op_id: 'c1', key, body: 'over to you [[@ivan]]' },
    ])

    const got = await inbox(ivan)
    expect(got[0].actor_handle).toBe('daniela')
    expect(got[0].actor_name).toBe('daniela')
  })
})

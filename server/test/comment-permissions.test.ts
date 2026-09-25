/**
 * Who may change a comment after it is written.
 *
 * `comment_update` shipped checking nothing: anybody with write scope could
 * rewrite anybody's comment, and it would still carry the original author's
 * name and face. That is putting words in someone's mouth, and it was
 * reachable by every member and every personal access token.
 *
 * Deleting is the workspace's call, which is the part that is configurable.
 * Editing is not, and is not meant to become so.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { docWrite } from '../src/services/docs'
import { itemGet, docGet } from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let workspaceId: string

const ctxFor = (
  id: string,
  handle: string,
  role: 'admin' | 'member' = 'member',
): ICtx => ({
  db,
  workspaceId,
  actor: { id, kind: 'human', handle, role, scopes: ['read', 'write'] },
})

let admin: ICtx
let ivan: ICtx
let daniela: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const id = async (handle: string) => {
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM actor WHERE handle = ?',
      [handle],
    )
    if (existing[0]) return existing[0].id
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, 'member', ?)`,
      [
        `act_${handle}`,
        workspaceId,
        handle,
        handle,
        `${handle}@nubisco.io`,
        Date.now(),
      ],
    )
    return `act_${handle}`
  }
  admin = ctxFor(await id('jose'), 'jose', 'admin')
  ivan = ctxFor(await id('ivan'), 'ivan')
  daniela = ctxFor(await id('daniela'), 'daniela')

  await spaceWrite(admin, [
    {
      op: 'create',
      op_id: 'b1',
      key: 'ST',
      name: 'Stagewright',
      template: 'kanban6',
    },
  ])
  await itemWrite(
    admin,
    [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
    'ST',
  )
})

/** Ivan's comment on ST-1, which is what the rules are applied to. */
async function ivansComment(): Promise<string> {
  const res = await itemWrite(ivan, [
    { op: 'comment', op_id: `c${Math.random()}`, key: 'ST-1', body: 'mine' },
  ])
  return (res[0] as { id: string }).id
}

const commentsFor = async (who: ICtx) =>
  (
    (await itemGet(who, { keys: ['ST-1'], include: ['comments'] })) as {
      items: Array<{
        comments: Array<{
          id: string
          edited?: number
          can_edit?: true
          can_delete?: true
        }>
      }>
    }
  ).items[0].comments

describe('editing', () => {
  it('lets the author rewrite their own comment', async () => {
    const id = await ivansComment()
    const [res] = await itemWrite(ivan, [
      {
        op: 'comment_update',
        op_id: 'u1',
        key: 'ST-1',
        comment_id: id,
        body: 'mine, corrected',
      },
    ])
    expect(res.ok).toBe(true)
  })

  it('refuses another member', async () => {
    const id = await ivansComment()
    const [res] = await itemWrite(daniela, [
      {
        op: 'comment_update',
        op_id: 'u1',
        key: 'ST-1',
        comment_id: id,
        body: 'not mine',
      },
    ])
    expect(res.ok).toBe(false)
  })

  it('refuses an admin too', async () => {
    // Being able to moderate is not the same as being able to speak as
    // somebody else. An admin can delete this comment and cannot rewrite it.
    const id = await ivansComment()
    const [res] = await itemWrite(admin, [
      {
        op: 'comment_update',
        op_id: 'u1',
        key: 'ST-1',
        comment_id: id,
        body: 'rewritten by an admin',
      },
    ])
    expect(res.ok).toBe(false)
    const body = (
      await db.query<{ body: string }>(
        'SELECT body FROM comment WHERE id = ?',
        [id],
      )
    )[0].body
    expect(body).toBe('mine')
  })

  it('records that it was edited, and says so on the way out', async () => {
    const id = await ivansComment()
    expect((await commentsFor(ivan))[0].edited).toBeUndefined()

    await itemWrite(ivan, [
      {
        op: 'comment_update',
        op_id: 'u1',
        key: 'ST-1',
        comment_id: id,
        body: 'mine, corrected',
      },
    ])
    expect((await commentsFor(ivan))[0].edited).toBeGreaterThan(0)
  })
})

describe('deleting, with the workspace set to author', () => {
  it('lets the author remove their own', async () => {
    const id = await ivansComment()
    const [res] = await itemWrite(ivan, [
      { op: 'comment_delete', op_id: 'd1', key: 'ST-1', comment_id: id },
    ])
    expect(res.ok).toBe(true)
    expect(await commentsFor(ivan)).toHaveLength(0)
  })

  it('lets an admin remove anybody’s', async () => {
    const id = await ivansComment()
    const [res] = await itemWrite(admin, [
      { op: 'comment_delete', op_id: 'd1', key: 'ST-1', comment_id: id },
    ])
    expect(res.ok).toBe(true)
  })

  it('refuses another member', async () => {
    const id = await ivansComment()
    const [res] = await itemWrite(daniela, [
      { op: 'comment_delete', op_id: 'd1', key: 'ST-1', comment_id: id },
    ])
    expect(res.ok).toBe(false)
    expect(await commentsFor(ivan)).toHaveLength(1)
  })

  it('takes the search index and the mentions with it', async () => {
    const res = await itemWrite(ivan, [
      { op: 'comment', op_id: 'c9', key: 'ST-1', body: 'over to you @daniela' },
    ])
    const id = (res[0] as { id: string }).id
    expect(
      await db.query('SELECT 1 FROM link WHERE src_id = ?', [id]),
    ).toHaveLength(1)

    await itemWrite(ivan, [
      { op: 'comment_delete', op_id: 'd1', key: 'ST-1', comment_id: id },
    ])

    // A comment that is gone but still answers a search, or still counts as
    // a mention of somebody, is worse than one that was never deleted.
    expect(
      await db.query('SELECT 1 FROM link WHERE src_id = ?', [id]),
    ).toHaveLength(0)
  })
})

describe('deleting, with the workspace set to admin', () => {
  beforeEach(async () => {
    await db.run('UPDATE workspace SET comment_delete = ? WHERE id = ?', [
      'admin',
      workspaceId,
    ])
  })

  it('refuses the author', async () => {
    const id = await ivansComment()
    const [res] = await itemWrite(ivan, [
      { op: 'comment_delete', op_id: 'd1', key: 'ST-1', comment_id: id },
    ])
    expect(res.ok).toBe(false)
  })

  it('still lets an admin', async () => {
    const id = await ivansComment()
    const [res] = await itemWrite(admin, [
      { op: 'comment_delete', op_id: 'd1', key: 'ST-1', comment_id: id },
    ])
    expect(res.ok).toBe(true)
  })

  it('says so in what it hands the browser, so no menu offers it', async () => {
    await ivansComment()
    const [seenByAuthor] = await commentsFor(ivan)
    expect(seenByAuthor.can_edit).toBe(true)
    expect(seenByAuthor.can_delete).toBeUndefined()

    const [seenByAdmin] = await commentsFor(admin)
    expect(seenByAdmin.can_edit).toBeUndefined()
    expect(seenByAdmin.can_delete).toBe(true)
  })
})

describe('documents keep the same rules', () => {
  const docComment = async (who: ICtx) => {
    const res = await docWrite(who, [
      {
        op: 'comment',
        op_id: `dc${Math.random()}`,
        ref: 'spec',
        body: 'mine',
      },
    ])
    return (res[0] as { id: string }).id
  }

  beforeEach(async () => {
    await docWrite(admin, [
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
  })

  it('refuses an edit by anybody but the author', async () => {
    const id = await docComment(ivan)
    const [res] = await docWrite(daniela, [
      {
        op: 'comment_update',
        op_id: 'u1',
        ref: 'spec',
        comment_id: id,
        body: 'not mine',
      },
    ])
    expect(res.ok).toBe(false)
  })

  it('deletes without touching the page', async () => {
    const id = await docComment(ivan)
    const before = (
      await db.query<{ body: string; rev: number }>(
        'SELECT body, rev FROM document WHERE slug = ?',
        ['spec'],
      )
    )[0]

    const [res] = await docWrite(ivan, [
      { op: 'comment_delete', op_id: 'd2', ref: 'spec', comment_id: id },
    ])
    expect(res.ok).toBe(true)

    // The anchor lives on the comment row, so removing one has never been
    // able to change a document, and must not start now.
    const after = (
      await db.query<{ body: string; rev: number }>(
        'SELECT body, rev FROM document WHERE slug = ?',
        ['spec'],
      )
    )[0]
    expect(after).toEqual(before)

    const read = (await docGet(ivan, 'spec', { include: ['comments'] })) as {
      comments: unknown[]
    }
    expect(read.comments).toHaveLength(0)
  })
})

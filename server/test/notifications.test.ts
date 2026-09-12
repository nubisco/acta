/**
 * Who gets told.
 *
 * The bell that existed before this notified on events from NON-human actors
 * only, so a comment from a colleague reached nobody, and it notified
 * everyone equally about work that was none of their business. These pin the
 * rule that replaced it: you hear about work you are part of, and never about
 * your own actions.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import {
  notificationList,
  notificationRead,
} from '../src/services/notifications'
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

  // template explicitly: calling the service directly skips the zod default
  // that the route would have applied, and a space with no lists takes no
  // cards.
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

const unread = async (who: ICtx) => (await notificationList(who)).unread
const inbox = async (who: ICtx) => (await notificationList(who)).notifications

describe('notifications', () => {
  it('tells the assignee when someone comments, and never the commenter', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'Ship it',
          assignees: ['ivan'],
        },
      ],
      'ST',
    )
    await itemWrite(
      daniela,
      [{ op: 'comment', op_id: 'c1', key: 'ST-1', body: 'looks good' }],
      'ST',
    )

    // Two: being handed the card, then the comment on it. Being given work
    // is itself worth knowing about.
    expect(await unread(ivan)).toBe(2)
    const [top] = await inbox(ivan)
    expect(top.reason).toBe('assigned')
    expect(top.verb).toBe('comment.created')
    expect(top.item_key).toBe('ST-1')

    // Daniela wrote it. Being told what you just did is how a bell teaches
    // people to ignore it.
    expect(await unread(daniela)).toBe(0)
  })

  it('tells someone named in the text, even with no other connection', async () => {
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    await itemWrite(
      ivan,
      [
        {
          op: 'comment',
          op_id: 'c1',
          key: 'ST-1',
          body: 'can you look, [[@daniela]]?',
        },
      ],
      'ST',
    )

    const [top] = await inbox(daniela)
    expect(top.reason).toBe('mention')
    expect(top.summary).toContain('ST-1')
  })

  // Prose that merely looks like a mention is not one, which is exactly the
  // bug the @ typeahead shipped with.
  it('does not treat bare @handle as a mention', async () => {
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    await itemWrite(
      ivan,
      [{ op: 'comment', op_id: 'c1', key: 'ST-1', body: 'hey @daniela' }],
      'ST',
    )
    expect(await unread(daniela)).toBe(0)
  })

  it('keeps telling someone who has taken part', async () => {
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    // Ivan joins the conversation...
    await itemWrite(
      ivan,
      [{ op: 'comment', op_id: 'c1', key: 'ST-1', body: 'on it' }],
      'ST',
    )
    // ...so the next comment is his business too.
    await itemWrite(
      daniela,
      [{ op: 'comment', op_id: 'c2', key: 'ST-1', body: 'thanks' }],
      'ST',
    )

    const got = await inbox(ivan)
    expect(got).toHaveLength(1)
    expect(got[0].reason).toBe('involved')
  })

  // A bell that rings for the whole workspace is a bell people turn off.
  it('says nothing to someone with no connection to the card', async () => {
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    await itemWrite(
      jose,
      [{ op: 'comment', op_id: 'c1', key: 'ST-1', body: 'note to self' }],
      'ST',
    )
    expect(await unread(ivan)).toBe(0)
    expect(await unread(daniela)).toBe(0)
  })

  it('marks read, one at a time and all at once', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'Ship it',
          assignees: ['ivan'],
        },
      ],
      'ST',
    )
    await itemWrite(
      jose,
      [{ op: 'comment', op_id: 'c1', key: 'ST-1', body: 'one' }],
      'ST',
    )
    await itemWrite(
      jose,
      [{ op: 'comment', op_id: 'c2', key: 'ST-1', body: 'two' }],
      'ST',
    )
    expect(await unread(ivan)).toBe(3)

    await notificationRead(ivan, (await inbox(ivan))[0].id)
    expect(await unread(ivan)).toBe(2)

    await notificationRead(ivan)
    expect(await unread(ivan)).toBe(0)
  })
})

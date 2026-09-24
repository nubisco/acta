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
import { myWork } from '../src/services/reads'
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

  /*
   * This used to assert the opposite, on the grounds that prose which merely
   * looks like a mention is not one. It was a reasonable rule and it was
   * wrong: `[[@handle]]` is what the typeahead inserts and it is not what
   * anybody writes. Of every mention in our own workspace, not one was
   * bracketed, so in practice the rule meant no mention had ever produced a
   * notification at all.
   *
   * What the old test was really protecting against is below: the shapes
   * that must never become a mention however they are written.
   */
  it('treats a bare @handle as a mention, because that is what people type', async () => {
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
    const [top] = await inbox(daniela)
    expect(top.reason).toBe('mention')
  })

  it('does not read an address, a URL or code as a mention', async () => {
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
          body: 'write to daniela@nubisco.io, see https://x.com/@daniela, and `@daniela` in the template',
        },
      ],
      'ST',
    )
    expect(await unread(daniela)).toBe(0)
  })

  it('does not invent a person from a handle nobody holds', async () => {
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Ship it' }],
      'ST',
    )
    // The shape is read, and then it resolves to nobody. This is what keeps
    // an imported @someusername from another tool out of the inbox.
    await itemWrite(
      ivan,
      [{ op: 'comment', op_id: 'c1', key: 'ST-1', body: 'hey @nosuchperson' }],
      'ST',
    )
    expect(await unread(daniela)).toBe(0)
    expect(await unread(jose)).toBe(0)
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

/**
 * What one person should look at, across every space.
 *
 * The cases worth pinning are the ones that make the panel wrong rather than
 * empty: the same card counted twice, work that belongs to somebody else, and
 * a "recent" list that reflects the workspace instead of the reader.
 */
/**
 * Mentions in a card's own description.
 *
 * `emitEvent` documents a notify body as "the comment and description
 * paths", but only comments ever passed one, so naming somebody in a
 * description rendered a chip that reached no inbox. Writing a ticket and
 * tagging the person who should pick it up is the ordinary way to hand work
 * over, and it silently did nothing.
 */
describe('description mentions', () => {
  it('tells someone named in a new card description', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'd1',
          list: 'To Do',
          title: 'Needs a look',
          description: 'over to you [[@daniela]]',
        },
      ],
      'ST',
    )
    expect(await unread(daniela)).toBe(1)
    expect((await inbox(daniela))[0].reason).toBe('mention')
  })

  it('tells someone added by an edit, and only once', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'd2',
          list: 'To Do',
          title: 'Quiet',
          description: 'nothing yet',
        },
      ],
      'ST',
    )
    expect(await unread(ivan)).toBe(0)

    await itemWrite(
      jose,
      [
        {
          op: 'update',
          op_id: 'd3',
          key: 'ST-1',
          description: 'actually [[@ivan]] should take this',
        },
      ],
      'ST',
    )
    expect(await unread(ivan)).toBe(1)

    // Editing the text again must not ring for a mention he has already been
    // told about. Every save would otherwise re-notify everyone named in the
    // description, which is how a bell gets switched off for good.
    await itemWrite(
      jose,
      [
        {
          op: 'update',
          op_id: 'd4',
          key: 'ST-1',
          description: 'actually [[@ivan]] should take this, by Friday',
        },
      ],
      'ST',
    )
    expect(await unread(ivan)).toBe(1)

    // A genuinely new name still rings.
    await itemWrite(
      jose,
      [
        {
          op: 'update',
          op_id: 'd5',
          key: 'ST-1',
          description: '[[@ivan]] and [[@daniela]] please',
        },
      ],
      'ST',
    )
    expect(await unread(daniela)).toBe(1)
    expect(await unread(ivan)).toBe(1)
  })
})

describe('my work', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('gathers assigned, due, mentioned and touched, each for the reader', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'w1',
          list: 'Backlog',
          title: 'Mine and overdue',
          assignees: ['jose'],
          due: Date.now() - DAY,
        },
        {
          op: 'create',
          op_id: 'w2',
          list: 'Backlog',
          title: "Ivan's",
          assignees: ['ivan'],
        },
        {
          op: 'create',
          op_id: 'w3',
          list: 'Backlog',
          title: 'Unassigned but due',
          due: Date.now() + DAY,
        },
      ],
      'ST',
    )

    const mine = await myWork(jose)

    expect(mine.assigned.map((i) => i.title)).toEqual(['Mine and overdue'])
    // Computed server-side, against one clock rather than the viewer's.
    expect(mine.assigned[0].overdue).toBe(true)

    // Dated work nobody holds still appears: a due list that only shows what
    // is already assigned hides exactly the ones about to be missed.
    expect(mine.due.map((i) => i.title)).toContain('Unassigned but due')

    // Assigned and due at once is one card, not two. The same row in two
    // panels on one screen reads as two pieces of work.
    expect(mine.due.map((i) => i.title)).not.toContain('Mine and overdue')

    // Someone else's work is never mine, however it is dated.
    expect(JSON.stringify(mine.assigned)).not.toContain("Ivan's")
  })

  it('lists a mention until it has been read, and only for the person mentioned', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'w4',
          list: 'Backlog',
          title: 'Needs Ivan',
          description: 'over to you [[@ivan]]',
        },
      ],
      'ST',
    )

    expect((await myWork(ivan)).mentions.map((i) => i.title)).toEqual([
      'Needs Ivan',
    ])
    // Daniela was not mentioned, so it is not waiting on her.
    expect((await myWork(daniela)).mentions).toHaveLength(0)

    // Read is the proxy for answered: nothing else records having dealt with
    // a mention, and an inbox that never empties stops being read at all.
    await notificationRead(ivan)
    expect((await myWork(ivan)).mentions).toHaveLength(0)
  })

  it('shows what the reader touched, not what the workspace did', async () => {
    await itemWrite(
      ivan,
      [{ op: 'create', op_id: 'w5', list: 'Backlog', title: "Ivan's edit" }],
      'ST',
    )
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'w6', list: 'Backlog', title: "Jose's edit" }],
      'ST',
    )

    // Touched, not viewed. Nothing records a view, and having edited
    // something is the stronger signal of "I was working on this" anyway.
    expect((await myWork(jose)).recent.map((i) => i.title)).toEqual([
      "Jose's edit",
    ])
    expect((await myWork(ivan)).recent.map((i) => i.title)).toEqual([
      "Ivan's edit",
    ])
  })

  it('leaves out work that is finished or filed away', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'w7',
          list: 'Backlog',
          title: 'Done',
          assignees: ['jose'],
        },
        {
          op: 'create',
          op_id: 'w8',
          list: 'Backlog',
          title: 'Archived',
          assignees: ['jose'],
        },
      ],
      'ST',
    )
    await itemWrite(
      jose,
      [
        { op: 'complete', op_id: 'w9', key: 'ST-1' },
        { op: 'archive', op_id: 'w10', key: 'ST-2' },
      ],
      'ST',
    )

    const mine = await myWork(jose)
    const titles = mine.assigned.map((i) => i.title)
    expect(titles).not.toContain('Done')
    expect(titles).not.toContain('Archived')
    // Archived work is gone from every bucket, including the one built from
    // this person's own edits.
    expect(mine.recent.map((i) => i.title)).not.toContain('Archived')
  })
})

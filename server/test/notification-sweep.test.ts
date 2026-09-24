/**
 * The half of notifications that time drives.
 *
 * Two things here have to be true or the feature is worse than not having
 * it. One digest per person per sweep, never one email per notification,
 * because a busy card produces a dozen notifications in ten minutes and a
 * dozen emails about one conversation is how a sender gets filtered. And
 * nothing at all once the bell has been looked at: the entire promise is
 * that the email is what happens when you did not see it.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import {
  notificationList,
  notificationPrefsSet,
  notificationRead,
} from '../src/services/notifications'
import {
  emailChannel,
  notificationSweep,
  reminderSweep,
  dueDateSweep,
  type INotificationChannel,
} from '../src/services/notificationSweep'
import type { IEmail } from '../src/core/email'
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

/** Captures what would have been sent, so a test can read the message. */
function captureEmail(): { sent: IEmail[]; channel: INotificationChannel } {
  const sent: IEmail[] = []
  return {
    sent,
    channel: emailChannel(async (message) => {
      sent.push(message)
    }),
  }
}

beforeEach(async () => {
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    workspaceName: 'Nubisco',
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
     VALUES ('act_ivan', ?, 'human', 'ivan', 'Ivan Silva', 'ivan@nubisco.io', 'member', ?)`,
    [workspaceId, Date.now()],
  )
  const joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  jose = ctxFor(joseId, 'jose')
  ivan = ctxFor('act_ivan', 'ivan')

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

/** A card of Ivan's that Jose then talks about, `count` times. */
async function noise(count: number): Promise<void> {
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
  for (let n = 0; n < count; n += 1) {
    await itemWrite(
      jose,
      [{ op: 'comment', op_id: `c${n}`, key: 'ST-1', body: `note ${n}` }],
      'ST',
    )
  }
}

const HOUR = 60 * 60 * 1000

describe('the reminder', () => {
  it('sends one email for everything waiting, not one per notification', async () => {
    await noise(5)
    const { sent, channel } = captureEmail()

    const reached = await reminderSweep(db, {
      channels: [channel],
      baseUrl: 'https://acta.nubisco.io',
      nowMs: Date.now() + HOUR,
    })

    expect(reached).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ivan@nubisco.io')
    // Six: the card being handed to him, then five comments on it.
    expect(sent[0].subject).toBe('6 things waiting in Nubisco')
    // Named, and folded. Five identical "commented on ST-1" lines say
    // nothing the first one did not, and they bury whatever else is in the
    // digest underneath them.
    expect(sent[0].text).toContain('Admin commented on ST-1 (5 times)')
    expect(sent[0].text).toContain('Admin created ST-1')
  })

  it('says nothing at all once the bell has been looked at', async () => {
    await noise(3)
    await notificationRead(ivan)
    const { sent, channel } = captureEmail()

    await reminderSweep(db, {
      channels: [channel],
      nowMs: Date.now() + HOUR,
    })

    expect(sent).toHaveLength(0)
  })

  it('waits for the window before it says anything', async () => {
    await noise(1)
    const { sent, channel } = captureEmail()

    // Default is ten minutes. Five minutes in, nothing is owed.
    await reminderSweep(db, {
      channels: [channel],
      nowMs: Date.now() + 5 * 60 * 1000,
    })
    expect(sent).toHaveLength(0)

    await reminderSweep(db, { channels: [channel], nowMs: Date.now() + HOUR })
    expect(sent).toHaveLength(1)
  })

  it('does not send the same reminder twice', async () => {
    await noise(2)
    const { sent, channel } = captureEmail()
    const at = Date.now() + HOUR

    await reminderSweep(db, { channels: [channel], nowMs: at })
    await reminderSweep(db, { channels: [channel], nowMs: at + 60_000 })

    // Still unread, and still only chased once. A reminder that repeats
    // every tick is the same feature as no reminder, arrived at faster.
    expect((await notificationList(ivan)).unread).toBe(3)
    expect(sent).toHaveLength(1)
  })

  it('honours someone turning it off, and forgets what was already queued', async () => {
    await noise(2)
    await notificationPrefsSet(ivan, 0)
    const { sent, channel } = captureEmail()

    await reminderSweep(db, { channels: [channel], nowMs: Date.now() + HOUR })

    expect(sent).toHaveLength(0)
    // Off is off, not "later". The rows are still unread and still in the
    // bell, they are simply never chased.
    expect((await notificationList(ivan)).unread).toBe(3)
  })

  it('honours a longer window', async () => {
    await notificationPrefsSet(ivan, 86400)
    await noise(1)
    const { sent, channel } = captureEmail()

    await reminderSweep(db, { channels: [channel], nowMs: Date.now() + HOUR })
    expect(sent).toHaveLength(0)

    await reminderSweep(db, {
      channels: [channel],
      nowMs: Date.now() + 25 * HOUR,
    })
    expect(sent).toHaveLength(1)
  })

  it('leaves everything pending when the instance has no way to send', async () => {
    await noise(1)

    // The self-hosted default. Nothing configured means nothing is sent, and
    // crucially nothing is stamped as reminded either: a sweep with no
    // channel must not quietly burn the reminders it could not deliver.
    await reminderSweep(db, { channels: [], nowMs: Date.now() + HOUR })

    const pending = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM notification WHERE reminded_at IS NOT NULL',
    )
    expect(pending[0].n).toBe(0)
  })

  it('writes a link that lands on the card, not on the workspace chooser', async () => {
    await noise(1)
    const { sent, channel } = captureEmail()

    await reminderSweep(db, {
      channels: [channel],
      baseUrl: 'https://acta.nubisco.io',
      nowMs: Date.now() + HOUR,
    })

    const slug = (
      await db.query<{ slug: string }>('SELECT slug FROM workspace LIMIT 1')
    )[0].slug
    // Every real route lives under the workspace segment, and a card opens
    // as an inspector over its own space. A link that skips either of those
    // resolves to somewhere that is not the thing the email is about.
    expect(sent[0].html).toContain(
      `https://acta.nubisco.io/${slug}/s/ST?item=ST-1`,
    )
  })

  it('stops enumerating past a screenful, without understating the count', async () => {
    await noise(40)
    const { sent, channel } = captureEmail()

    await reminderSweep(db, {
      channels: [channel],
      nowMs: Date.now() + HOUR,
    })

    // 41 things, and a body that does not try to print 41 lines. Repeats
    // fold first, so this only bites on a genuinely varied backlog.
    expect(sent[0].subject).toBe('41 things waiting in Nubisco')
    expect(
      sent[0].text.split('\n').filter((l) => l.startsWith('Assigned')),
    ).not.toHaveLength(41)
  })

  it('sends nothing to someone with no address on file', async () => {
    await db.run("UPDATE actor SET email = NULL WHERE handle = 'ivan'")
    await noise(1)
    const { sent, channel } = captureEmail()

    await reminderSweep(db, { channels: [channel], nowMs: Date.now() + HOUR })
    expect(sent).toHaveLength(0)
  })
})

describe('due dates', () => {
  const dueCard = async (due: number) =>
    itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: `i${due}`,
          list: 'To Do',
          title: 'Ship it',
          assignees: ['ivan'],
          due,
        },
      ],
      'ST',
    )

  it('tells the assignee a day before, and again when it passes', async () => {
    const due = Date.now() + 10 * HOUR
    await dueCard(due)

    expect(await dueDateSweep(db, { nowMs: Date.now() })).toBe(1)
    expect((await notificationList(ivan)).notifications[0].verb).toBe(
      'item.due_soon',
    )

    expect(await dueDateSweep(db, { nowMs: due + 1000 })).toBe(1)
    expect((await notificationList(ivan)).notifications[0].verb).toBe(
      'item.overdue',
    )
  })

  it('says it once, however often the sweep runs', async () => {
    await dueCard(Date.now() + 10 * HOUR)

    await dueDateSweep(db, { nowMs: Date.now() })
    await dueDateSweep(db, { nowMs: Date.now() + 60_000 })
    await dueDateSweep(db, { nowMs: Date.now() + 120_000 })

    const said = (await notificationList(ivan)).notifications.filter(
      (n) => n.verb === 'item.due_soon',
    )
    expect(said).toHaveLength(1)
  })

  it('says nothing about a date nobody is holding', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'i9',
          list: 'To Do',
          title: 'Unowned',
          due: Date.now() + HOUR,
        },
      ],
      'ST',
    )
    // A due date on a card nobody is assigned to is a date in a database.
    // There is no inbox to put it in.
    expect(await dueDateSweep(db, { nowMs: Date.now() })).toBe(0)
  })

  it('tells whoever is holding the card, and stops there', async () => {
    await dueCard(Date.now() + 10 * HOUR)
    // Jose commented, so he is involved in the card. A date is the problem
    // of whoever is holding it, and somebody else's work being late is not
    // news anyone can act on.
    await itemWrite(
      jose,
      [{ op: 'comment', op_id: 'cc', key: 'ST-1', body: 'noted' }],
      'ST',
    )
    await dueDateSweep(db, { nowMs: Date.now() })

    const joseSaw = (await notificationList(jose)).notifications.map(
      (n) => n.verb,
    )
    expect(joseSaw).not.toContain('item.due_soon')
    expect(
      (await notificationList(ivan)).notifications.map((n) => n.verb),
    ).toContain('item.due_soon')
  })

  it('says nothing about a card that is done', async () => {
    await dueCard(Date.now() + HOUR)
    await itemWrite(jose, [{ op: 'complete', op_id: 'x1', key: 'ST-1' }], 'ST')
    expect(await dueDateSweep(db, { nowMs: Date.now() })).toBe(0)
  })
})

describe('the whole sweep', () => {
  it('chases a due date it raised in the same tick', async () => {
    await itemWrite(
      jose,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'Ship it',
          assignees: ['ivan'],
          due: Date.now() + HOUR,
        },
      ],
      'ST',
    )
    const { sent, channel } = captureEmail()

    // The card being assigned is already an hour old and owed a reminder;
    // the due date is raised by this same call. Both belong in one email.
    const out = await notificationSweep(db, {
      channels: [channel],
      nowMs: Date.now() + HOUR,
    })

    expect(out.due).toBe(1)
    expect(out.reminded).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('overdue')
  })
})

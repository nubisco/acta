/**
 * The bell, client side.
 *
 * Two rules matter more than the rest. Opening the app must not fire a
 * desktop notification for everything that happened while you were away,
 * which would be a dozen popups on every launch. And one thing happening
 * must not announce twice, however many times the inbox is re-read.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const listed = vi.fn()
const markRead = vi.fn(async (_id?: string) => ({ ok: true }))
/** Streams opened, by the workspace each was opened for. */
const streams: {
  slug: string
  closed: boolean
  health?: (down: boolean) => void
}[] = []
let slug = 'nubisco'
vi.mock('@/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    api: {
      ...(actual.api as object),
      notifications: () => listed(),
      notificationRead: (id?: string) => markRead(id),
      overview: async () => ({ spaces: [] }),
    },
    getWorkspaceSlug: () => slug,
    setWorkspaceSlug: (next: string) => {
      slug = next
    },
    subscribeEvents: (_handler: unknown, health?: (down: boolean) => void) => {
      const stream = { slug, closed: false, health }
      streams.push(stream)
      return () => {
        stream.closed = true
      }
    },
  }
})

/**
 * Imported per test, not once. The store holds its inbox and its
 * already-announced set in module scope, which is right for an app with one
 * of each and wrong for a file with four tests: without this, what the second
 * test sees depends on what the first one did.
 */
async function freshStore() {
  vi.resetModules()
  const mod = await import('@/stores/workspace')
  return mod.useWorkspace()
}

const row = (id: string, read = false) => ({
  id,
  reason: 'mention' as const,
  verb: 'comment.created',
  summary: `commented on ST-1 (${id})`,
  item_key: 'ST-1',
  created_at: 1756000000000,
  read_at: read ? 1756000000001 : null,
})

let shown: {
  title: string
  opts: NotificationOptions
  notice: { onclick: (() => unknown) | null }
}[] = []

beforeEach(() => {
  shown = []
  streams.length = 0
  slug = 'nubisco'
  listed.mockReset()
  markRead.mockClear()
  class FakeNotification {
    static permission: NotificationPermission = 'granted'
    static requestPermission = vi.fn(async () => 'granted' as const)
    onclick: (() => unknown) | null = null
    constructor(title: string, opts: NotificationOptions) {
      shown.push({ title, opts, notice: this })
    }
    close() {}
  }
  vi.stubGlobal('Notification', FakeNotification)
})

describe('desktop notifications', () => {
  it('says nothing on the first load, however much is waiting', async () => {
    listed.mockResolvedValue({
      notifications: [row('a'), row('b'), row('c')],
      unread: 3,
    })
    const ws = await freshStore()
    await ws.loadNotifications()

    // All three are in the bell...
    expect(ws.notifications.value).toHaveLength(3)
    expect(ws.unreadCount.value).toBe(3)
    // ...and none of them interrupted anyone. They are history, not news.
    expect(shown).toHaveLength(0)
  })

  it('announces what arrives after that, once each', async () => {
    listed.mockResolvedValue({ notifications: [row('a')], unread: 1 })
    const ws = await freshStore()
    await ws.loadNotifications()
    expect(shown).toHaveLength(0)

    listed.mockResolvedValue({
      notifications: [row('b'), row('a')],
      unread: 2,
    })
    await ws.loadNotifications()
    expect(shown.map((s) => s.title)).toEqual(['commented on ST-1 (b)'])

    // Re-reading the same inbox must not ring again: the live stream
    // triggers a re-read on every event, including ones that notify nobody.
    await ws.loadNotifications()
    await ws.loadNotifications()
    expect(shown).toHaveLength(1)
  })

  it('collapses a busy card onto one notification', async () => {
    listed.mockResolvedValue({ notifications: [], unread: 0 })
    const ws = await freshStore()
    await ws.loadNotifications()

    listed.mockResolvedValue({
      notifications: [row('b'), row('c')],
      unread: 2,
    })
    await ws.loadNotifications()
    // Same card, so the OS replaces rather than stacks.
    expect(new Set(shown.map((s) => s.opts.tag))).toEqual(new Set(['ST-1']))
  })

  it('stays silent when permission was never granted', async () => {
    ;(Notification as unknown as { permission: string }).permission = 'default'
    listed.mockResolvedValue({ notifications: [], unread: 0 })
    const ws = await freshStore()
    await ws.loadNotifications()
    listed.mockResolvedValue({ notifications: [row('b')], unread: 1 })
    await ws.loadNotifications()
    expect(shown).toHaveLength(0)
  })
})

describe('what the bell and the desktop say', () => {
  it('counts every unread notification, not only the ones in the list', async () => {
    // The list is the newest fifty. Somebody with eighty waiting has eighty.
    listed.mockResolvedValue({ notifications: [row('a')], unread: 80 })
    const ws = await freshStore()
    await ws.loadNotifications()
    expect(ws.unreadCount.value).toBe(80)
    await ws.markRead('a')
    expect(ws.unreadCount.value).toBe(79)
    await ws.markAllRead()
    expect(ws.unreadCount.value).toBe(0)
  })

  it('describes a goal as a goal and a page as a page', async () => {
    const { announceReason } = await import('@/stores/workspace')
    const base = {
      id: 'x',
      title: 't',
      verb: 'goal.checked_in',
      itemKey: null,
      docSlug: null,
      goalNumber: null,
      actorHandle: null,
      timestamp: '',
      read: false,
    }
    expect(announceReason({ ...base, reason: 'assigned', goalNumber: 1 })).toBe(
      'On a goal you own',
    )
    expect(announceReason({ ...base, reason: 'involved', goalNumber: 1 })).toBe(
      'On a goal you follow',
    )
    expect(
      announceReason({ ...base, reason: 'involved', docSlug: 'spec' }),
    ).toBe('On a page you are part of')
    expect(
      announceReason({ ...base, reason: 'mention', docSlug: 'spec' }),
    ).toBe('You were mentioned')
  })

  it('marks a notification read when its desktop popup is clicked', async () => {
    listed.mockResolvedValue({ notifications: [], unread: 0 })
    const ws = await freshStore()
    await ws.loadNotifications()
    listed.mockResolvedValue({
      notifications: [
        {
          ...row('m'),
          reason: 'assigned',
          verb: 'member.updated',
          summary: 'you are now an admin',
          item_key: null,
        },
      ],
      unread: 1,
    })
    await ws.loadNotifications()
    expect(shown[0].opts.body).toBe('About your account')

    await shown[0].notice.onclick?.()
    expect(markRead).toHaveBeenCalledWith('m')
    expect(ws.unreadCount.value).toBe(0)
  })
})

describe('keeping the bell current', () => {
  it('catches up on the inbox each time the live connection comes back', async () => {
    vi.useFakeTimers()
    try {
      listed.mockResolvedValue({ notifications: [], unread: 0 })
      const ws = await freshStore()
      ws.connect()
      // No timer any more: delivery is live, so nothing is read on a clock.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(listed).not.toHaveBeenCalled()

      // What arrived while the tab was cut off was never sent to it.
      streams[0].health!(true)
      streams[0].health!(false)
      await vi.advanceTimersByTimeAsync(400)
      expect(listed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows a move to another workspace with its stream and its inbox', async () => {
    listed.mockResolvedValue({ notifications: [row('a')], unread: 1 })
    const ws = await freshStore()
    await ws.enterWorkspace('nubisco')
    ws.connect()
    await ws.loadNotifications()
    expect(streams.map((s) => s.slug)).toEqual(['nubisco'])

    listed.mockResolvedValue({
      notifications: [row('b'), row('c')],
      unread: 2,
    })
    await ws.enterWorkspace('acme')
    ws.connect()
    await vi.waitFor(() =>
      expect(ws.notifications.value.map((n) => n.id)).toEqual(['b', 'c']),
    )

    // One stream, for the workspace on screen.
    expect(streams.map((s) => [s.slug, s.closed])).toEqual([
      ['nubisco', true],
      ['acme', false],
    ])
    // What was already waiting in the other workspace is history there too.
    expect(shown).toHaveLength(0)
  })
})

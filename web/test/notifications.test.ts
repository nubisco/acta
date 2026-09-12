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
vi.mock('@/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    api: {
      ...(actual.api as object),
      notifications: () => listed(),
      notificationRead: (id?: string) => markRead(id),
    },
    getWorkspaceSlug: () => 'nubisco',
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

let shown: { title: string; opts: NotificationOptions }[] = []

beforeEach(() => {
  shown = []
  listed.mockReset()
  markRead.mockClear()
  class FakeNotification {
    static permission: NotificationPermission = 'granted'
    static requestPermission = vi.fn(async () => 'granted' as const)
    onclick: (() => void) | null = null
    constructor(title: string, opts: NotificationOptions) {
      shown.push({ title, opts })
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

/**
 * The bell itself, which nothing covered before.
 *
 * The store had tests and the component had none, so the list could have
 * rendered anything at all and the suite would have stayed green. Three
 * things matter here and none of them were pinned: that a row says who did
 * it, that a failed fetch does not read as an empty inbox, and that a
 * notification about a document opens the document rather than doing nothing
 * because it has no card key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const notifications = vi.fn()
const notificationRead = vi.fn(async () => ({ ok: true }))
const overview = vi.fn()
const push = vi.fn()
const inspectorOpen = vi.fn()

vi.mock('@/api/client', () => ({
  api: { notifications, notificationRead, overview },
  getWorkspaceSlug: () => 'nubisco',
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ntf_1',
    reason: 'mention',
    verb: 'comment.created',
    summary: 'commented on ST-1',
    item_key: 'ST-1',
    doc_slug: null,
    created_at: Date.now(),
    read_at: null,
    actor_handle: 'daniela',
    actor_name: 'Daniela Reis',
    actor_avatar_url: null,
    ...over,
  }
}

async function mountBell() {
  vi.resetModules()
  const { useWorkspace, useInspector } = await import('@/stores/workspace')
  const ws = useWorkspace()
  const inspector = useInspector()
  inspector.open = inspectorOpen
  // Filled the way the app fills it, because the store exposes `overview` as
  // a computed and writing to it silently does nothing.
  await ws.refresh()
  const Bell = (await import('@/components/NotificationBell.vue')).default
  mounted = mount(Bell, { attachTo: document.body })
  await flushPromises()
  return mounted
}

let mounted: ReturnType<typeof mount> | null = null

/**
 * The panel is teleported out of the component, which is what lets it escape
 * the sidebar's overflow. So the assertions read the document, not the
 * wrapper, and the trigger is the button inside the menu row rather than the
 * row itself.
 */
async function openPanel(): Promise<void> {
  const trigger = document.querySelector<HTMLElement>(
    '.nb-sidebar-menu-item__row',
  )
  trigger?.click()
  await flushPromises()
}

const panelText = () => document.body.textContent ?? ''

// The panel teleports to the body, so a bell left mounted keeps its panel in
// the document and the next test reads both.
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

beforeEach(() => {
  vi.clearAllMocks()
  notifications.mockResolvedValue({ notifications: [], unread: 0 })
  overview.mockResolvedValue({
    spaces: [],
    labels: [],
    // The actor directory is what ActorAvatar resolves a handle against.
    actors: [
      {
        id: 'a1',
        handle: 'daniela',
        kind: 'human',
        name: 'Daniela Reis',
        role: 'member',
      },
    ],
  })
})

describe('the bell', () => {
  it('says who did it, not only what happened', async () => {
    notifications.mockResolvedValue({ notifications: [row()], unread: 1 })
    await mountBell()
    await openPanel()

    // The summary alone reads "commented on ST-1", which in an inbox is a
    // sentence with the subject missing.
    expect(panelText()).toContain('Daniela Reis commented on ST-1')
    expect(panelText()).toContain('Mentioned you')
  })

  it('puts a face on the row', async () => {
    notifications.mockResolvedValue({ notifications: [row()], unread: 1 })
    await mountBell()
    await openPanel()

    // Initials, because the fixture has no picture. The point is that the
    // person is represented at all.
    expect(document.querySelector('.avatar')).not.toBeNull()
  })

  it('does not read a failed request as an empty inbox', async () => {
    notifications.mockRejectedValue(new Error('offline'))
    await mountBell()
    await openPanel()

    expect(panelText()).toContain('Could not load your notifications')
    expect(panelText()).not.toContain('Nothing waiting on you')
  })

  it('opens a document when that is what the notification is about', async () => {
    notifications.mockResolvedValue({
      notifications: [
        row({
          item_key: null,
          doc_slug: 'spec',
          summary: 'commented on spec',
          verb: 'comment.created',
        }),
      ],
      unread: 1,
    })
    await mountBell()
    await openPanel()
    document.querySelector<HTMLElement>('.nb-notification-item__row')?.click()
    await flushPromises()

    expect(push).toHaveBeenCalledWith('/nubisco/docs/spec')
    expect(inspectorOpen).not.toHaveBeenCalled()
  })
})

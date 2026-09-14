/**
 * The "Reconnecting" banner.
 *
 * EventSource drops and re-establishes on its own routinely: a proxy idle
 * timeout, a laptop waking, a network hiccup. Each one fires onerror and is
 * fixed within a second or two without anybody doing anything.
 *
 * Warning about every one of those painted a warning callout across the top
 * of a perfectly healthy instance, which is the first thing a new self-host
 * operator sees and reads as "this software is broken". The banner is for a
 * stream that is actually staying down.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const subscribeEvents = vi.fn()
vi.mock('@/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    subscribeEvents: (...a: unknown[]) => subscribeEvents(...a),
    getWorkspaceSlug: () => 'demo',
    api: {
      ...(actual.api as object),
      notifications: async () => ({ notifications: [] }),
    },
  }
})

/** The store keeps its connection state in module scope, so reset per test. */
async function freshStore() {
  vi.resetModules()
  const mod = await import('@/stores/workspace')
  return mod.useWorkspace()
}

/** The health callback the store handed to subscribeEvents. */
const health = () =>
  subscribeEvents.mock.calls.at(-1)![1] as (down: boolean) => void
/** The event callback, for proving a frame cancels a pending warning. */
const onEvent = () =>
  subscribeEvents.mock.calls.at(-1)![0] as (e: unknown) => void

beforeEach(() => {
  subscribeEvents.mockReset()
  subscribeEvents.mockReturnValue(() => {})
  vi.useFakeTimers()
})

describe('connection banner', () => {
  it('stays quiet through a reconnect that heals itself', async () => {
    const ws = await freshStore()
    ws.connect()

    health()(true)
    vi.advanceTimersByTime(3000)
    expect(ws.connectionDown.value).toBe(false)

    health()(false)
    vi.advanceTimersByTime(30_000)
    expect(ws.connectionDown.value).toBe(false)
  })

  it('warns when the stream really is staying down', async () => {
    const ws = await freshStore()
    ws.connect()

    health()(true)
    vi.advanceTimersByTime(7000)
    expect(ws.connectionDown.value).toBe(true)
  })

  // A frame arriving is proof the stream is up, and it can arrive before
  // onopen does. Without this the banner appears after a reconnect that has
  // demonstrably already succeeded.
  it('cancels a pending warning when an event arrives', async () => {
    const ws = await freshStore()
    ws.connect()

    health()(true)
    vi.advanceTimersByTime(3000)
    onEvent()({ entity: 'item', verb: 'item.updated', id: 'e1' })
    vi.advanceTimersByTime(30_000)
    expect(ws.connectionDown.value).toBe(false)
  })

  // Flapping must not accumulate timers, or the banner appears on a stream
  // that recovered several drops ago.
  it('does not let an earlier drop fire after a recovery', async () => {
    const ws = await freshStore()
    ws.connect()

    health()(true)
    vi.advanceTimersByTime(5000)
    health()(false)
    health()(true)
    vi.advanceTimersByTime(3000)
    expect(ws.connectionDown.value).toBe(false)
    vi.advanceTimersByTime(4000)
    expect(ws.connectionDown.value).toBe(true)
  })
})

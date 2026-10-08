/**
 * Walkthroughs: remembered on the account, one at a time, and listed in
 * Settings with a way to meet each one again (Jose, 2026-10-08).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const remote: Record<string, unknown> = {}
const walkthroughs = vi.fn(async () => ({ walkthroughs: { ...remote } }))
const walkthroughSet = vi.fn(async (id: string, record: unknown) => {
  remote[id] = record
  return { ok: true }
})
const walkthroughReset = vi.fn(async (id: string) => {
  delete remote[id]
  return { ok: true }
})

vi.mock('@/api/client', () => ({
  api: { overview: vi.fn() },
  auth: { walkthroughs, walkthroughSet, walkthroughReset },
  getWorkspaceSlug: () => 'nubisco',
}))

const push = vi.fn(async () => undefined)
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: {} }),
}))

const record = (outcome: 'finish' | 'skip', version = 1) => ({
  version,
  outcome,
  completedAt: '2026-10-08T19:00:00.000Z',
})

beforeEach(() => {
  vi.resetModules()
  for (const key of Object.keys(remote)) delete remote[key]
  localStorage.clear()
  walkthroughSet.mockClear()
})

describe('walkthrough storage on the account', () => {
  it('reads what the account holds', async () => {
    remote['acta-goals'] = record('finish')
    const { createAccountWalkthroughStorage } = await import('@/lib/tours')
    const storage = createAccountWalkthroughStorage()
    expect(await storage.get('acta-goals')).toEqual(record('finish'))
    expect(await storage.get('acta-notifications')).toBeNull()
  })

  it('carries over a tour this browser already finished', async () => {
    const { createAccountWalkthroughStorage } = await import('@/lib/tours')
    const { createDefaultWalkthroughStorage } = await import('@nubisco/ui')
    await createDefaultWalkthroughStorage().set('acta-intro', record('skip', 2))
    const storage = createAccountWalkthroughStorage()
    expect(await storage.get('acta-intro')).toEqual(record('skip', 2))
    await flushPromises()
    expect(walkthroughSet).toHaveBeenCalledWith('acta-intro', record('skip', 2))
  })

  it('writes and forgets through the account', async () => {
    const { createAccountWalkthroughStorage } = await import('@/lib/tours')
    const storage = createAccountWalkthroughStorage()
    await storage.set('acta-goals', record('finish'))
    expect(remote['acta-goals']).toEqual(record('finish'))
    await storage.remove('acta-goals')
    expect(remote['acta-goals']).toBeUndefined()
    expect(await storage.get('acta-goals')).toBeNull()
  })
})

describe('playing a walkthrough', () => {
  it('plays once, and never over another one', async () => {
    const { useTours } = await import('@/lib/tours')
    const tours = useTours()
    expect(await tours.maybeStart('goals')).toBe(true)
    expect(await tours.maybeStart('notifications')).toBe(false)
    await tours.controllers.goals.finish()
    expect(await tours.maybeStart('goals')).toBe(false)
  })

  it('waits while something else holds the screen', async () => {
    const { useTours } = await import('@/lib/tours')
    const tours = useTours()
    tours.held.value = true
    expect(await tours.maybeStart('goals')).toBe(false)
    tours.held.value = false
    expect(await tours.maybeStart('goals')).toBe(true)
  })

  it('takes the reader to Settings partway through the notifications one', async () => {
    const { setTourNavigator, useTours } = await import('@/lib/tours')
    const go = vi.fn(async () => undefined)
    setTourNavigator(go)
    const tours = useTours()
    tours.controllers.notifications.start()
    tours.controllers.notifications.next()
    expect(go).toHaveBeenCalledWith('/settings?tab=notifications')
  })
})

describe('the walkthroughs in Settings', () => {
  it('lists each one with its state, and resets one', async () => {
    remote['acta-intro'] = record('finish', 2)
    remote['acta-goals'] = record('skip')
    const Settings = (
      await import('@/components/settings/SettingsWalkthroughs.vue')
    ).default
    const view = mount(Settings)
    await flushPromises()
    const rows = view.findAll('.walkthroughs__row')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('Seen')
    expect(rows[1].text()).toContain('Skipped')
    expect(rows[2].text()).toContain('Not seen')

    const reset = rows[1]
      .findAll('button')
      .find((b) => b.text().includes('Reset'))!
    await reset.trigger('click')
    await flushPromises()
    expect(remote['acta-goals']).toBeUndefined()
    expect(view.findAll('.walkthroughs__row')[1].text()).toContain('Not seen')
  })
})

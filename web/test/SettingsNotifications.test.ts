/**
 * The one setting that decides whether Acta emails you.
 *
 * Worth pinning because the failure is silent in both directions: a page that
 * shows the default instead of what you chose reads as your choice not having
 * saved, and a change that does not reach the server reads as the feature
 * ignoring you. Neither produces an error anywhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const notificationPrefs = vi.fn()
const setNotificationPrefs = vi.fn(async (n: number) => ({
  notify_after_seconds: n,
}))
const overview = vi.fn()
const me = vi.fn()

vi.mock('@/api/client', () => ({
  api: { notificationPrefs, setNotificationPrefs, overview },
  auth: { me },
  getWorkspaceSlug: () => 'nubisco',
}))

async function mountPage() {
  vi.resetModules()
  const SettingsNotifications = (
    await import('@/components/settings/SettingsNotifications.vue')
  ).default
  const wrapper = mount(SettingsNotifications)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  notificationPrefs.mockResolvedValue({ notify_after_seconds: 600 })
  overview.mockResolvedValue({ spaces: [], labels: [], actors: [] })
  me.mockResolvedValue({ id: 'a1', handle: 'ivan', email: 'ivan@nubisco.io' })
})

describe('notification settings', () => {
  it('shows the window that is actually set, not the default', async () => {
    notificationPrefs.mockResolvedValue({ notify_after_seconds: 14400 })
    const wrapper = await mountPage()

    const chosen = wrapper
      .findAll('input[type="radio"]')
      .find((input) => (input.element as HTMLInputElement).checked)
    expect((chosen?.element as HTMLInputElement).value).toBe('14400')
  })

  it('saves the moment it changes, with no button to forget', async () => {
    const wrapper = await mountPage()
    const never = wrapper
      .findAll('input[type="radio"]')
      .find((input) => (input.element as HTMLInputElement).value === '0')

    await never?.setValue()
    await flushPromises()

    expect(setNotificationPrefs).toHaveBeenCalledWith(0)
  })

  it('offers every window the server will accept, and no others', async () => {
    const wrapper = await mountPage()
    const values = wrapper
      .findAll('input[type="radio"]')
      .map((input) => (input.element as HTMLInputElement).value)

    // The same closed set the server validates against. A fifth option here
    // would be a control that saves nothing and reports an error nobody can
    // act on.
    expect(values).toEqual(['600', '3600', '14400', '86400', '0'])
  })
})

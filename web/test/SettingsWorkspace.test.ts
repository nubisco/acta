/**
 * The workspace-wide rule about deleting comments.
 *
 * Two things are worth pinning. The control has to show the rule that is in
 * force rather than the default, because a page showing "author" to a
 * workspace set to "admin" is a page lying about who can delete what. And the
 * tab has to be admin-only: offering it to someone the server will refuse is
 * a control that exists only to produce an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const overview = vi.fn()
const setWorkspacePolicy = vi.fn(async () => ({ comment_delete: 'admin' }))
const me = vi.fn()

vi.mock('@/api/client', () => ({
  api: { overview, setWorkspacePolicy },
  auth: { me },
  getWorkspaceSlug: () => 'nubisco',
}))

vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  // The settings view asks the shell for the slot its tab strip goes in, and
  // there is no shell here.
  return {
    ...actual,
    useShellSlot: () => ({
      Outlet: {
        setup:
          (_: unknown, { slots }: { slots: Record<string, () => unknown> }) =>
          () =>
            slots.default?.(),
      },
    }),
  }
})

async function mountSection() {
  vi.resetModules()
  const SettingsWorkspace = (
    await import('@/components/settings/SettingsWorkspace.vue')
  ).default
  const { useWorkspace } = await import('@/stores/workspace')
  await useWorkspace().refresh()
  const wrapper = mount(SettingsWorkspace)
  await flushPromises()
  return wrapper
}

async function mountSettings() {
  vi.resetModules()
  const SettingsView = (await import('@/views/SettingsView.vue')).default
  const { useWorkspace } = await import('@/stores/workspace')
  const ws = useWorkspace()
  await ws.refresh()
  await ws.loadMe()
  const wrapper = mount(SettingsView)
  await flushPromises()
  return wrapper
}

const BASE_OVERVIEW = {
  spaces: [],
  labels: [],
  actors: [],
  policy: { comment_delete: 'author' },
}

beforeEach(() => {
  vi.clearAllMocks()
  overview.mockResolvedValue(BASE_OVERVIEW)
  me.mockResolvedValue({ id: 'a1', handle: 'ivan', role: 'admin' })
})

describe('the workspace comment policy', () => {
  it('shows the rule in force, not the default', async () => {
    overview.mockResolvedValue({
      ...BASE_OVERVIEW,
      policy: { comment_delete: 'admin' },
    })
    const wrapper = await mountSection()

    const chosen = wrapper
      .findAll('input[type="radio"]')
      .find((input) => (input.element as HTMLInputElement).checked)
    expect((chosen?.element as HTMLInputElement).value).toBe('admin')
  })

  it('saves the moment it changes, with no button to forget', async () => {
    const wrapper = await mountSection()
    const adminOnly = wrapper
      .findAll('input[type="radio"]')
      .find((input) => (input.element as HTMLInputElement).value === 'admin')

    await adminOnly?.setValue()
    await flushPromises()

    expect(setWorkspacePolicy).toHaveBeenCalledWith({ comment_delete: 'admin' })
  })

  it('offers the two the server will accept, and no others', async () => {
    const wrapper = await mountSection()
    const values = wrapper
      .findAll('input[type="radio"]')
      .map((input) => (input.element as HTMLInputElement).value)
    expect(values).toEqual(['author', 'admin'])
  })
})

describe('the Workspace tab', () => {
  it('is there for an admin', async () => {
    expect((await mountSettings()).text()).toContain('Workspace')
  })

  it('is not offered to anyone who cannot change it', async () => {
    me.mockResolvedValue({ id: 'a2', handle: 'sam', role: 'member' })
    expect((await mountSettings()).text()).not.toContain('Workspace')
  })
})

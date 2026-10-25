/**
 * A space's Settings page (2026-10-24), the last entry of the space's group
 * in the rail. Everything on it is a `space_write` op, the same an agent
 * sends, so these pin that each control sends the op the MCP tool would:
 * name and description, lists, the done window, archive and delete. And that
 * it shows what is in force, not a default, because a page saying "14 days"
 * over a space set to 30 is a page lying about the board.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Component } from 'vue'
import { NbSelect as Select } from '@nubisco/ui'

const overview = vi.fn()
const spaceGet = vi.fn()
const spaceWrite = vi.fn(async (ops: unknown[]) => ({
  results: ops.map(() => ({ ok: true })),
}))
const me = vi.fn()
const push = vi.fn()

vi.mock('@/api/client', () => ({
  api: { overview, spaceGet, spaceWrite },
  auth: { me },
  newOpId: () => 'op',
  getWorkspaceSlug: () => 'acme',
  ApiHttpError: class extends Error {},
}))

const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery.value, params: {} }),
  useRouter: () => ({ push, replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}))

const LISTS = [
  { id: 'l1', name: 'To Do', role: 'backlog', items: 2 },
  { id: 'l2', name: 'Done', role: 'done', items: 0 },
]

const OVERVIEW = {
  workspace: { id: 'w', name: 'Acme' },
  spaces: [{ key: 'ST', name: 'Studio', lists: LISTS }],
  labels: [],
  actors: [],
  policy: { comment_delete: 'author' },
}

beforeAll(async () => {
  await import('@/views/SpaceSettingsView.vue')
})

beforeEach(() => {
  vi.clearAllMocks()
  routeQuery.value = {}
  overview.mockResolvedValue(OVERVIEW)
  me.mockResolvedValue({ id: 'a1', handle: 'ivan', role: 'admin' })
  spaceGet.mockResolvedValue({
    space: {
      key: 'ST',
      name: 'Studio',
      description: 'What the studio ships.',
      done_window_days: 30,
    },
    items: [],
  })
})

async function mountPage(
  spaceKey = 'ST',
  stubs: Record<string, Component | boolean> = {},
) {
  vi.resetModules()
  const View = (await import('@/views/SpaceSettingsView.vue')).default
  const { useWorkspace } = await import('@/stores/workspace')
  const ws = useWorkspace()
  await ws.refresh()
  await ws.loadMe()
  const wrapper = mount(View, {
    props: { spaceKey },
    attachTo: document.body,
    global: { stubs },
  })
  await flushPromises()
  return wrapper
}

const field = (wrapper: Awaited<ReturnType<typeof mountPage>>, id: string) =>
  wrapper.find(`#${id}`).element as HTMLInputElement

const ops = () => spaceWrite.mock.calls.flatMap((c) => c[0] as object[])

describe('the space settings page', () => {
  it('shows the name, the key it cannot change, and the description', async () => {
    const wrapper = await mountPage()
    expect(field(wrapper, 'space-settings-name').value).toBe('Studio')
    const key = field(wrapper, 'space-settings-key')
    expect(key.value).toBe('ST')
    expect(key.readOnly).toBe(true)
    expect(field(wrapper, 'space-settings-description').value).toBe(
      'What the studio ships.',
    )
    expect(spaceGet).toHaveBeenCalledWith('ST', { limit: '1', state: 'all' })
    wrapper.unmount()
  })

  it('saves the name and description as one update', async () => {
    const wrapper = await mountPage()
    await wrapper.find('#space-settings-name').setValue('Studio work')
    await wrapper.find('#space-settings-description').setValue('Everything.')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(ops()).toEqual([
      {
        op: 'update',
        op_id: 'op',
        key: 'ST',
        name: 'Studio work',
        description: 'Everything.',
      },
    ])
    wrapper.unmount()
  })

  it('lists the lists, and will not archive one that holds cards', async () => {
    const wrapper = await mountPage()
    expect(field(wrapper, 'list-name-l1').value).toBe('To Do')
    expect(field(wrapper, 'list-name-l2').value).toBe('Done')
    const archive = (name: string) =>
      wrapper.find(`[aria-label="Archive list ${name}"]`)
    expect(archive('To Do').attributes('disabled')).toBeDefined()
    expect(archive('Done').attributes('disabled')).toBeUndefined()
    await archive('Done').trigger('click')
    await flushPromises()
    expect(ops()).toEqual([
      { op: 'list_archive', op_id: 'op', space: 'ST', list: 'l2' },
    ])
    wrapper.unmount()
  })

  it('renames a list when its name is changed', async () => {
    const wrapper = await mountPage()
    const input = wrapper.find('#list-name-l1')
    // setValue fires input and then change, as leaving the field does.
    await input.setValue('Next')
    await flushPromises()
    expect(ops()).toEqual([
      {
        op: 'list_update',
        op_id: 'op',
        space: 'ST',
        list: 'l1',
        name: 'Next',
      },
    ])
    wrapper.unmount()
  })

  it('adds a list with the role picked for it', async () => {
    const wrapper = await mountPage()
    await wrapper.find('#space-settings-new-list').setValue('Ideas')
    await wrapper.findAll('form')[1].trigger('submit')
    await flushPromises()
    expect(ops()).toEqual([
      {
        op: 'list_create',
        op_id: 'op',
        space: 'ST',
        name: 'Ideas',
        role: 'backlog',
      },
    ])
    wrapper.unmount()
  })

  it('shows the done window in force, and saves a new one', async () => {
    const wrapper = await mountPage()
    const select = wrapper
      .findAllComponents(Select)
      .find((c) => c.props('id') === 'space-settings-done-window')!
    expect(select.props('modelValue')).toBe('30')
    select.vm.$emit('update:modelValue', 'never')
    await flushPromises()
    expect(ops()).toEqual([
      { op: 'update', op_id: 'op', key: 'ST', done_window_days: null },
    ])
    wrapper.unmount()
  })

  it('keeps delete for an empty space, and offers archive', async () => {
    const wrapper = await mountPage()
    const button = (text: string) =>
      wrapper.findAll('button').find((b) => b.text() === text)
    expect(button('Archive space')).toBeDefined()
    // Two cards in To Do: archive first, as on the board's menu.
    expect(button('Delete space')?.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('offers restore on an archived space', async () => {
    overview.mockResolvedValue({
      ...OVERVIEW,
      spaces: [{ ...OVERVIEW.spaces[0], archived: true }],
    })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('This space is archived')
    const restore = wrapper
      .findAll('button')
      .find((b) => b.text() === 'Restore space')!
    await restore.trigger('click')
    await flushPromises()
    expect(ops()).toEqual([{ op: 'restore', op_id: 'op', key: 'ST' }])
    wrapper.unmount()
  })

  it('says so when there is no such space', async () => {
    const wrapper = await mountPage('NOPE')
    expect(wrapper.text()).toContain('No such space')
    wrapper.unmount()
  })
})

/**
 * Labels and automation for one space moved here from workspace Settings
 * (Jose, 2026-10-24), as tabs beside General, with the tab in the URL so the
 * pointers left in workspace Settings land on the right one.
 */
describe('the labels and automation of the space', () => {
  const sections = {
    SettingsLabels: {
      props: ['space'],
      template: '<div class="stub-labels">labels of {{ space }}</div>',
    },
    SettingsAutomation: {
      props: ['space'],
      template: '<div class="stub-automation">automation of {{ space }}</div>',
    },
  }

  it('opens on General, with neither section showing', async () => {
    const wrapper = await mountPage('ST', sections)
    expect(wrapper.find('#space-settings-name').exists()).toBe(true)
    expect(wrapper.find('.stub-labels').exists()).toBe(false)
    expect(wrapper.find('.stub-automation').exists()).toBe(false)
  })

  it("lands on the space's labels from ?tab=labels", async () => {
    routeQuery.value = { tab: 'labels' }
    const wrapper = await mountPage('ST', sections)
    expect(wrapper.find('.stub-labels').text()).toBe('labels of ST')
    expect(wrapper.find('#space-settings-name').exists()).toBe(false)
  })

  it("lands on the space's automation from ?tab=automation", async () => {
    routeQuery.value = { tab: 'automation' }
    const wrapper = await mountPage('ST', sections)
    expect(wrapper.find('.stub-automation').text()).toBe('automation of ST')
  })

  it('no longer sends people to workspace Settings for them', async () => {
    const wrapper = await mountPage('ST', sections)
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href') ?? '')
    expect(hrefs.some((h) => h.includes('/settings?tab='))).toBe(false)
  })
})

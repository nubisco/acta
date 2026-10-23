/**
 * The workspace list, reached two ways. As the entry point, with no workspace
 * open, one workspace means no question at all. From the rail, with one open,
 * it always lists, marks the open one, and choosing switches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'

const push = vi.fn()
const replace = vi.fn()
const query = ref<Record<string, string>>({})
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace }),
  useRoute: () => ({
    get query() {
      return query.value
    },
  }),
}))

const slug = ref('')
let list = [{ id: 'w1', name: 'Acme', slug: 'acme' }]
vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    me: computed(() => ({ id: 'a1' })),
    loadMe: vi.fn(async () => true),
    workspaceSlug: computed(() => slug.value),
    listWorkspaces: vi.fn(async () => list),
  }),
}))

import WorkspacesView from '@/views/WorkspacesView.vue'

beforeEach(() => {
  push.mockReset()
  replace.mockReset()
  query.value = {}
  slug.value = ''
  list = [{ id: 'w1', name: 'Acme', slug: 'acme' }]
})

describe('the workspace list', () => {
  it('walks straight through a single workspace at the entry point', async () => {
    mount(WorkspacesView)
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/acme')
  })

  it('lists even a single workspace when reached from the rail', async () => {
    slug.value = 'acme'
    const wrapper = mount(WorkspacesView)
    await flushPromises()
    expect(replace).not.toHaveBeenCalled()
    expect(wrapper.find('h1').text()).toBe('Workspaces')
    expect(wrapper.find('[data-workspace="acme"]').text()).toContain('Current')
  })

  it('switches to the workspace chosen', async () => {
    slug.value = 'acme'
    list = [
      { id: 'w1', name: 'Acme', slug: 'acme' },
      { id: 'w2', name: 'Globex', slug: 'globex' },
    ]
    const wrapper = mount(WorkspacesView)
    await flushPromises()
    const other = wrapper.find('[data-workspace="globex"]')
    expect(other.text()).not.toContain('Current')
    await other.trigger('click')
    expect(push).toHaveBeenCalledWith('/globex')
  })

  it('resumes a deep link that arrived without a workspace', async () => {
    query.value = { to: '/s/ST?item=ST-4' }
    list = [
      { id: 'w1', name: 'Acme', slug: 'acme' },
      { id: 'w2', name: 'Globex', slug: 'globex' },
    ]
    const wrapper = mount(WorkspacesView)
    await flushPromises()
    expect(wrapper.find('h1').text()).toBe('Choose a workspace')
    await wrapper.find('[data-workspace="globex"]').trigger('keydown', {
      key: 'Enter',
    })
    expect(push).toHaveBeenCalledWith('/globex/s/ST?item=ST-4')
  })
})

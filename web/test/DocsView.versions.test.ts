/**
 * Who saved a version.
 *
 * The history table named the author by the handle the revision is keyed by,
 * which is storage. A person is an avatar and a name here as everywhere else.
 */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, ref } from 'vue'

const docGet = vi.fn(async () => ({
  slug: 'runbook',
  title: 'Runbook',
  tags: [],
  rev: 2,
  updated: 0,
  body: 'Short enough to render fast.',
  attachments: [],
  backlinks: [],
  versions: [{ rev: 1, handle: 'ivan', created_at: Date.now() }],
  comments: [],
}))

vi.mock('@/api/client', () => ({
  api: {
    docGet: (...args: unknown[]) => docGet(...(args as [])),
    docWrite: vi.fn(async () => ({ results: [{ ok: true }] })),
    search: vi.fn(async () => ({ results: [] })),
  },
  newOpId: () => 'op-test',
  ApiHttpError: class extends Error {
    status = 0
  },
}))

vi.mock('@/lib/commands', () => ({ useViewCommands: () => undefined }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} }),
  onBeforeRouteLeave: () => undefined,
}))

vi.mock('@/components/DocsTreePanel.vue', () => ({
  default: { name: 'DocsTreePanelStub', render: () => null },
}))

// The page's actions live in a shell slot, so without an outlet that renders
// its children the history button exists nowhere.
vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const Outlet = defineComponent({
    name: 'ShellSlotOutletStub',
    setup:
      (_props, { slots }) =>
      () =>
        slots.default?.(),
  })
  return { ...actual, useShellSlot: () => ({ Outlet }) }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    me: computed(() => ({
      id: 'a',
      handle: 'jose',
      scopes: ['read', 'write'],
    })),
    overview: ref({
      actors: [
        { id: 'a1', handle: 'ivan', kind: 'human', name: 'Ivan Petrov' },
      ],
    }),
    onLive: () => () => undefined,
  }),
  useInspector: () => ({ open: vi.fn() }),
  useDocPreview: () => ({ open: vi.fn() }),
}))

const DocsView = (await import('@/views/DocsView.vue')).default

describe('the version history table', () => {
  it('names the author with their face, not their handle', async () => {
    const view = mount(DocsView, {
      props: { slug: 'runbook' },
      attachTo: document.body,
    })
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 30))

    await view
      .findAll('button')
      .find((b) => b.text().includes('Version history'))!
      .trigger('click')
    await flushPromises()

    const history = view.find('.docs__history')
    expect(history.exists()).toBe(true)
    expect(history.text()).toContain('Ivan Petrov')
    expect(history.text()).not.toContain('@ivan')
    expect(history.find('.avatar').exists()).toBe(true)
    view.unmount()
  })
})

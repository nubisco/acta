/**
 * The board, the filter and the table when two groups hold the same value.
 *
 * The inspector was taught to resolve a label by id when groups landed. The
 * board was not, and it is where the problem is loudest: "Affects version"
 * and "Fixes version" both list 1.12.0, so a card carrying both drew the
 * same chip twice, a filter on the name matched either of them, and a
 * swimlane by label poured both into one band.
 *
 * Every assertion here fails against the by-name code, which is the point.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'

const spaceGet = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    itemWrite: vi.fn(async () => ({ results: [{ op_id: 'x', ok: true }] })),
    spaceGet: (...args: unknown[]) => spaceGet(...(args as [])),
  },
  newOpId: () => 'op-test',
  getWorkspaceSlug: () => 'nubisco',
}))

vi.mock('@/lib/commands', () => ({ useViewCommands: () => undefined }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {}, params: { spaceKey: 'ST' } }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

// As in SpaceView.test.ts: the toolbar and the side panel teleport into
// regions that only exist under a mounted NbShell.
vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const Outlet = defineComponent({
    name: 'ShellSlotOutletStub',
    setup:
      (_p, { slots }) =>
      () =>
        slots.default?.(),
  })
  return { ...actual, useShellSlot: () => ({ Outlet }) }
})

/** Same colour per group, different groups, one shared set of values. */
const LABELS = [
  {
    id: 'aff-1120',
    group_id: 'lgr_affects',
    group_name: 'Affects version',
    name: '1.12.0',
    color: 'orange',
    space_key: 'ST',
  },
  {
    id: 'fix-1120',
    group_id: 'lgr_fixes',
    group_name: 'Fixes version',
    name: '1.12.0',
    color: 'blue',
    space_key: 'ST',
    exclusive: true as const,
  },
]

const overview = {
  spaces: [
    {
      key: 'ST',
      name: 'Stagewright',
      lists: [{ id: 'l1', name: 'Doing', role: 'active', items: 1 }],
    },
  ],
  labels: LABELS,
  actors: [],
  doc_roots: [],
}

/** One card carrying 1.12.0 from both groups, which is the whole case. */
const ITEM = {
  key: 'ST-73',
  title: 'First customer reward',
  list: 'Doing',
  labels: ['1.12.0', '1.12.0'],
  label_ids: ['aff-1120', 'fix-1120'],
  assignees: [],
  rev: 1,
  updated: Date.now(),
  pos: 1,
}

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: ref(overview),
    onLive: () => () => undefined,
  }),
  useUiState: () => ({ newSpaceOpen: ref(false), revealCard: ref(null) }),
  useInspector: () => ({ open: vi.fn(), itemKey: ref(null) }),
}))

async function render(): Promise<VueWrapper> {
  spaceGet.mockResolvedValue({ items: [ITEM] })
  const SpaceView = (await import('@/views/SpaceView.vue')).default
  const view = mount(SpaceView, {
    props: { spaceKey: 'ST' },
    global: { stubs: { teleport: true, RouterLink: true } },
  })
  await flushPromises()
  return view
}

/** The toolbar's single filter control. */
function filtersButton(view: VueWrapper) {
  return view
    .findAll('.space__filters button')
    .find((b) => b.text().includes('Labels'))!
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a board where two groups hold the same value', () => {
  it('says which group each chip answers', async () => {
    const view = await render()
    const chips = view.findAll('.board-card__labels .nb-badge')
    const text = chips.map((c) => c.text())
    // The exclusive group reads as the field it is. The other stays a tag,
    // which keeps the common case quiet.
    expect(text).toContain('Fixes version: 1.12.0')
    expect(text).toContain('1.12.0')
    // Two chips, not one name drawn twice with no way to tell them apart.
    expect(new Set(text).size).toBe(2)
  })

  it('colours each chip from its own group', async () => {
    const view = await render()
    const chips = view.findAll('.board-card__labels .nb-badge')
    const classes = chips.map((c) => c.classes().join(' '))
    expect(classes.some((c) => c.includes('orange'))).toBe(true)
    expect(classes.some((c) => c.includes('blue'))).toBe(true)
  })

  it('filters by the group you picked, not by every group with that name', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()
    spaceGet.mockClear()

    const pills = view.findAll('.filters__pill')
    expect(pills).toHaveLength(2)
    await pills[1].trigger('click')
    await flushPromises()

    const [, params] = spaceGet.mock.calls.at(-1) as unknown as [
      string,
      Record<string, string>,
    ]
    expect(params.label).toBe('fix-1120')
  })

  it('tells the two filter pills apart', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()

    const pills = view.findAll('.filters__pill').map((p) => p.text())
    expect(new Set(pills).size).toBe(2)
  })
})

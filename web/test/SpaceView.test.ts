/**
 * The space and its card context menu.
 *
 * The menu tests exist because it shipped inert: `@select="helper(fn)"` runs
 * the helper when the event fires and throws away the closure it returns, so
 * every entry opened, closed, and did nothing. No error, no console output.
 * Only clicking a real entry and asserting the write catches that.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'

const itemWrite = vi.fn(async () => ({ results: [{ op_id: 'x', ok: true }] }))
const spaceGet = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    itemWrite: (...args: unknown[]) => itemWrite(...(args as [])),
    spaceGet: (...args: unknown[]) => spaceGet(...(args as [])),
  },
  newOpId: () => 'op-test',
  getWorkspaceSlug: () => 'nubisco',
}))

vi.mock('@/lib/commands', () => ({ useViewCommands: () => undefined }))

// Shell-slot outlets teleport into regions that only exist once NbShell is
// mounted, so without this the toolbar and the side panel render nowhere and
// every assertion about them passes against an empty wrapper. Only the
// composable is replaced; every other export stays real.
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

const overview = {
  spaces: [
    {
      key: 'SU',
      name: 'Support',
      lists: [
        { id: 'l1', name: 'Backlog', role: 'backlog', items: 3 },
        { id: 'l2', name: 'Doing', role: 'active', items: 0 },
      ],
    },
  ],
  labels: [
    { name: 'Urgent', color: 'red', space_key: null },
    { name: 'Tech debt', color: 'yellow', space_key: 'SU' },
  ],
  actors: [
    { handle: 'jose', name: 'Jose', kind: 'human' },
    { handle: 'acta', name: 'Acta', kind: 'system' },
  ],
}

// Shared so a test can point the panel at a card and assert the space marks
// it, the same way `overview` above is shared: vi.mock's factory runs at
// import time, after these declarations.
const inspectorMock = {
  open: vi.fn(),
  close: vi.fn(),
  // A real ref, not a plain object: the space watches this to put the filter
  // panel away, and a watcher on a non-reactive field never fires, which made
  // the rule look enforced when nothing was enforcing it.
  itemKey: ref<string | null>(null),
}

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: { value: overview },
    onLive: () => () => undefined,
  }),
  useUiState: () => ({ newSpaceOpen: { value: false } }),
  useInspector: () => inspectorMock,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {}, params: { spaceKey: 'SU' } }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const items = [
  {
    key: 'SU-1',
    title: 'First',
    list: 'Backlog',
    rev: 1,
    updated: 1,
    pos: 1024,
  },
  {
    key: 'SU-2',
    title: 'Middle',
    list: 'Backlog',
    rev: 1,
    updated: 1,
    pos: 2048,
  },
  {
    key: 'SU-3',
    title: 'Last',
    list: 'Backlog',
    rev: 1,
    updated: 1,
    pos: 3072,
    archived: true,
  },
]

import SpaceView from '@/views/SpaceView.vue'

async function render() {
  spaceGet.mockResolvedValue({ items, cursor: undefined })
  const view = mount(SpaceView, {
    props: { spaceKey: 'SU' },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return view
}

/** The toolbar's single filter control. */
function filtersButton(view: ReturnType<typeof mount>) {
  return view
    .findAll('.space__filters button')
    .find((b) => b.text().includes('Filters'))!
}

/** Right-click a card by its title and return the menu entries. */
async function openMenu(
  view: Awaited<ReturnType<typeof render>>,
  title: string,
) {
  const card = view
    .findAll('.space__card')
    .find((c) => c.text().includes(title))
  await card!.trigger('contextmenu')
  await view.vm.$nextTick()
  return view.findAll('.nb-menu-item')
}

describe('SpaceView card menu', () => {
  beforeEach(() => {
    itemWrite.mockClear()
    spaceGet.mockClear()
    inspectorMock.itemKey.value = null
    inspectorMock.open.mockClear()
    inspectorMock.close.mockClear()
  })

  it('moving to the top actually writes a move', async () => {
    const view = await render()
    const entries = await openMenu(view, 'Last')
    const top = entries.find((e) => e.text().includes('Move to top'))
    await top!.trigger('click')
    await flushPromises()

    expect(itemWrite).toHaveBeenCalledTimes(1)
    const [ops] = itemWrite.mock.calls[0] as unknown as [
      { op: string; key: string; list: string; pos: number }[],
    ]
    expect(ops[0].op).toBe('move')
    expect(ops[0].key).toBe('SU-3')
    // Half the current first, so it lands above without renumbering anything.
    expect(ops[0].pos).toBe(512)
  })

  it('moving to the bottom lands past the current last', async () => {
    const view = await render()
    const entries = await openMenu(view, 'First')
    await entries
      .find((e) => e.text().includes('Move to bottom'))!
      .trigger('click')
    await flushPromises()
    const [ops] = itemWrite.mock.calls[0] as unknown as [{ pos: number }[]]
    expect(ops[0].pos).toBe(3072 + 1024)
  })

  it('does not offer a move that would change nothing', async () => {
    const view = await render()
    const first = await openMenu(view, 'First')
    expect(
      first
        .find((e) => e.text().includes('Move to top'))!
        .attributes('aria-disabled'),
    ).toBe('true')
  })

  it('offers archive on a live card and restore plus delete on an archived one', async () => {
    const view = await render()
    const live = (await openMenu(view, 'First')).map((e) => e.text())
    expect(live.join(' ')).toContain('Archive')
    expect(live.join(' ')).not.toContain('Delete card')

    const archived = (await openMenu(view, 'Last')).map((e) => e.text())
    expect(archived.join(' ')).toContain('Restore')
    // Delete is only ever offered once a card is archived: the server refuses
    // it otherwise, and the menu should not offer what will be refused.
    expect(archived.join(' ')).toContain('Delete card')
  })

  it('archiving writes an archive op', async () => {
    const view = await render()
    const entries = await openMenu(view, 'First')
    await entries.find((e) => e.text().trim() === 'Archive')!.trigger('click')
    await flushPromises()
    const [ops] = itemWrite.mock.calls[0] as unknown as [{ op: string }[]]
    expect(ops[0].op).toBe('archive')
  })

  // The details panel gained a close button, and closing has to be visible on
  // the space: with nothing marking the open card, the panel could have been
  // describing any of them and there was nothing for closing to undo.
  it('marks the card the details panel is showing, and only that one', async () => {
    inspectorMock.itemKey.value = 'SU-1'
    const view = await render()

    const open = view.findAll('.space__card--open')
    expect(open).toHaveLength(1)
    expect(open[0].text()).toContain('First')
    expect(open[0].attributes('aria-current')).toBe('true')
  })

  it('marks nothing when the details panel is closed', async () => {
    const view = await render()
    expect(view.findAll('.space__card--open')).toHaveLength(0)
    expect(view.find('.space__card').attributes('aria-current')).toBeUndefined()
  })

  // Four dropdowns competing for a toolbar row is what this replaces, so the
  // first thing worth asserting is that they are actually gone.
  it('collapses the filter dropdowns into one Filters button', async () => {
    const view = await render()
    const bar = view.find('.space__filters')

    expect(bar.text()).toContain('Filters')
    expect(bar.find('#field-filter-label').exists()).toBe(false)
    expect(bar.find('#field-filter-assignee').exists()).toBe(false)
    expect(bar.find('#field-filter-state').exists()).toBe(false)
    // Free-text stays on the toolbar: it is the one filter you use by typing
    // and burying it behind a click would cost more than it saves.
    expect(bar.find('#field-filter-text').exists()).toBe(true)
  })

  it('opens the panel on click, with labels as pills and people as avatars', async () => {
    const view = await render()
    expect(view.find('#space-filter-panel').exists()).toBe(false)

    await filtersButton(view).trigger('click')
    await flushPromises()

    const panel = view.find('#space-filter-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Urgent')
    expect(panel.text()).toContain('Tech debt')
    // The system actor is not a person and must not be offered as one.
    expect(
      panel.find('[aria-label="Filter by assignee"]').text(),
    ).not.toContain('Acta')
  })

  it('filters by several labels at once and asks the server for any of them', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()
    spaceGet.mockClear()

    const pills = view.findAll('.filters__pill')
    await pills[0].trigger('click')
    await pills[1].trigger('click')
    await flushPromises()

    const [, params] = spaceGet.mock.calls.at(-1) as unknown as [
      string,
      Record<string, string>,
    ]
    expect(params.label).toBe('Urgent,Tech debt')
  })

  it('counts what is filtered on the button', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()

    expect(filtersButton(view).text()).not.toMatch(/\d/)
    await view.findAll('.filters__pill')[0].trigger('click')
    await flushPromises()
    expect(filtersButton(view).text()).toContain('1')
  })

  // Filters live in the toolbar now, not the side panel, so the two no
  // longer compete: a card and its filters can be on screen together, which
  // is the point of moving them.
  it('keeps the filters open while a card is open', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()
    expect(view.find('#space-filter-panel').exists()).toBe(true)

    inspectorMock.itemKey.value = 'SU-1'
    await flushPromises()

    expect(view.find('#space-filter-panel').exists()).toBe(true)
    expect(inspectorMock.close).not.toHaveBeenCalled()
  })

  // In the view's own toolbar, not teleported into the shell's side panel,
  // which is where it rendered inert and invisible before.
  it('renders the filters inside the space, not the side panel', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()

    const panel = view.find('#space-filter-panel')
    expect(panel.exists()).toBe(true)
    expect(view.find('.space__bar').element.parentElement).toBe(
      panel.element.parentElement,
    )
  })
})

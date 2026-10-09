/**
 * The space and its card context menu.
 *
 * The menu tests exist because it shipped inert: `@select="helper(fn)"` runs
 * the helper when the event fires and throws away the closure it returns, so
 * every entry opened, closed, and did nothing. No error, no console output.
 * Only clicking a real entry and asserting the write catches that.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import {
  NO_FILTERS,
  forgetBoardFilters,
  recallBoardFilters,
  rememberBoardFilters,
} from '@/lib/boardFilters'

const reveal = vi.hoisted(() => ({
  value: null as { key: string; at: number } | null,
}))
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
  // With ids and groups, because that is what the catalogue carries: a
  // label is filtered and rendered by id now, since a bare name cannot say
  // which group a value belongs to.
  labels: [
    {
      id: 'lbl_urgent',
      group_id: 'lgr_tags',
      group_name: 'Tags',
      name: 'Urgent',
      color: 'red',
      space_key: null,
    },
    {
      id: 'lbl_debt',
      group_id: 'lgr_tags',
      group_name: 'Tags',
      name: 'Tech debt',
      color: 'yellow',
      space_key: 'SU',
    },
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
  onCardPatched: () => () => {},
  patchCard: () => {},
  useWorkspace: () => ({
    overview: { value: overview },
    onLive: () => () => undefined,
  }),
  useUiState: () => ({
    newSpaceOpen: { value: false },
    revealCard: reveal,
  }),
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
  // Copies: the board moves cards in place, and a shared fixture would carry
  // one test's drag into the next.
  spaceGet.mockResolvedValue({
    items: items.map((i) => ({ ...i })),
    cursor: undefined,
  })
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
    .find((b) => b.text().includes('Labels'))!
}

/** Right-click a card by its title and return the menu entries. */
async function openMenu(
  view: Awaited<ReturnType<typeof render>>,
  title: string,
) {
  const card = view.findAll('.board-card').find((c) => c.text().includes(title))
  await card!.find('.board-card__open').trigger('contextmenu')
  await view.vm.$nextTick()
  return view.findAll('.nb-menu-item')
}

describe('SpaceView card menu', () => {
  beforeEach(() => {
    forgetBoardFilters()
    reveal.value = null
    itemWrite.mockClear()
    spaceGet.mockClear()
    inspectorMock.itemKey.value = null
    inspectorMock.open.mockClear()
    inspectorMock.close.mockClear()
  })

  // Jose, 2026-10-09: the board flashed because every drag reloaded every
  // card. The card is already where it was dropped; the write is enough.
  it('moves a dropped card with one write and no reload', async () => {
    const view = await render()
    spaceGet.mockClear()
    view.findComponent({ name: 'Board' }).vm.$emit('move', {
      itemId: 'SU-1',
      toColumnId: 'Doing',
      beforeItemId: null,
      afterItemId: null,
    })
    await flushPromises()
    expect(itemWrite).toHaveBeenCalledTimes(1)
    expect(spaceGet).not.toHaveBeenCalled()
    const card = view.find('[data-card-key="SU-1"]')
    expect(card.exists()).toBe(true)
  })

  it('while sorted, a drop in the same column changes nothing, and in another goes last', async () => {
    window.localStorage.setItem('acta:board-sort:nubisco/SU', 'updated')
    const view = await render()
    const board = view.findComponent({ name: 'Board' })
    board.vm.$emit('move', {
      itemId: 'SU-2',
      toColumnId: 'Backlog',
      beforeItemId: null,
      afterItemId: 'SU-1',
    })
    await flushPromises()
    expect(itemWrite).not.toHaveBeenCalled()
    board.vm.$emit('move', {
      itemId: 'SU-1',
      toColumnId: 'Doing',
      beforeItemId: null,
      afterItemId: null,
    })
    await flushPromises()
    const [ops] = itemWrite.mock.calls.at(-1) as unknown as [
      { op: string; list: string; pos: number }[],
    ]
    expect(ops[0]).toMatchObject({ op: 'move', list: 'Doing' })
    window.localStorage.removeItem('acta:board-sort:nubisco/SU')
    view.unmount()
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

    const open = view.findAll('.board-card--open')
    expect(open).toHaveLength(1)
    expect(open[0].text()).toContain('First')
    expect(open[0].find('.board-card__open').attributes('aria-current')).toBe(
      'true',
    )
  })

  it('marks nothing when the details panel is closed', async () => {
    const view = await render()
    expect(view.findAll('.board-card--open')).toHaveLength(0)
    expect(
      view.find('.board-card__open').attributes('aria-current'),
    ).toBeUndefined()
  })

  // Opening a dropdown for every change of person or status was the
  // problem (Jose, 2026-10-09): only labels, too many for a bar, stay behind
  // a button. Everything else is in the bar, always visible.
  it('keeps people, status and search in the bar, and labels behind a button', async () => {
    const view = await render()
    const bar = view.find('.space__filters')

    expect(bar.find('#field-filter-text').exists()).toBe(true)
    expect(bar.find('#field-space-filter-state').exists()).toBe(true)
    const people = bar.find('[aria-label="Filter by assignee"]')
    expect(people.exists()).toBe(true)
    // The system actor is not a person and must not be offered as one.
    expect(people.html()).not.toContain('Acta')
    expect(filtersButton(view).exists()).toBe(true)
    expect(view.find('#space-filter-panel').exists()).toBe(false)
  })

  it('opens the labels on click, as coloured pills', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()

    const panel = view.find('#space-filter-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Urgent')
    expect(panel.text()).toContain('Tech debt')
    expect(panel.find('[aria-label="Filter by assignee"]').exists()).toBe(false)
  })

  it('offers to clear once anything is filtered', async () => {
    const view = await render()
    const clear = () =>
      view
        .findAll('.space__filters button')
        .find((b) => b.text() === 'Clear filters')
    expect(clear()).toBeUndefined()
    await filtersButton(view).trigger('click')
    await flushPromises()
    await view.findAll('.filters__pill')[0].trigger('click')
    await flushPromises()
    expect(clear()).toBeDefined()
    await clear()!.trigger('click')
    await flushPromises()
    expect(filtersButton(view).text()).not.toMatch(/\d/)
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
    // Ids on the wire. The server takes either, and a name would filter on
    // every group that happens to hold it.
    expect(params.label).toBe('lbl_urgent,lbl_debt')
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

  /**
   * Attached to the button that opens it.
   *
   * It has been in two wrong places: the shell's side panel, where it
   * displaced the card you had open and rendered inert when no card was
   * open at all, and the toolbar row, where it was a sibling of the tabs and
   * so drew a full-width panel beside them rather than under anything.
   */
  it('opens the filters in a dropdown on their own button', async () => {
    const view = await render()
    await filtersButton(view).trigger('click')
    await flushPromises()

    const panel = view.find('#space-filter-panel')
    expect(panel.exists()).toBe(true)
    // Inside the menu, not loose in the view's layout.
    expect(panel.element.closest('.nb-menu')).not.toBeNull()
  })
})

/**
 * A lane grouped by assignee is a lane about a person, and it used to be
 * headed by the raw `@handle` the storage uses.
 */
describe('SpaceView swimlanes', () => {
  async function grouped() {
    spaceGet.mockResolvedValue({
      items: [{ ...items[0], assignees: ['jose'] }],
      cursor: undefined,
    })
    const view = mount(SpaceView, {
      props: { spaceKey: 'SU' },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()

    // Driven through the select rather than through its dropdown, which
    // teleports out of the view and needs a real layout to open.
    const swimlanes = view
      .findAllComponents({ name: 'Select' })
      .find((s) =>
        (s.props('options') as { value: string }[]).some(
          (o) => o.value === 'assignee',
        ),
      )!
    swimlanes.vm.$emit('update:modelValue', 'assignee')
    await flushPromises()
    return view
  }

  it('heads an assignee lane with the person, not their handle', async () => {
    const view = await grouped()
    const header = view.find('.nb-board__lane-header')
    expect(header.exists()).toBe(true)
    expect(header.text()).toContain('Jose')
    expect(header.text()).not.toContain('@jose')
    expect(header.find('.avatar').exists()).toBe(true)
  })
})

/**
 * Hierarchy on the board.
 *
 * A card that is part of something, or has parts, has to say so without being
 * opened: that is the only way the relation is visible while working a space,
 * and the counts come from the board read rather than from a per-card fetch.
 */
describe('SpaceView card hierarchy', () => {
  async function withHierarchy() {
    spaceGet.mockResolvedValue({
      items: [
        { ...items[0], parts_total: 3, parts_done: 1 },
        { ...items[1], parent_key: 'SU-1' },
      ],
      cursor: undefined,
    })
    const view = mount(SpaceView, {
      props: { spaceKey: 'SU' },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    return view
  }

  it('says how much of a card is done when it has parts', async () => {
    const view = await withHierarchy()
    const card = view
      .findAll('.board-card')
      .find((c) => c.text().includes('First'))!
    expect(card.text()).toContain('1/3')
    const chip = card
      .findAll('.board-card__count')
      .find((c) => c.attributes('aria-label')?.includes('parts done'))
    expect(chip?.attributes('aria-label')).toBe('1 of 3 parts done')
  })

  it('names what a card is part of', async () => {
    const view = await withHierarchy()
    const card = view
      .findAll('.board-card')
      .find((c) => c.text().includes('Middle'))!
    const chip = card
      .findAll('.board-card__chip')
      .find((c) => c.attributes('aria-label')?.startsWith('Part of'))
    expect(chip?.attributes('aria-label')).toBe('Part of SU-1')
    expect(chip?.text()).toContain('SU-1')
  })

  // Zero is noise on the many cards that are in no hierarchy at all.
  it('says nothing on a card that is neither a part nor made of parts', async () => {
    const view = await withHierarchy()
    const card = view
      .findAll('.board-card')
      .find((c) => c.text().includes('First'))!
    expect(
      card
        .findAll('.board-card__chip')
        .some((c) => c.attributes('aria-label')?.startsWith('Part of')),
    ).toBe(false)
  })
})

/**
 * Dropping a card onto another on the board.
 *
 * NbBoard could not express this until 5.9.0, so the board is driven through
 * the component's own `nest` event here rather than through a synthetic drag:
 * the zone arithmetic that decides when to emit it is the library's, and it
 * is tested there.
 */
describe('SpaceView nesting', () => {
  beforeEach(() => {
    itemWrite.mockClear()
  })

  // By its own class, not by name: the component is registered from its file
  // as `Board`, and `.space__board` is the handle this view already owns.
  // The cast is because a selector-based findComponent cannot know what it
  // found, and what it found is NbBoard.
  const board = (view: Awaited<ReturnType<typeof render>>) =>
    view.findComponent('.space__board') as unknown as VueWrapper

  it('asks the board to allow it', async () => {
    const view = await render()
    expect((board(view).props() as Record<string, unknown>).nestable).toBe(true)
  })

  it('makes the dropped card part of the one it landed on', async () => {
    const view = await render()
    board(view).vm.$emit('nest', {
      itemId: 'SU-3',
      ontoItemId: 'SU-1',
      fromColumnId: 'To Do',
    })
    await flushPromises()

    const [ops] = itemWrite.mock.calls[0] as unknown as [
      { op: string; key: string; parent: string }[],
    ]
    expect(ops[0].op).toBe('set_parent')
    expect(ops[0].key).toBe('SU-3')
    expect(ops[0].parent).toBe('SU-1')
  })

  it('does not also move it', async () => {
    const view = await render()
    board(view).vm.$emit('nest', {
      itemId: 'SU-3',
      ontoItemId: 'SU-1',
      fromColumnId: 'To Do',
    })
    await flushPromises()

    // A card dropped onto another has not been given a position. Writing a
    // move as well would reorder it on top of reparenting it.
    const ops = itemWrite.mock.calls.flatMap(
      (call) => (call as unknown as [{ op: string }[]])[0],
    )
    expect(ops.map((o) => o.op)).not.toContain('move')
  })
})

describe('a board keeps its filters', () => {
  beforeEach(() => {
    forgetBoardFilters()
    reveal.value = null
    spaceGet.mockReset()
  })

  /** What the server sends for a request: SU-2 only passes with no label. */
  function serve() {
    spaceGet.mockImplementation(
      async (_space: string, params: Record<string, string>) => ({
        items: params.label ? items.slice(0, 1) : items.slice(0, 2),
      }),
    )
  }

  const lastParams = () =>
    (
      spaceGet.mock.calls.at(-1) as unknown as [string, Record<string, string>]
    )[1]

  it('comes back with the filters it was left with', async () => {
    serve()
    rememberBoardFilters('SU', {
      ...NO_FILTERS,
      labels: ['lbl_urgent'],
      assignees: ['jose'],
    })
    const view = mount(SpaceView, {
      props: { spaceKey: 'SU' },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    // The very first load already asks for them: no unfiltered flash.
    expect(spaceGet).toHaveBeenCalledTimes(1)
    expect(lastParams().label).toBe('lbl_urgent')
    expect(lastParams().assignee).toBe('jose')
    expect(filtersButton(view).text()).toContain('1')
    view.unmount()
  })

  it('remembers a filter as it is set, and never lends it to another board', async () => {
    serve()
    const view = mount(SpaceView, {
      props: { spaceKey: 'SU' },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    await filtersButton(view).trigger('click')
    await flushPromises()
    await view.findAll('.filters__pill')[0].trigger('click')
    await flushPromises()
    expect(recallBoardFilters('SU').labels).toEqual(['lbl_urgent'])

    await view.setProps({ spaceKey: 'OPS' })
    await flushPromises()
    expect(lastParams().label).toBeUndefined()

    await view.setProps({ spaceKey: 'SU' })
    await flushPromises()
    expect(lastParams().label).toBe('lbl_urgent')
    view.unmount()
  })

  it('drops them when "Show on board" asks for a card they hide', async () => {
    serve()
    rememberBoardFilters('SU', { ...NO_FILTERS, labels: ['lbl_urgent'] })
    reveal.value = { key: 'SU-2', at: 1 }
    const view = mount(SpaceView, {
      props: { spaceKey: 'SU' },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()

    expect(lastParams().label).toBeUndefined()
    expect(recallBoardFilters('SU').labels).toEqual([])
    expect(
      view.findAll('.board-card').some((c) => c.text().includes('Middle')),
    ).toBe(true)
    expect(reveal.value).toBeNull()
    view.unmount()
  })

  it('keeps them when the card asked for is already showing', async () => {
    serve()
    rememberBoardFilters('SU', { ...NO_FILTERS, labels: ['lbl_urgent'] })
    reveal.value = { key: 'SU-1', at: 1 }
    const view = mount(SpaceView, {
      props: { spaceKey: 'SU' },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    expect(lastParams().label).toBe('lbl_urgent')
    expect(recallBoardFilters('SU').labels).toEqual(['lbl_urgent'])
    view.unmount()
  })
})

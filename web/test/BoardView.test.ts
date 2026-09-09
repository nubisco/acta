/**
 * The board and its card context menu.
 *
 * The menu tests exist because it shipped inert: `@select="helper(fn)"` runs
 * the helper when the event fires and throws away the closure it returns, so
 * every entry opened, closed, and did nothing. No error, no console output.
 * Only clicking a real entry and asserting the write catches that.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const itemWrite = vi.fn(async () => ({ results: [{ op_id: 'x', ok: true }] }))
const boardGet = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    itemWrite: (...args: unknown[]) => itemWrite(...(args as [])),
    boardGet: (...args: unknown[]) => boardGet(...(args as [])),
  },
  newOpId: () => 'op-test',
  getWorkspaceSlug: () => 'nubisco',
}))

vi.mock('@/lib/commands', () => ({ useViewCommands: () => undefined }))

const overview = {
  boards: [
    {
      key: 'SU',
      name: 'Support',
      lists: [
        { id: 'l1', name: 'Backlog', role: 'backlog', items: 3 },
        { id: 'l2', name: 'Doing', role: 'active', items: 0 },
      ],
    },
  ],
  labels: [],
  actors: [],
}

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: { value: overview },
    onLive: () => () => undefined,
  }),
  useUiState: () => ({ newBoardOpen: { value: false } }),
  useInspector: () => ({ open: vi.fn() }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {}, params: { boardKey: 'SU' } }),
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

import BoardView from '@/views/BoardView.vue'

async function render() {
  boardGet.mockResolvedValue({ items, cursor: undefined })
  const view = mount(BoardView, {
    props: { boardKey: 'SU' },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return view
}

/** Right-click a card by its title and return the menu entries. */
async function openMenu(
  view: Awaited<ReturnType<typeof render>>,
  title: string,
) {
  const card = view
    .findAll('.board__card')
    .find((c) => c.text().includes(title))
  await card!.trigger('contextmenu')
  await view.vm.$nextTick()
  return view.findAll('.nb-menu-item')
}

describe('BoardView card menu', () => {
  beforeEach(() => {
    itemWrite.mockClear()
    boardGet.mockClear()
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
})

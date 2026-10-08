/**
 * The goal page's card list: who is on each card, and the work as a tree.
 *
 * Jose: "we need to see exactly who's assigned to a card on a goal, otherwise
 * no one knows which goal card to pick next". And the tree, so a linked card
 * shows what it is made of and what is holding it up, without opening each
 * one in turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { goalCardTree } from '@/lib/goals'
import type { IGoalCard, IGoalDetail } from '@/types/api'

const goalGet = vi.fn()
const inspectorOpen = vi.fn()

vi.mock('@/api/client', () => ({
  api: { goalGet: (...a: unknown[]) => goalGet(...(a as [])) },
  ApiHttpError: class extends Error {},
  newOpId: () => 'op',
  getWorkspaceSlug: () => 'nubisco',
}))

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

vi.mock('vue-router', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useRouter: () => ({ push: vi.fn() }) }
})

const overview = ref({
  actors: [
    { id: 'a1', handle: 'ivan', kind: 'human', name: 'Ivan Petrov' },
    { id: 'a2', handle: 'daniela', kind: 'human', name: 'Daniela Pinho' },
  ],
})

vi.mock('@/stores/workspace', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useWorkspace: () => ({
      overview,
      me: ref({ handle: 'jose' }),
      onLive: () => () => {},
      refresh: vi.fn(),
    }),
    useInspector: () => ({ open: inspectorOpen }),
    useUiState: () => ({ newGoal: ref(null) }),
  }
})

const ITEMS: IGoalCard[] = [
  {
    key: 'ST-1',
    title: 'Release',
    space: 'ST',
    list: 'In Progress',
    active: true,
    size: 3,
    linked: true,
    assignees: ['daniela', 'ivan', 'jose', 'claude'],
    blocked_by: [{ key: 'CMS-9', title: 'Translations land', space: 'CMS' }],
    waiting: true,
  },
  {
    key: 'ST-2',
    title: 'Installer',
    space: 'ST',
    list: 'To Do',
    size: 1,
    via: 'ST-1',
    parent: 'ST-1',
    assignees: ['ivan'],
  },
  {
    key: 'CMS-3',
    title: 'Signing certificate',
    space: 'CMS',
    list: 'To Do',
    size: 1,
    via: 'ST-1',
    parent: 'ST-2',
  },
  {
    key: 'ST-4',
    title: 'Nobody yet',
    space: 'ST',
    list: 'To Do',
    size: 1,
    linked: true,
  },
]

function detail(items: IGoalCard[] = ITEMS): IGoalDetail {
  return {
    number: 1,
    key: 'G-1',
    title: 'Ship 2.0',
    status: 'on_track',
    progress: {
      cards_total: items.length,
      cards_done: 0,
      cards_active: 1,
      cards_waiting: 1,
      cards_overdue: 0,
      weight_total: 6,
      weight_done: 0,
    },
    linked: 2,
    rev: 1,
    updated: 0,
    description: '',
    created: 0,
    followers: [],
    children: [],
    ancestors: [],
    items,
    check_ins: [],
  } as unknown as IGoalDetail
}

async function render() {
  goalGet.mockResolvedValue({ goals: [detail()] })
  const GoalView = (await import('@/views/GoalView.vue')).default
  const view = mount(GoalView, {
    props: { number: 1 },
    attachTo: document.body,
    global: {
      stubs: {
        teleport: true,
        // No ancestors and no sub-goals here, so no link is ever drawn.
        RouterLink: true,
        GoalCardPicker: true,
        GoalCheckInModal: true,
        GoalFormModal: true,
        MarkdownView: true,
      },
    },
  })
  await flushPromises()
  return view
}

const treeButton = () =>
  Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Tree',
  )!

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  document.body.innerHTML = ''
})

describe('who is on each card', () => {
  it('asks for the tree with the first read, so switching needs no second one', async () => {
    const view = await render()
    expect(goalGet).toHaveBeenCalledWith([1], ['items', 'check_ins', 'tree'])
    view.unmount()
  })

  it('shows up to three faces, then how many more', async () => {
    const view = await render()
    const row = view.findAll('tbody tr').find((r) => r.text().includes('ST-1'))!
    expect(row.findAll('.avatar')).toHaveLength(3)
    expect(row.text()).toContain('+1')
    expect(row.text()).not.toContain('Unassigned')
    view.unmount()
  })

  it('says a card nobody is on is unassigned, rather than leaving a gap', async () => {
    const view = await render()
    const row = view.findAll('tbody tr').find((r) => r.text().includes('ST-4'))!
    expect(row.findAll('.avatar')).toHaveLength(0)
    expect(row.text()).toContain('Unassigned')
    expect(row.find('.nb-badge--placeholder').exists()).toBe(true)
    view.unmount()
  })
})

describe('the work as a tree', () => {
  it('switches to a tree, nesting parts at every depth', async () => {
    const view = await render()
    expect(view.find('[role="tree"]').exists()).toBe(false)
    treeButton().click()
    await flushPromises()

    expect(view.find('table').exists()).toBe(false)
    const tree = view.find('[role="tree"]')
    expect(tree.exists()).toBe(true)
    expect(treeButton().getAttribute('aria-pressed')).toBe('true')

    const item = (key: string) =>
      view.find(`li[role="treeitem"][data-key="${key}"]`)
    // Opened all the way down, and the deep part sits under its own parent.
    expect(item('ST-1').attributes('aria-expanded')).toBe('true')
    expect(item('ST-2').attributes('aria-expanded')).toBe('true')
    expect(item('ST-2').find('[data-key="CMS-3"]').exists()).toBe(true)
    expect(item('ST-4').attributes('aria-expanded')).toBeUndefined()
    view.unmount()
  })

  it('marks a blocker in red, even one that does not serve the goal', async () => {
    const view = await render()
    treeButton().click()
    await flushPromises()

    const blocker = view.find('li[data-blocker]')
    expect(blocker.exists()).toBe(true)
    expect(blocker.text()).toContain('Blocked by')
    expect(blocker.text()).toContain('CMS-9')
    expect(blocker.text()).toContain('Translations land')
    expect(blocker.find('.nb-badge--red').exists()).toBe(true)
    // It hangs under the card it holds up.
    expect(
      view
        .find('li[data-key="ST-1"]')
        .find('[role="group"]')
        .find('li[data-blocker]')
        .exists(),
    ).toBe(true)
    view.unmount()
  })

  it('opens a card, or its blocker, in the inspector', async () => {
    const view = await render()
    treeButton().click()
    await flushPromises()

    await view
      .find('li[data-key="CMS-3"] .nb-tree-node__label')
      .trigger('click')
    expect(inspectorOpen).toHaveBeenLastCalledWith('CMS-3')
    await view.find('li[data-blocker] .nb-tree-node__label').trigger('click')
    expect(inspectorOpen).toHaveBeenLastCalledWith('CMS-9')
    view.unmount()
  })

  it('collapses a branch from its caret', async () => {
    const view = await render()
    treeButton().click()
    await flushPromises()

    const release = view.find('li[data-key="ST-1"]')
    await release.find('.nb-tree-node__toggle').trigger('click')
    expect(release.attributes('aria-expanded')).toBe('false')
    expect(release.find('[data-key="ST-2"]').exists()).toBe(false)
    expect(inspectorOpen).not.toHaveBeenCalled()
    view.unmount()
  })

  it('remembers the choice in this browser', async () => {
    const first = await render()
    treeButton().click()
    await flushPromises()
    first.unmount()

    const second = await render()
    expect(second.find('[role="tree"]').exists()).toBe(true)
    second.unmount()
  })
})

describe('goalCardTree', () => {
  it('starts a part at the top when its parent is not among the cards', () => {
    const nodes = goalCardTree([{ ...ITEMS[2], parent: 'ST-99' }, ITEMS[3]])
    expect(nodes.map((n) => n.card.key)).toEqual(['CMS-3', 'ST-4'])
  })

  it('draws a linked card at the top even when it is also a part', () => {
    const nodes = goalCardTree([
      ITEMS[0],
      { ...ITEMS[1], linked: true, via: undefined },
    ])
    expect(nodes.map((n) => n.card.key)).toEqual(['ST-1', 'ST-2'])
    expect(nodes[0].parts).toEqual([])
  })
})

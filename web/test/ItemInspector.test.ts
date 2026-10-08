/**
 * The details panel: sections, counts, and the way back to the space.
 *
 * The bug that prompted this: a card with eleven comments read as having
 * none, because the comments panel sat below a very long description in a
 * stack of six panels. The data was always there. So the assertions that
 * matter are that a collapsed section still SAYS what it holds, and that the
 * description can be collapsed to reach what is under it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: {}, params: {} }),
}))

vi.mock('@/lib/paths', () => ({ wpath: (p: string) => `/nubisco${p}` }))

const itemGet = vi.fn()
vi.mock('@/api/client', () => ({
  api: { itemGet: (...a: unknown[]) => itemGet(...(a as [])) },
  attachmentHref: (id: string) => `/api/v1/attachments/${id}`,
  newOpId: () => 'op',
  ApiHttpError: class extends Error {},
}))

// The real stores rather than mocks: MarkdownView reaches into several of
// them, and a partial mock silently breaks its setup rather than failing
// loudly, which cost more time than it saved.
import ItemInspector from '@/components/ItemInspector.vue'
import { useInspector, useUiState } from '@/stores/workspace'

const ITEM = {
  key: 'ST-73',
  space: 'ST',
  list: 'Done',
  title: 'First customer reward',
  description: 'A very long description.',
  rev: 4,
  labels: [],
  assignees: [],
  comments: Array.from({ length: 11 }, (_, i) => ({
    id: `c${i}`,
    by: 'jose',
    body: `comment ${i}`,
    ts: 1756000000000,
  })),
  attachments: [],
  checklists: [],
}

async function render() {
  const view = mount(ItemInspector, {
    props: { itemKey: 'ST-73' },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return view
}

describe('ItemInspector', () => {
  beforeEach(() => {
    push.mockClear()
    useUiState().itemModalKey.value = null
    useInspector().open('ST-73')
    itemGet.mockReset()
    itemGet.mockResolvedValue({ items: [{ ...ITEM }] })
  })

  // The whole point. Comments are not behind a disclosure at all, and the
  // heading carries the count, so eleven comments can never again read as
  // none.
  it('shows comments as a section of their own, with the count', async () => {
    const view = await render()
    const headings = view
      .findAll('.inspector-section__title')
      .map((h) => h.text())
    expect(headings.some((h) => h.includes('Comments'))).toBe(true)
    expect(headings.some((h) => h.includes('11'))).toBe(true)
  })

  // Description and comments are what a card IS. Behind a disclosure, every
  // card would open showing nothing.
  it('keeps description and comments out of the accordion', async () => {
    const view = await render()
    const accordion = view.find('.nb-accordion')
    const inside = accordion.exists() ? accordion.text() : ''
    expect(inside).not.toContain('A very long description.')
    expect(inside).not.toContain('comment 0')
    expect(view.text()).toContain('A very long description.')
    expect(view.text()).toContain('comment 0')
  })

  it('renders every comment, not a truncated few', async () => {
    const view = await render()
    const text = view.text()
    expect(text).toContain('comment 0')
    expect(text).toContain('comment 10')
  })

  // A count of zero is noise on the many cards that carry no files.
  // Every section carries its count in a pill, zero included, so the eye
  // always finds it in the same place. Zero is dimmed, and the pill says in
  // words what it counts (Jose, 2026-10-08).
  it('draws an empty count dimmed, and says what every count means', async () => {
    itemGet.mockResolvedValue({
      items: [{ ...ITEM, comments: [], attachments: [] }],
    })
    const view = await render()
    const pills = view.findAll('.section-count')
    const attachments = pills.find(
      (p) => p.attributes('aria-label') === 'Nothing attached',
    )
    expect(attachments?.classes()).toContain('section-count--empty')
    expect(
      pills.find((p) => p.attributes('aria-label') === 'No comments yet'),
    ).toBeDefined()
  })

  // Parts and dependencies are different relations and the model keeps them
  // apart on purpose, so the panel has to as well: one Plan section and one
  // Parts section, never one section holding both.
  it('gives parts a section of their own, with the progress on the header', async () => {
    itemGet.mockResolvedValue({
      items: [
        {
          ...ITEM,
          parts: [
            { key: 'ST-5', title: 'Toolbar', space: 'ST', done: true },
            { key: 'ST-6', title: 'Shortcuts', space: 'ST' },
          ],
        },
      ],
    })
    const view = await render()
    const headers = view.findAll('.nb-accordion-item').map((s) => s.text())
    expect(headers.some((h) => h.includes('Parts'))).toBe(true)
    expect(headers.some((h) => h.includes('1/2'))).toBe(true)
    const plan = headers.find((h) => h.includes('Plan'))
    expect(plan).not.toContain('Parts')
  })

  // The chip is context for the whole card, so it cannot be conditional on
  // anything but the parent existing, and it must not appear without one.
  it('shows "Part of" only when the card is part of something', async () => {
    const view = await render()
    expect(view.find('.part-of').exists()).toBe(false)

    itemGet.mockResolvedValue({
      items: [
        {
          ...ITEM,
          parent: { key: 'ST-4', title: 'Ship the editor', space: 'ST' },
        },
      ],
    })
    const withParent = await render()
    expect(withParent.find('.part-of').text()).toContain('Part of')
    expect(withParent.find('.part-of').text()).toContain('ST-4')
  })

  it('goes to the space the card lives on, workspace-scoped', async () => {
    const view = await render()
    const btn = view
      .findAll('button')
      .find((b) => b.attributes('aria-label')?.includes('on its space'))
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    // The card rides along, so the panel stays open on the board and the
    // board can point at it.
    expect(push).toHaveBeenCalledWith({
      path: '/nubisco/s/ST',
      query: { item: 'ST-73' },
    })
    expect(useUiState().revealCard.value?.key).toBe('ST-73')
  })

  // The pair has to behave as one control that changes size, not as two ways
  // to open a card: leaving both showing the same card is a state nobody
  // asked for.
  it('hands the card to the full-size view and closes itself', async () => {
    const view = await render()
    const btn = view
      .findAll('button')
      .find((b) => b.attributes('aria-label')?.includes('full size'))
    expect(btn).toBeDefined()
    await btn!.trigger('click')

    // Real stores, so this asserts the actual handover rather than that two
    // mocks were called.
    expect(useUiState().itemModalKey.value).toBe('ST-73')
    expect(useInspector().itemKey.value).toBeNull()
  })

  // A card opened from another card says which one "back" returns to, in
  // words, as a breadcrumb (Jose, 2026-10-08).
  it('names the card it came from beside the one it shows', async () => {
    useInspector().close()
    useInspector().open('ST-1')
    useInspector().open('ST-73')
    const view = await render()
    const crumbs = view.find('.inspector-crumbs')
    expect(crumbs.exists()).toBe(true)
    expect(crumbs.text()).toContain('ST-1')
    expect(crumbs.find('[aria-current="page"]').text()).toBe('ST-73')
    await crumbs.find('.inspector-crumb').trigger('click')
    expect(useInspector().itemKey.value).toBe('ST-1')
  })

  it('shows only the key when there is nowhere to go back to', async () => {
    useInspector().close()
    useInspector().open('ST-73')
    const view = await render()
    expect(view.find('.inspector-crumbs').exists()).toBe(false)
    expect(view.find('.inspector-key').text()).toBe('ST-73')
  })

  // People did not know what Plan or Parts meant, or that "Build" was a
  // checklist with a bin that deletes it.
  it('explains every section, and names what the bin deletes', async () => {
    itemGet.mockResolvedValue({
      items: [
        {
          ...ITEM,
          checklists: [{ name: 'Build', items: [{ text: 'a', done: false }] }],
        },
      ],
    })
    const view = await render()
    const hints = view
      .findAll('.nb-info-hint button')
      .map((b) => b.attributes('aria-label'))
    for (const label of [
      'About the description',
      'About Build',
      'About Goals',
      'About Plan',
      'About Parts',
      'About Attachments',
      'About History',
      'About comments',
    ])
      expect(hints).toContain(label)
    const bin = view.find('[aria-label="Delete checklist Build"]')
    // Beside the header's button, never inside it.
    expect(bin.element.closest('.nb-accordion-item__header')).toBeNull()
    expect(bin.element.closest('.nb-accordion-item__actions')).not.toBeNull()
  })

  it('keeps the header in one block that can stay pinned', async () => {
    const view = await render()
    const top = view.find('.inspector-top')
    expect(top.find('.inspector-key').exists()).toBe(true)
    expect(top.find('.inspector-title').exists()).toBe(true)
  })
})

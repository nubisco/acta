/**
 * The details panel: sections, counts, and the way back to the board.
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
  board: 'ST',
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
  it('shows no count for an empty section', async () => {
    itemGet.mockResolvedValue({
      items: [{ ...ITEM, comments: [], attachments: [] }],
    })
    const view = await render()
    expect(view.text()).not.toMatch(/Attachments\s*0/)
  })

  it('goes to the board the card lives on, workspace-scoped', async () => {
    const view = await render()
    const btn = view
      .findAll('button')
      .find((b) => b.attributes('aria-label')?.includes('on its board'))
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    expect(push).toHaveBeenCalledWith('/nubisco/b/ST')
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
})

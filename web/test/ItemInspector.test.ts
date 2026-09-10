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
    itemGet.mockReset()
    itemGet.mockResolvedValue({ items: [{ ...ITEM }] })
  })

  // The whole point: eleven comments must be visible as eleven from the
  // header, whether or not the section happens to be open.
  it('says how many comments there are without being opened', async () => {
    const view = await render()
    const header = view
      .findAll('.nb-accordion-item, [class*="accordion"]')
      .map((w) => w.text())
      .join(' ')
    expect(header).toContain('Comments')
    expect(header).toContain('11')
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
})

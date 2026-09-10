/**
 * The full-size card.
 *
 * Its properties belonged in a 16rem right-hand strip and the conversation
 * had the wide column, which is backwards: the fields are read once, the
 * thread is what grows without limit. These pin the arrangement rather than
 * the pixels, so restyling is free and reordering is not.
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

import ItemModal from '@/components/ItemModal.vue'

const ITEM = {
  key: 'ST-61',
  space: 'ST',
  list: 'Done',
  title: 'Plugins: default third-party scan OFF',
  description: 'Reported by a user.',
  rev: 4,
  labels: [],
  assignees: [],
  comments: [
    { id: 'c1', by: 'jose', body: 'first comment', ts: 1756000000000 },
  ],
  attachments: [],
  checklists: [],
}

async function render() {
  const view = mount(ItemModal, {
    props: { open: true, itemKey: 'ST-61' },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return view
}

describe('ItemModal', () => {
  beforeEach(() => {
    itemGet.mockReset()
    itemGet.mockResolvedValue({ items: [{ ...ITEM }] })
  })

  it('puts the card data at the top of the main column, not in a sidebar', async () => {
    const view = await render()
    const props = view.find('.item-modal__props')
    expect(props.exists()).toBe(true)

    // Every field the card carries, together, above the description.
    const text = props.text()
    for (const label of ['Status', 'List', 'Due', 'Assignees', 'Labels']) {
      expect(text).toContain(label)
    }

    const html = view.html()
    expect(html.indexOf('item-modal__props')).toBeLessThan(
      html.indexOf('item-modal__description'),
    )
  })

  it('gives the conversation the column', async () => {
    const view = await render()
    const aside = view.find('.item-modal__conversation')
    expect(aside.exists()).toBe(true)
    expect(aside.text()).toContain('Comments')
    expect(aside.text()).toContain('first comment')

    // And the properties are NOT in it, which is the arrangement that was
    // wrong before.
    expect(aside.find('.item-modal__props').exists()).toBe(false)
  })
})

/**
 * Changing one field of a card must not blank the card (Jose, 2026-10-09).
 * The skeleton is for a card not on screen yet; a refresh of the one shown
 * happens in place, and keeps what the reader is in the middle of changing.
 */
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const itemGet = vi.fn()
const itemWrite = vi.fn()
vi.mock('@/api/client', () => ({
  api: {
    itemGet: (...a: unknown[]) => itemGet(...(a as [])),
    itemWrite: (...a: unknown[]) => itemWrite(...(a as [])),
  },
  newOpId: () => 'op',
}))

import { useItem } from '@/composables/useItem'
import { onCardPatched } from '@/stores/workspace'

const CARD = {
  key: 'ST-1',
  title: 'Card',
  space: 'ST',
  list: 'To Do',
  rev: 1,
  description: '',
  labels: [],
  assignees: [],
}

function harness() {
  let api!: ReturnType<typeof useItem>
  const view = mount(
    defineComponent({
      setup() {
        api = useItem(ref('ST-1'))
        return () => h('div', api.viewState.value)
      },
    }),
  )
  return { view, it: () => api }
}

describe('a card refresh', () => {
  it('stays on screen while it re-reads, and keeps a field being edited', async () => {
    itemGet.mockResolvedValueOnce({ items: [{ ...CARD }] })
    const { view, it: card } = harness()
    await flushPromises()
    expect(card().viewState.value).toBe('ready')

    card().draft.title = 'Typing a new title'
    let release: (v: unknown) => void = () => {}
    itemGet.mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = card().load()
    expect(card().viewState.value).toBe('ready')
    release({ items: [{ ...CARD, rev: 2, list: 'Done' }] })
    await pending
    expect(card().draft.list).toBe('Done')
    expect(card().draft.title).toBe('Typing a new title')
    view.unmount()
  })

  it('applies a confirmed move and tells the board, without a skeleton', async () => {
    let server = { ...CARD }
    itemGet.mockImplementation(async () => ({ items: [{ ...server }] }))
    itemWrite.mockImplementation(async () => {
      server = { ...server, list: 'In Progress', rev: 2 }
      return { results: [{ ok: true, rev: 2 }] }
    })
    const patches: unknown[] = []
    const off = onCardPatched((p) => patches.push(p))
    const { view, it: card } = harness()
    await flushPromises()
    card().draft.list = 'In Progress'
    card().commitList()
    await flushPromises()
    expect(card().item.value?.list).toBe('In Progress')
    expect(card().viewState.value).toBe('ready')
    expect(patches).toContainEqual(
      expect.objectContaining({ key: 'ST-1', list: 'In Progress' }),
    )
    off()
    view.unmount()
  })
})

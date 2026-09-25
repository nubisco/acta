/**
 * "Part of ST-4", on the child.
 *
 * One line with two different jobs in it: the chip navigates and the control
 * beside it cuts the link. Getting those the wrong way round means either a
 * chip that detaches when somebody meant to follow it, or a detach that opens
 * a card instead, and both read as the feature not working.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const itemWrite = vi.fn()
vi.mock('@/api/client', () => ({
  api: { itemWrite: (...a: unknown[]) => itemWrite(...(a as [])) },
  newOpId: () => 'op',
  ApiHttpError: class extends Error {},
}))

import PartOfChip from '@/components/PartOfChip.vue'

const PARENT = { key: 'ST-4', title: 'Ship the editor', space: 'ST' }

beforeEach(() => {
  itemWrite.mockReset()
  itemWrite.mockResolvedValue({ results: [{ ok: true }] })
})

const render = (props = {}) =>
  mount(PartOfChip, {
    props: { itemKey: 'ST-9', space: 'ST', parent: PARENT, ...props },
  })

describe('PartOfChip', () => {
  it('says what the card is part of, by key and by title', () => {
    const text = render().text()
    expect(text).toContain('Part of')
    expect(text).toContain('ST-4')
    expect(text).toContain('Ship the editor')
  })

  // Following a chip to another board without being told is how somebody
  // ends up wondering why their space changed under them.
  it('names the board when the parent is on a different one', () => {
    const elsewhere = render({
      parent: { ...PARENT, key: 'PL-1', space: 'PL' },
    })
    expect(elsewhere.find('.nb-badge').text()).toBe('PL')
    // And stays quiet when it is the same board, which says nothing.
    expect(render().find('.nb-badge').exists()).toBe(false)
  })

  it('opens the parent when the chip itself is clicked', async () => {
    const view = render()
    await view.find('.part-of__ref').trigger('click')
    expect(view.emitted('open')).toEqual([['ST-4']])
    expect(itemWrite).not.toHaveBeenCalled()
  })

  // Detaching is written on THIS card, not on the parent: writing it on the
  // parent would cut the parent's own link to its parent instead.
  it('detaches this card from its parent in one click', async () => {
    const view = render()
    await view.find('.nb-button').trigger('click')
    await flushPromises()
    expect(itemWrite.mock.calls[0][0][0]).toMatchObject({
      op: 'set_parent',
      key: 'ST-9',
      parent: null,
    })
    expect(view.emitted('changed')).toBeTruthy()
  })
})

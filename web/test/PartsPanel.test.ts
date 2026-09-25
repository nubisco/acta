/**
 * Parts: what a card is made of.
 *
 * The model stores one link, on the child, and every one of these writes has
 * a chance to write it backwards. A backwards parent link is not a visible
 * error: ST-4 simply becomes part of ST-9 instead of the other way round, and
 * both cards look perfectly ordinary afterwards. Hence the direction
 * assertions.
 *
 * The other thing pinned here is that the picker is not space-scoped. A part
 * on another board is the reason the relation exists rather than an edge
 * case, and a picker that quietly fell back to the current space would look
 * exactly like one that found nothing.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const itemWrite = vi.fn()
const search = vi.fn()
const spaceGet = vi.fn()
vi.mock('@/api/client', () => ({
  api: {
    itemWrite: (...a: unknown[]) => itemWrite(...(a as [])),
    search: (...a: unknown[]) => search(...(a as [])),
    spaceGet: (...a: unknown[]) => spaceGet(...(a as [])),
  },
  newOpId: () => 'op',
  ApiHttpError: class extends Error {},
}))

import PartsPanel from '@/components/PartsPanel.vue'

const PARTS = [
  { key: 'ST-5', title: 'Editor toolbar', space: 'ST', done: true },
  { key: 'ST-6', title: 'Editor shortcuts', space: 'ST' },
  { key: 'PL-2', title: 'Platform hooks', space: 'PL' },
]

beforeEach(() => {
  vi.useFakeTimers()
  itemWrite.mockReset()
  itemWrite.mockResolvedValue({ results: [{ ok: true }] })
  search.mockReset()
  search.mockResolvedValue({
    results: [
      { type: 'item', ref: 'PL-9', title: 'Platform billing', space: 'PL' },
      { type: 'item', ref: 'ST-7', title: 'Editor tests', space: 'ST' },
    ],
  })
  spaceGet.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

const render = async (props = {}) => {
  const view = mount(PartsPanel, {
    props: { itemKey: 'ST-4', space: 'ST', parts: PARTS, ...props },
  })
  await flushPromises()
  return view
}

/** Type into the search box and let the debounce and the request land. */
async function searchFor(
  view: Awaited<ReturnType<typeof render>>,
  text: string,
) {
  await view.find('input').setValue(text)
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
}

const opOf = () => itemWrite.mock.calls[0][0][0]

describe('PartsPanel', () => {
  it('lists every part and says how much of it is done', async () => {
    const view = await render()
    const text = view.text()
    expect(text).toContain('ST-5')
    expect(text).toContain('Editor shortcuts')
    expect(text).toContain('PL-2')
    // The count is the reason to look at a collapsed card at all.
    expect(text).toContain('1 of 3 done')
  })

  // A part on another board is the point of the relation, and clicking
  // through to one without warning is how somebody loses their place.
  it('names the board only on the parts that are on another one', async () => {
    const view = await render()
    const rows = view.findAll('.parts__row')
    expect(rows[0].find('.parts__space').exists()).toBe(false)
    expect(rows[2].find('.parts__space').text()).toBe('PL')
  })

  // The direction. `set_parent` is written on the CHILD, so the card being
  // added is the key and this card is the parent, never the other way round.
  it('makes the picked card part of this one, not this one part of it', async () => {
    const view = await render({ parts: [] })
    await searchFor(view, 'platform')
    await view.findAll('.parts__hit')[0].trigger('click')
    await flushPromises()
    expect(opOf()).toMatchObject({
      op: 'set_parent',
      key: 'PL-9',
      parent: 'ST-4',
    })
  })

  // The picker searches the workspace. Scoping it to the current space is the
  // one change that would break cross-board parts while still looking fine.
  it('searches every board, not the one the card is on', async () => {
    const view = await render({ parts: [] })
    await searchFor(view, 'platform')
    expect(search).toHaveBeenCalledWith('platform', ['item'])
    expect(spaceGet).not.toHaveBeenCalled()
    expect(view.text()).toContain('PL-9')
  })

  // Detaching writes null on the child. It must never be a delete, and it
  // must never be written on this card, which would detach the wrong link.
  it('detaches a part rather than deleting it, from the child end', async () => {
    const view = await render()
    await view.findAll('.parts__detach')[2].trigger('click')
    await flushPromises()
    expect(opOf()).toMatchObject({
      op: 'set_parent',
      key: 'PL-2',
      parent: null,
    })
    expect(itemWrite.mock.calls[0][0]).toHaveLength(1)
  })

  // The wording is the whole safeguard: nothing else on the row says that the
  // card survives having its link cut.
  it('says in the control itself that the card is not deleted', async () => {
    const view = await render()
    const label = view.findAll('.parts__detach')[0].attributes('aria-label')
    expect(label).toContain('Detach')
    expect(label).toContain('not deleted')
  })

  // A cycle is the one mistake a card-local editor cannot prevent, so the
  // server's own sentence has to reach the person who caused it.
  it('shows the server refusal on the picker', async () => {
    itemWrite.mockResolvedValue({
      results: [{ ok: false, error: 'ST-4 is already part of PL-9' }],
    })
    const view = await render({ parts: [] })
    await searchFor(view, 'platform')
    await view.findAll('.parts__hit')[0].trigger('click')
    await flushPromises()
    expect(view.text()).toContain('already part of')
  })

  // Offering this card invites a cycle the server refuses; offering one that
  // is already a part invites a write that changes nothing.
  it('leaves out this card and the parts it already has', async () => {
    search.mockResolvedValue({
      results: [
        { type: 'item', ref: 'ST-4', title: 'Ship the editor', space: 'ST' },
        { type: 'item', ref: 'ST-5', title: 'Editor toolbar', space: 'ST' },
        { type: 'item', ref: 'ST-7', title: 'Editor tests', space: 'ST' },
      ],
    })
    const view = await render()
    await searchFor(view, 'editor')
    const offered = view.findAll('.parts__hit').map((b) => b.text())
    expect(offered).toHaveLength(1)
    expect(offered[0]).toContain('ST-7')
  })

  it('says so when nothing is part of the card yet', async () => {
    const view = await render({ parts: [] })
    expect(view.text()).toContain('Nothing is part of this card yet')
  })
})

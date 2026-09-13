/**
 * Dependency editing, in both directions.
 *
 * The model stores one edge, so "A blocks B" and "B is blocked by A" are the
 * same row with the ends swapped. The panel offers both phrasings, which means
 * every write and every removal has a chance to write the edge backwards, and
 * a backwards edge is invisible: it looks like a perfectly ordinary dependency
 * pointing the wrong way. Hence these tests.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const itemWrite = vi.fn()
const spaceGet = vi.fn()
vi.mock('@/api/client', () => ({
  api: {
    itemWrite: (...a: unknown[]) => itemWrite(...(a as [])),
    spaceGet: (...a: unknown[]) => spaceGet(...(a as [])),
  },
  newOpId: () => 'op',
  ApiHttpError: class extends Error {},
}))

import DependencyPanel from '@/components/DependencyPanel.vue'

beforeEach(() => {
  itemWrite.mockReset()
  itemWrite.mockResolvedValue({ results: [{ ok: true }] })
  spaceGet.mockReset()
  spaceGet.mockResolvedValue({
    items: [
      { key: 'ST-41', title: 'App record' },
      { key: 'ST-36', title: 'Internal track' },
      { key: 'ST-90', title: 'Archived thing', archived: true },
      { key: 'ST-91', title: 'Finished thing', done: true },
    ],
  })
})

const render = async (props = {}) => {
  const view = mount(DependencyPanel, {
    props: {
      itemKey: 'ST-33',
      space: 'ST',
      blockedBy: [{ key: 'ST-41', title: 'App record', done: false }],
      blocks: [{ key: 'ST-36', title: 'Internal track', done: false }],
      ...props,
    },
  })
  await flushPromises()
  return view
}

const opOf = () => itemWrite.mock.calls[0][0][0]

describe('DependencyPanel', () => {
  it('writes the edge with this card waiting when the relation is "is blocked by"', async () => {
    const view = await render({ blockedBy: [], blocks: [] })
    await view.findComponent({ name: 'Select' }).setValue('blocked_by')
    await view.findAllComponents({ name: 'Select' })[1].setValue('ST-41')
    await view.find('form').trigger('submit')
    await flushPromises()
    expect(opOf()).toMatchObject({
      op: 'depends_on',
      key: 'ST-33',
      blocker: 'ST-41',
    })
  })

  // The swap. Picking "blocks" must NOT write blocker: the other card.
  it('writes the edge with the other card waiting when the relation is "blocks"', async () => {
    const view = await render({ blockedBy: [], blocks: [] })
    await view.findComponent({ name: 'Select' }).setValue('blocks')
    await view.findAllComponents({ name: 'Select' })[1].setValue('ST-41')
    await view.find('form').trigger('submit')
    await flushPromises()
    expect(opOf()).toMatchObject({
      op: 'depends_on',
      key: 'ST-41',
      blocker: 'ST-33',
    })
  })

  // Removal has the same two ends, and the old panel could only unlink one of
  // them, so a "blocks" edge added here would have had no way back out.
  it('unlinks from either end with the ends the right way round', async () => {
    const view = await render()
    const [fromBlockedBy, fromBlocks] = view.findAll('.deps__remove')
    await fromBlockedBy.trigger('click')
    await flushPromises()
    expect(opOf()).toMatchObject({
      op: 'undepend',
      key: 'ST-33',
      blocker: 'ST-41',
    })

    itemWrite.mockClear()
    await fromBlocks.trigger('click')
    await flushPromises()
    expect(opOf()).toMatchObject({
      op: 'undepend',
      key: 'ST-36',
      blocker: 'ST-33',
    })
  })

  // Offering a card that is already linked invites a duplicate that the
  // server rejects; offering this card invites a cycle it also rejects.
  it('offers only cards that could actually be linked', async () => {
    const view = await render()
    const options = view.findAllComponents({ name: 'Select' })[1].props()
      .options as { value: string }[]
    expect(options.map((o) => o.value)).toEqual([])
  })

  it('leaves out done and archived cards', async () => {
    const view = await render({ blockedBy: [], blocks: [] })
    const options = view.findAllComponents({ name: 'Select' })[1].props()
      .options as { value: string }[]
    expect(options.map((o) => o.value)).toEqual(['ST-41', 'ST-36'])
  })

  // A refused write is the whole reason the picker carries an error slot: a
  // cycle is the one mistake a card-local editor cannot prevent.
  it('shows the server refusal on the picker', async () => {
    itemWrite.mockResolvedValue({ results: [{ ok: false, error: 'cycle' }] })
    const view = await render({ blockedBy: [], blocks: [] })
    await view.findAllComponents({ name: 'Select' })[1].setValue('ST-41')
    await view.find('form').trigger('submit')
    await flushPromises()
    expect(
      view.findAllComponents({ name: 'Select' })[1].props().error,
    ).toContain('cycle')
  })
})

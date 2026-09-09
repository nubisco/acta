/**
 * The board as a table.
 *
 * The sort test exists because this shipped broken and I called it verified:
 * my manual check clicked inside the header, saw the rows reorder once, and
 * never noticed the second click did nothing. NbDataTable is controlled, so
 * without feeding `sortState` back the cycle never advances.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TableView from '@/components/views/TableView.vue'
import type { IBoardItemRow } from '@/types/api'

const DAY = 86_400_000
const now = 1_700_000_000_000

const items: IBoardItemRow[] = [
  {
    key: 'SU-2',
    title: 'Bravo',
    list: 'Backlog',
    rev: 1,
    updated: now - DAY,
    pos: 2048,
    due: now + DAY,
  },
  {
    key: 'SU-1',
    title: 'Alpha',
    list: 'Doing',
    rev: 1,
    updated: now,
    pos: 1024,
    // No due date on purpose: it must sort last whichever way the column goes.
  },
  {
    key: 'SU-3',
    title: 'Charlie',
    list: 'Backlog',
    rev: 1,
    updated: now - 2 * DAY,
    pos: 3072,
    due: now - DAY,
  },
]

function render() {
  return mount(TableView, {
    props: { items, variants: new Map<string, string>() },
  })
}

/** The sort control is a button inside the header cell, not the cell. */
async function sortBy(view: ReturnType<typeof render>, header: string) {
  const th = view.findAll('th').find((cell) => cell.text().includes(header))
  await th!.find('button').trigger('click')
  await view.vm.$nextTick()
}

function keys(view: ReturnType<typeof render>): string[] {
  return view.findAll('tbody tr').map((row) => row.findAll('td')[0].text())
}

describe('TableView', () => {
  it('lists every item', () => {
    expect(keys(render())).toHaveLength(3)
  })

  it('sorts by key, then reverses on a second click', async () => {
    const view = render()
    await sortBy(view, 'Key')
    expect(keys(view)).toEqual(['SU-1', 'SU-2', 'SU-3'])
    await sortBy(view, 'Key')
    expect(keys(view)).toEqual(['SU-3', 'SU-2', 'SU-1'])
  })

  it('reflects the sort in aria-sort', async () => {
    const view = render()
    await sortBy(view, 'Key')
    const th = view.findAll('th').find((c) => c.text().includes('Key'))
    expect(th!.attributes('aria-sort')).toBe('ascending')
    await sortBy(view, 'Key')
    expect(th!.attributes('aria-sort')).toBe('descending')
  })

  it('orders due dates by time rather than by their words', async () => {
    // "in 3 days" and "2 days ago" sort alphabetically into nonsense, which
    // is why the view sorts on the timestamp behind the label.
    const view = render()
    await sortBy(view, 'Due')
    expect(keys(view)).toEqual(['SU-3', 'SU-2', 'SU-1'])
  })

  it('puts an item with no due date last in both directions', async () => {
    const view = render()
    await sortBy(view, 'Due')
    expect(keys(view).at(-1)).toBe('SU-1')
    await sortBy(view, 'Due')
    // Descending still leaves the undated one at the bottom: absent is not
    // "the beginning of time", it is "no answer".
    expect(keys(view).at(-1)).toBe('SU-1')
  })

  it('opens the item a row belongs to', async () => {
    const view = render()
    await view.findAll('tbody tr')[0].trigger('click')
    expect(view.emitted('open')?.[0]).toEqual(['SU-2'])
  })
})

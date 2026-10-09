/** Ordering cards within a column (Jose, 2026-10-09). */
import { beforeEach, describe, expect, it } from 'vitest'
import { compareBy, recallSort, rememberSort } from '@/lib/boardSort'

const rows = [
  { key: 'A', pos: 1, priority: 'low', due: 300, updated: 10, created: 1 },
  {
    key: 'B',
    pos: 2,
    priority: undefined,
    due: undefined,
    updated: 30,
    created: 3,
  },
  { key: 'C', pos: 3, priority: 'urgent', due: 100, updated: 20, created: 2 },
  { key: 'D', pos: 4, priority: 'urgent', due: 200, updated: 5, created: 4 },
] as never[]

const order = (sort: Parameters<typeof compareBy>[0]) =>
  [...rows].sort(compareBy(sort)).map((r: { key: string }) => r.key)

describe('compareBy', () => {
  it('keeps the hand-made order by default', () => {
    expect(order('manual')).toEqual(['A', 'B', 'C', 'D'])
  })
  it('puts the most urgent first, ties in manual order, no priority last', () => {
    expect(order('priority')).toEqual(['C', 'D', 'A', 'B'])
  })
  it('puts the soonest due first and undated cards last', () => {
    expect(order('due')).toEqual(['C', 'D', 'A', 'B'])
  })
  it('puts the most recently updated, or newest, first', () => {
    expect(order('updated')).toEqual(['B', 'C', 'A', 'D'])
    expect(order('created')).toEqual(['D', 'B', 'C', 'A'])
  })
})

describe('the remembered sort', () => {
  beforeEach(() => window.localStorage.clear())
  it('is kept per board, and manual is the default', () => {
    expect(recallSort('ST')).toBe('manual')
    rememberSort('ST', 'due')
    expect(recallSort('ST')).toBe('due')
    expect(recallSort('CMS')).toBe('manual')
    rememberSort('ST', 'manual')
    expect(recallSort('ST')).toBe('manual')
  })
})

/**
 * How a board orders the cards inside each column (Jose, 2026-10-09). Manual
 * is the order people drag cards into, and the default. The rest sort by a
 * field, and while one is chosen a card can still move to another column but
 * not up or down within one, since the sort decides that.
 *
 * Kept per board, for this person in this browser, like a view preference.
 */
import { getWorkspaceSlug } from '@/api/client'
import type { ISpaceItemRow } from '@/types/api'

export type TBoardSort = 'manual' | 'priority' | 'due' | 'updated' | 'created'

export const BOARD_SORTS: { label: string; value: TBoardSort }[] = [
  { label: 'Manual order', value: 'manual' },
  { label: 'Priority', value: 'priority' },
  { label: 'Due date', value: 'due' },
  { label: 'Recently updated', value: 'updated' },
  { label: 'Newest first', value: 'created' },
]

const RANK: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 }

type TRow = Pick<ISpaceItemRow, 'pos' | 'priority' | 'due' | 'updated'> & {
  created?: number
}

/** Highest first, soonest first, newest first; ties keep the manual order. */
export function compareBy(sort: TBoardSort): (a: TRow, b: TRow) => number {
  const byPos = (a: TRow, b: TRow) => a.pos - b.pos
  switch (sort) {
    case 'priority':
      return (a, b) =>
        (RANK[b.priority ?? ''] ?? 0) - (RANK[a.priority ?? ''] ?? 0) ||
        byPos(a, b)
    case 'due':
      // A card with no date has not been given one, so it goes last.
      return (a, b) =>
        (a.due ?? Number.POSITIVE_INFINITY) -
          (b.due ?? Number.POSITIVE_INFINITY) || byPos(a, b)
    case 'updated':
      return (a, b) => (b.updated ?? 0) - (a.updated ?? 0) || byPos(a, b)
    case 'created':
      return (a, b) => (b.created ?? 0) - (a.created ?? 0) || byPos(a, b)
    default:
      return byPos
  }
}

const keyFor = (space: string) =>
  `acta:board-sort:${getWorkspaceSlug()}/${space}`

export function recallSort(space: string): TBoardSort {
  try {
    const raw = window.localStorage.getItem(keyFor(space))
    if (raw && BOARD_SORTS.some((s) => s.value === raw))
      return raw as TBoardSort
  } catch {
    // Storage blocked: manual order.
  }
  return 'manual'
}

export function rememberSort(space: string, sort: TBoardSort): void {
  try {
    if (sort === 'manual') window.localStorage.removeItem(keyFor(space))
    else window.localStorage.setItem(keyFor(space), sort)
  } catch {
    // Kept for this visit only.
  }
}

/**
 * The filters each board was last left with.
 *
 * Leaving a board for Home or a goal and coming back used to drop every
 * filter, so a person working through "my cards with the bug label" set it
 * up again each time (Jose, 2026-10-08). They are remembered per board, for
 * this tab: sessionStorage, so a reload keeps them and a new tab starts
 * clean. A board never inherits another board's filters.
 */
import { getWorkspaceSlug } from '@/api/client'

export interface IBoardFilters {
  labels: string[]
  assignees: string[]
  state: string
  text: string
  goal: number | null
}

export const NO_FILTERS: IBoardFilters = {
  labels: [],
  assignees: [],
  state: 'open',
  text: '',
  goal: null,
}

const PREFIX = 'acta:board-filters:'
const memory = new Map<string, IBoardFilters>()

const keyFor = (space: string) => `${PREFIX}${getWorkspaceSlug()}/${space}`

export function recallBoardFilters(space: string): IBoardFilters {
  const key = keyFor(space)
  const held = memory.get(key)
  if (held) return { ...held }
  try {
    const raw = window.sessionStorage.getItem(key)
    if (raw) return { ...NO_FILTERS, ...(JSON.parse(raw) as IBoardFilters) }
  } catch {
    // Storage blocked or unreadable: start clean.
  }
  return { ...NO_FILTERS }
}

export function rememberBoardFilters(
  space: string,
  filters: IBoardFilters,
): void {
  const key = keyFor(space)
  const copy: IBoardFilters = {
    ...filters,
    labels: [...filters.labels],
    assignees: [...filters.assignees],
  }
  memory.set(key, copy)
  try {
    window.sessionStorage.setItem(key, JSON.stringify(copy))
  } catch {
    // The in-memory copy still covers leaving and coming back.
  }
}

/** Forget every board's filters. For tests, which share one module. */
export function forgetBoardFilters(): void {
  memory.clear()
  try {
    for (const key of Object.keys(window.sessionStorage))
      if (key.startsWith(PREFIX)) window.sessionStorage.removeItem(key)
  } catch {
    // Nothing stored to forget.
  }
}

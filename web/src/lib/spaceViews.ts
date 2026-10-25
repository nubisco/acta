/**
 * The views of a space, in one list for the two places that offer them: the
 * space's group in the rail, and on a phone, where the rail is a drawer, the
 * tabs above the board. Each is the same
 * board read a different way, addressed by `?view=` on the space's URL, with
 * the board itself carrying no query at all.
 */
export interface ISpaceView {
  id: string
  label: string
  /** A literal registered in lib/icons.ts, since the rail binds it at runtime. */
  icon: string
}

export const SPACE_VIEWS: readonly ISpaceView[] = [
  { id: 'board', label: 'Board', icon: 'kanban' },
  { id: 'table', label: 'Table', icon: 'table' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar-blank' },
  { id: 'timeline', label: 'Timeline', icon: 'chart-bar-horizontal' },
  { id: 'sequence', label: 'Sequence', icon: 'flow-arrow' },
  // Not a view of the cards but a report on them: how long people wait.
  { id: 'response-times', label: 'Response times', icon: 'timer' },
]

/** The view a `?view=` value names, or the board for anything else. */
export function spaceViewOf(raw: unknown): string {
  const wanted = typeof raw === 'string' ? raw : 'board'
  return SPACE_VIEWS.some((v) => v.id === wanted) ? wanted : 'board'
}

/** A space's address showing one view. */
export function spaceViewPath(spaceKey: string, view: string): string {
  return view === 'board'
    ? `/s/${spaceKey}`
    : `/s/${spaceKey}?view=${encodeURIComponent(view)}`
}

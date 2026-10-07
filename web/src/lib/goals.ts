/**
 * How a goal is shown, in one place.
 *
 * A goal's status is the owner's judgement and is a status signal, not a
 * category: it gets the status colours and always travels with its words,
 * never colour alone. Progress is a separate thing measured from cards, and
 * is never coloured by status, so the two cannot be mistaken for each other.
 */
import type { IGoalRef, IGoalRow, TGoalStatus } from '@/types/api'

export interface IGoalStatusMeta {
  label: string
  /** NbBadge variant. */
  badge: 'grey' | 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'primary'
  /** A colour token for marks that are not a badge, such as a bar segment. */
  color: string
  /** Still being steered, as opposed to finished, paused or dropped. */
  inFlight: boolean
}

export const GOAL_STATUS: Record<TGoalStatus, IGoalStatusMeta> = {
  pending: {
    label: 'Pending',
    badge: 'grey',
    color: 'var(--nb-c-text-subtle)',
    inFlight: true,
  },
  on_track: {
    label: 'On track',
    badge: 'green',
    color: 'var(--nb-c-status-valid)',
    inFlight: true,
  },
  at_risk: {
    label: 'At risk',
    badge: 'orange',
    color: 'var(--nb-c-status-warning)',
    inFlight: true,
  },
  off_track: {
    label: 'Off track',
    badge: 'red',
    color: 'var(--nb-c-status-error)',
    inFlight: true,
  },
  done: {
    label: 'Done',
    badge: 'blue',
    color: 'var(--nb-c-info)',
    inFlight: false,
  },
  paused: {
    label: 'Paused',
    badge: 'purple',
    color: 'var(--nb-c-text-muted)',
    inFlight: false,
  },
  cancelled: {
    label: 'Cancelled',
    badge: 'grey',
    color: 'var(--nb-c-border)',
    inFlight: false,
  },
}

/** In the order a reader scans them: worst first among those in flight. */
export const GOAL_STATUS_ORDER: TGoalStatus[] = [
  'off_track',
  'at_risk',
  'on_track',
  'pending',
  'paused',
  'done',
  'cancelled',
]

export const GOAL_STATUS_OPTIONS = (
  [
    'pending',
    'on_track',
    'at_risk',
    'off_track',
    'done',
    'paused',
    'cancelled',
  ] as TGoalStatus[]
).map((value) => ({ value, label: GOAL_STATUS[value].label }))

export function goalStatus(status: string | undefined): IGoalStatusMeta {
  return (
    GOAL_STATUS[(status ?? 'pending') as TGoalStatus] ?? GOAL_STATUS.pending
  )
}

/**
 * Goals in tree order, each with its depth, so a flat table can show the
 * hierarchy by indenting. A goal whose parent is filtered out of `rows`
 * starts its own branch at the top rather than disappearing.
 */
export function goalTree<T extends Pick<IGoalRow, 'number' | 'parent'>>(
  rows: T[],
): (T & { depth: number })[] {
  const present = new Set(rows.map((r) => r.number))
  const children = new Map<number | null, T[]>()
  for (const row of rows) {
    const parent =
      row.parent !== undefined && present.has(row.parent) ? row.parent : null
    const list = children.get(parent) ?? []
    list.push(row)
    children.set(parent, list)
  }
  const out: (T & { depth: number })[] = []
  const seen = new Set<number>()
  const walk = (parent: number | null, depth: number) => {
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.number)) continue
      seen.add(row.number)
      out.push({ ...row, depth })
      walk(row.number, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** A goal's number from a route param or a reference: `12` or `G-12`. */
export function parseGoalNumber(raw: unknown): number | null {
  const m = /^(?:G-)?(\d{1,9})$/i.exec(String(raw ?? '').trim())
  return m ? Number(m[1]) : null
}

const DAY = 24 * 60 * 60 * 1000

/** "12 Mar 2027", which is what a target date is: a day, not a moment. */
export function goalDate(ts: number | undefined): string {
  if (ts === undefined) return ''
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** Days left or late, relative to now, for a target date. */
export function targetLabel(ts: number | undefined): string {
  if (ts === undefined) return 'No target date'
  const days = Math.round((ts - Date.now()) / DAY)
  if (days < -1) return `${Math.abs(days)} days late`
  if (days === -1) return 'Due yesterday'
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `${days} days left`
}

/** A metric value with its unit, as people write it. */
export function metricValue(value: number, unit?: string): string {
  const n = Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (!unit) return n
  // Currency and percent read before and after the number respectively, and
  // anything else is a word that follows it with a space.
  if (unit === '%') return `${n}%`
  if (/^[$€£¥]$/.test(unit)) return `${unit}${n}`
  return `${n} ${unit}`
}

/** The label a picker shows for a goal: its key and title. */
export function goalOptionLabel(goal: Pick<IGoalRef, 'key' | 'title'>): string {
  return `${goal.key} ${goal.title}`
}

/**
 * Wording and ranges for the response-times report (LA-370). The numbers are
 * the server's: this only decides which week to ask about and how to say how
 * long something took.
 */

export type TPeriod = 'this-week' | 'last-week' | 'last-30-days'

export const PERIODS: { value: TPeriod; label: string }[] = [
  { value: 'this-week', label: 'This week' },
  { value: 'last-week', label: 'Last week' },
  { value: 'last-30-days', label: 'Last 30 days' },
]

const DAY = 86_400_000

/** Monday 00:00, local time, of the week `ts` falls in. */
export function weekStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  // getDay: Sunday is 0. Weeks here start on Monday.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

/**
 * The range to ask for. `to` is left out for a range that runs up to now, so
 * the server decides what "now" is rather than the browser's clock.
 */
export function periodRange(
  period: TPeriod,
  now: number,
): { from: number; to?: number } {
  const monday = weekStart(now)
  if (period === 'this-week') return { from: monday }
  if (period === 'last-week') {
    const previous = new Date(monday)
    // setDate rather than minus seven days: a week with a clock change in
    // it is not 168 hours long.
    previous.setDate(previous.getDate() - 7)
    return { from: previous.getTime(), to: monday }
  }
  return { from: now - 30 * DAY }
}

/**
 * How long, in the two largest units that matter: "45 min", "3 h 20 min",
 * "2 d 4 h". Rounded to the minute, since nobody reviews support by the
 * second.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'None'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`
}

/** "Mon 19 Oct to Sun 25 Oct", the last day being the one before `to`. */
export function rangeText(from: number, to: number): string {
  const fmt = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })
  return `${fmt(from)} to ${fmt(to - 1)}`
}

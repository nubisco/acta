/**
 * What a board card says, worked out once so the card itself only draws.
 *
 * Every card has the same rows in the same order (Jose, 2026-10-08): header,
 * title, summary, goal, labels, footer. A row with nothing in it keeps its
 * place, so these helpers answer "what goes in the slot" for the empty case
 * too, rather than "whether there is a slot".
 */

export type TDueTone = 'none' | 'later' | 'soon' | 'late' | 'met'

export interface IDueView {
  tone: TDueTone
  /** What the chip reads. Empty when there is no date. */
  text: string
  /** The exact date, for the tooltip and the accessible name. */
  full: string
}

const DAY = 24 * 60 * 60 * 1000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * A due date as a card shows it. Today and tomorrow are words, because
 * that is how anyone says them. A date in the past is counted in days, since
 * "3 days late" is the fact that matters and "5 Oct" makes the reader do the
 * sum. A done card's date is history, so it reads as a date in the done
 * colour whatever side of today it fell on.
 */
export function dueView(
  due: number | undefined,
  done: boolean | undefined,
  now: number = Date.now(),
): IDueView {
  if (!due) return { tone: 'none', text: '', full: 'No due date' }
  const date = new Date(due)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const short = date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  const full = date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  if (done) return { tone: 'met', text: short, full: `Was due ${full}` }
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY)
  if (days < 0) {
    const late = -days
    return {
      tone: 'late',
      text: late === 1 ? '1 day late' : `${late} days late`,
      full: `Was due ${full}`,
    }
  }
  if (days === 0) return { tone: 'soon', text: 'Today', full: `Due ${full}` }
  if (days === 1) return { tone: 'soon', text: 'Tomorrow', full: `Due ${full}` }
  return { tone: 'later', text: short, full: `Due ${full}` }
}

export type TCountTone = 'zero' | 'some' | 'full'

export interface ICountView {
  text: string
  tone: TCountTone
}

/**
 * A footer counter. Always drawn, so the four sit in the same place on every
 * card: dimmed at zero, green when a done/total pair is complete.
 */
export function countView(done: number, total?: number): ICountView {
  if (total === undefined) {
    return { text: String(done), tone: done > 0 ? 'some' : 'zero' }
  }
  if (total === 0) return { text: '0', tone: 'zero' }
  return {
    text: `${done}/${total}`,
    tone: done >= total ? 'full' : 'some',
  }
}

/** "3/5" from the board read, as numbers. Malformed reads as nothing. */
export function parseProgress(value: string | undefined): [number, number] {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
  return match ? [Number(match[1]), Number(match[2])] : [0, 0]
}

/** A size as the header reads it. Unitless, so no unit is invented. */
export function sizeText(size: number | undefined): string {
  if (size === undefined || size === null) return ''
  return Number.isInteger(size) ? String(size) : size.toFixed(1)
}

/** How many faces a card shows before it says "+N". */
export const CARD_FACES = 3

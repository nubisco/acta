/**
 * A card's history, as sentences.
 *
 * The server records what each event changed. This turns that into words,
 * with the people, labels, cards and goals it names kept as their own
 * segments so the view can draw a person as a person and a key as a link.
 * Anything it does not recognise falls back to the server's own summary,
 * which is always a readable sentence, so a new kind of event shows up as
 * text rather than not at all.
 */
import type { IItemEvent } from '@/types/api'

export type THistorySegment =
  | { kind: 'text'; text: string }
  | { kind: 'person'; handle: string }
  | { kind: 'label'; name: string }
  | { kind: 'item'; key: string }
  | { kind: 'goal'; number: number }

const text = (t: string): THistorySegment => ({ kind: 'text', text: t })

function list<T>(
  values: T[],
  draw: (value: T) => THistorySegment,
): THistorySegment[] {
  const out: THistorySegment[] = []
  values.forEach((value, i) => {
    if (i > 0) out.push(text(i === values.length - 1 ? ' and ' : ', '))
    out.push(draw(value))
  })
  return out
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : []
}

function day(ts: unknown): string {
  return typeof ts === 'number'
    ? new Date(ts).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : ''
}

/**
 * Hidden from the history because another row already says it. Taking
 * somebody off a card emits `item.unassigned` beside the `item.assigned`
 * that names them as removed, so showing both would say it twice.
 */
export function shownInHistory(event: IItemEvent): boolean {
  return event.verb !== 'item.unassigned'
}

/** What happened, with the actor left off: the row draws them in front. */
export function describe(event: IItemEvent): THistorySegment[] {
  const c = event.changes ?? {}
  switch (event.verb) {
    case 'item.created':
      return [
        text(
          typeof c.list === 'string'
            ? `created this card in ${c.list}`
            : 'created this card',
        ),
      ]
    case 'item.updated': {
      const parts: THistorySegment[][] = []
      const title = c.title as { from?: string; to?: string } | undefined
      if (title?.to !== undefined)
        parts.push([text(`renamed it from “${title.from}” to “${title.to}”`)])
      if (c.description) parts.push([text('edited the description')])
      const due = c.due as { to?: number | null } | undefined
      if (due !== undefined)
        parts.push([
          text(
            due.to === null || due.to === undefined
              ? 'cleared the due date'
              : `set the due date to ${day(due.to)}`,
          ),
        ])
      if (parts.length === 0) return [text('edited it')]
      return parts.flatMap((p, i) => (i > 0 ? [text(', '), ...p] : p))
    }
    case 'item.assigned': {
      const added = strings(c.added)
      const removed = strings(c.removed)
      const out: THistorySegment[] = []
      if (added.length > 0)
        out.push(
          text('assigned '),
          ...list(added, (h) => ({ kind: 'person', handle: h })),
        )
      if (removed.length > 0) {
        if (out.length > 0) out.push(text(', and took '))
        else out.push(text('took '))
        out.push(...list(removed, (h) => ({ kind: 'person', handle: h })))
        out.push(text(' off'))
      }
      return out.length > 0 ? out : [text('changed who is assigned')]
    }
    case 'item.labeled': {
      const added = strings(c.added)
      const removed = strings(c.removed)
      const out: THistorySegment[] = []
      if (added.length > 0)
        out.push(
          text(added.length === 1 ? 'added the label ' : 'added the labels '),
          ...list(added, (n) => ({ kind: 'label', name: n })),
        )
      if (removed.length > 0) {
        out.push(text(out.length > 0 ? ', and removed ' : 'removed '))
        out.push(...list(removed, (n) => ({ kind: 'label', name: n })))
      }
      return out.length > 0 ? out : [text('changed the labels')]
    }
    case 'item.moved':
      if (typeof c.from_key === 'string')
        return [
          text('moved it from '),
          { kind: 'item', key: c.from_key },
          text(
            `${typeof c.space === 'string' ? ` to the ${c.space} space` : ''}${typeof c.list === 'string' ? `, into ${c.list}` : ''}`,
          ),
        ]
      return [
        text(typeof c.list === 'string' ? `moved it to ${c.list}` : 'moved it'),
      ]
    case 'item.sized': {
      const out: THistorySegment[] = []
      if (c.size !== undefined)
        out.push(
          text(
            c.size === null
              ? 'cleared its size'
              : `sized it at ${String(c.size)}`,
          ),
        )
      if (c.is_milestone !== undefined && c.is_milestone !== null)
        out.push(
          text(
            `${out.length > 0 ? ', and ' : ''}${c.is_milestone ? 'made it a milestone' : 'stopped it being a milestone'}`,
          ),
        )
      return out.length > 0 ? out : [text('changed its size')]
    }
    case 'item.parented':
      return typeof c.parent === 'string'
        ? [text('made it part of '), { kind: 'item', key: c.parent }]
        : [text('made it part of another card')]
    case 'item.detached':
      return [text('took it out of the card it was part of')]
    case 'item.blocked':
      return typeof c.blocker === 'string'
        ? [text('made it wait on '), { kind: 'item', key: c.blocker }]
        : [text('made it wait on another card')]
    case 'item.unblocked':
      return typeof c.blocker === 'string'
        ? [text('stopped it waiting on '), { kind: 'item', key: c.blocker }]
        : [text('stopped it waiting on another card')]
    case 'item.goal_linked':
      return typeof c.goal === 'number'
        ? [text('linked it to '), { kind: 'goal', number: c.goal }]
        : [text('linked it to a goal')]
    case 'item.goal_unlinked':
      return typeof c.goal === 'number'
        ? [text('unlinked it from '), { kind: 'goal', number: c.goal }]
        : [text('unlinked it from a goal')]
    case 'item.completed':
      return [text('marked it done')]
    case 'item.reopened':
      return [text('reopened it')]
    case 'item.archived':
      return [text('archived it')]
    case 'item.restored':
      return [text('restored it')]
    case 'comment.created':
      return [text('commented')]
    case 'comment.updated':
      return [text('edited a comment')]
    case 'comment.deleted':
      return [text('deleted a comment')]
    case 'item.checklist':
      return [text(event.summary.replace(/ on [A-Z][A-Z0-9]{1,4}-\d+$/, ''))]
    default:
      return [text(event.summary)]
  }
}

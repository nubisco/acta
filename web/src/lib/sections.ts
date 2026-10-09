/**
 * What each section of a card is for, in the words its info hint uses.
 *
 * Asked for by Jose on 2026-10-08: people did not know what Plan or Parts
 * meant, or that "Build" was a checklist. One place for the wording, so the
 * inspector and the full-size card cannot describe the same section two
 * different ways.
 */
export const SECTION_INFO = {
  description:
    'What this card is about. Markdown works here, and a card key such as CM-12 becomes a link to that card. Click the text to edit it.',
  checklist:
    'A checklist on this card: steps to tick off while doing it. The count is how many are ticked. Add another checklist with the field above the description.',
  goals:
    'The outcomes this card works towards. A card counts towards a goal when it is linked to it, or when it is a part of a card that is. Goal progress is measured from these cards.',
  plan: 'The order of the work. "Is blocked by" lists the cards that have to finish before this one can, and "blocks" the cards waiting on this one. Size and milestone feed the critical path in the sequence view.',
  parts:
    'The smaller cards this one is made of. A part can live on any board and stays there. The count is how many parts are done.',
  attachments: 'Files and links added to this card.',
  history: 'Everything that has happened to this card, and who did it.',
  links:
    'Cards and documents this card mentions, and the ones that mention it.',
  comments:
    'The conversation about this card. Mention someone with @ and their handle to notify them.',
} as const

// Section counts, shared by the side panel and the full-size view so the
// two say the same numbers the same way.

/**
 * Every section header carries a count in a pill that says on hover what it
 * counts (Jose, 2026-10-08: a bare "1" beside "Plan" read as nothing). Zero
 * is drawn too, dimmed, so the pill is always where the reader looks.
 */
export interface ICount {
  text: string
  tip: string
  empty?: boolean
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function plainCount(
  list: unknown[] | undefined,
  noun: string,
  none: string,
): ICount {
  const n = list?.length ?? 0
  return { text: String(n), tip: n ? plural(n, noun) : none, empty: n === 0 }
}

export function ticked(checklist: { items: { done: boolean }[] }): number {
  return checklist.items.filter((entry) => entry.done).length
}

export function goalsCount(item: { goals?: unknown[] }): ICount {
  const n = item.goals?.length ?? 0
  return {
    text: String(n),
    tip: n ? `Serves ${plural(n, 'goal')}` : 'Serves no goal yet',
    empty: n === 0,
  }
}

/** Both directions in one number, and the split in the tooltip. */
export function planCount(item: {
  blocked_by?: unknown[]
  blocks?: unknown[]
}): ICount {
  const waits = item.blocked_by?.length ?? 0
  const holds = item.blocks?.length ?? 0
  const n = waits + holds
  if (n === 0)
    return { text: '0', tip: 'Waits on nothing, holds nothing up', empty: true }
  return {
    text: String(n),
    tip: `Waits on ${plural(waits, 'card')}, holds up ${plural(holds, 'card')}`,
  }
}

/** Done over total, because a bare count cannot say whether the work under a
 *  collapsed header is finished, which is the only reason to open it. */
export function partsCount(item: { parts?: { done?: boolean }[] }): ICount {
  const parts = item.parts ?? []
  if (parts.length === 0) return { text: '0', tip: 'No parts', empty: true }
  const done = parts.filter((p) => p.done).length
  return {
    text: `${done}/${parts.length}`,
    tip: `${done} of ${plural(parts.length, 'part')} done`,
  }
}

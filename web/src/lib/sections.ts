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

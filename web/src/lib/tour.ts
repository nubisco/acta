import type { IWalkthrough, IWalkthroughLabels } from '@nubisco/ui'

/**
 * First-run walkthrough. Targets are `v-nb-tour-step` ids stamped in App.vue
 * and BoardView.vue; a step whose target is not on screen is dropped, which
 * is why App starts the tour from a board rather than wherever the person
 * happened to be.
 *
 * Written for someone who already knows this kind of tool. That means it does
 * not explain what a board or a card is, and spends its steps on the places
 * Acta differs or where the equivalent thing lives under another name. It
 * names no other product: a tour that opens by comparing itself to a
 * competitor teaches the competitor, and reads as insecure besides.
 *
 * Bump `version` when the content changes materially. Everyone who completed
 * an older version sees the new one once; nobody sees the same one twice.
 */
export const introTour: IWalkthrough = {
  id: 'acta-intro',
  version: 2,
  steps: [
    {
      title: 'A quick tour',
      body: 'You already know how boards and cards work. This points out where Acta puts things, and the few places it works differently. About a minute.',
    },
    {
      target: 'board-views',
      title: 'One board, four ways to look at it',
      body: 'Columns, a sortable table, a calendar of due dates, or a timeline. Same cards and same filters throughout, so switching never means rebuilding your view.',
      placement: 'bottom',
    },
    {
      target: 'board-card',
      title: 'Every card has a key',
      body: 'Keys like DE-1 are permanent and searchable, so a card can be referred to in a commit, a document, or a conversation. Click a card to open its details beside the board; right-click for the quick actions, including moving it to the top or bottom of its list.',
      placement: 'right',
    },
    {
      target: 'board-filters',
      title: 'Filtering',
      body: 'Labels, people and status live in a panel rather than the toolbar, so labels keep their colours and you can pick several people at once. The button counts what is currently hiding cards from you.',
      placement: 'bottom',
    },
    {
      target: 'nav-docs',
      title: 'Documents live next to the work',
      body: 'Your knowledge base is here, in the same workspace and the same search as the boards. Pages are versioned, so you can compare any two versions and see who changed what.',
      placement: 'right',
    },
    {
      target: 'topbar-search',
      title: 'One search for everything',
      body: 'Cards, documents and comments together. Press the key shortcut from anywhere rather than navigating to a search page first.',
      placement: 'bottom',
    },
    {
      target: 'nav-activity',
      title: 'Everything that happened',
      body: 'Every change, whether a person, an integration or an automation made it, with the author on each entry. This is where to look when a card is not where you left it.',
      placement: 'right',
    },
    {
      target: 'notifications',
      title: 'Mentions and assignments',
      body: 'Anything addressed to you arrives here.',
      placement: 'right',
    },
    {
      title: 'Two things worth knowing',
      body: 'Archiving is the reversible one: a card must be archived before it can be deleted, so nothing disappears in a single click. And boards can be starred, which is what fills the favourites section on the home page.',
    },
  ],
}

export const tourLabels: IWalkthroughLabels = {
  back: 'Back',
  next: 'Next',
  skip: 'Skip tour',
  done: 'Done',
  dialog: 'Acta tour',
  progress: (current: number, total: number) => `${current} of ${total}`,
}

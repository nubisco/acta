import type { IWalkthrough, IWalkthroughLabels } from '@nubisco/ui'

/**
 * First-run walkthrough. Targets are `v-nb-tour-step` ids stamped in App.vue
 * and SpaceView.vue; a step whose target is not on screen is dropped, which
 * is why App starts the tour from a space rather than wherever the person
 * happened to be.
 *
 * Written for someone who already knows this kind of tool. That means it does
 * not explain what a space or a card is, and spends its steps on the places
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
      body: 'You already know how spaces and cards work. This points out where Acta puts things, and the few places it works differently. About a minute.',
    },
    {
      target: 'space-views',
      title: 'One space, four ways to look at it',
      body: 'Columns, a sortable table, a calendar of due dates, or a timeline. Same cards and same filters throughout, so switching never means rebuilding your view.',
      placement: 'bottom',
    },
    {
      target: 'space-card',
      title: 'Every card has a key',
      body: 'Keys like DE-1 are permanent and searchable, so a card can be referred to in a commit, a document, or a conversation. Click a card to open its details beside the space; right-click for the quick actions, including moving it to the top or bottom of its list.',
      placement: 'right',
    },
    {
      target: 'space-filters',
      title: 'Filtering',
      body: 'Labels, people and status live in a panel rather than the toolbar, so labels keep their colours and you can pick several people at once. The button counts what is currently hiding cards from you.',
      placement: 'bottom',
    },
    {
      target: 'nav-goals',
      title: 'Goals: what the work is for',
      body: 'A goal groups cards from any space behind one outcome. It has two separate signals: its status, which the owner sets in regular check-ins, and its progress, measured from the cards. Home shows how every goal stands.',
      placement: 'right',
    },
    {
      target: 'nav-docs',
      title: 'Documents live next to the work',
      body: 'Your knowledge base is here, in the same workspace and the same search as the spaces. Pages are versioned, so you can compare any two versions and see who changed what.',
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
      body: 'Archiving is the reversible one: a card must be archived before it can be deleted, so nothing disappears in a single click. And spaces can be starred, which is what fills the favourites section on the home page.',
    },
  ],
}

/**
 * Goals, the first time someone opens them (Jose, 2026-10-08: people did not
 * know what a goal was for or how status and progress differ). Targets are on
 * the goals page. Opened straight onto one goal instead, the steps that point
 * at the page are dropped and the ones that only explain still play.
 */
export const goalsTour: IWalkthrough = {
  id: 'acta-goals',
  version: 1,
  steps: [
    {
      title: 'Goals: what the work is for',
      body: 'A goal names an outcome, such as "New customers can set up on their own", and gathers the cards that get you there, from any space.',
    },
    {
      target: 'goals-create',
      title: 'Create a goal',
      body: 'Give it a title, an owner who steers it, and a target date if it has one. A goal can sit under another goal as a sub-goal.',
      placement: 'bottom',
    },
    {
      target: 'goals-breakdown',
      title: 'How they all stand',
      body: "Status is the owner's judgement, posted in check-ins: on track, at risk or off track. Hover any term for what it means, and click a status to show only those goals.",
      placement: 'bottom',
    },
    {
      target: 'goals-table',
      title: 'Progress is measured, not declared',
      body: 'The bar on each goal comes from its cards and their parts, weighted by size. Status and progress are separate on purpose: a goal can be 80% done and still at risk.',
      placement: 'top',
    },
    {
      title: 'Linking cards',
      body: 'Open a goal and link the cards that serve it. Or open any card and pick a goal in its Goals section. The board then shows the goal on each card.',
    },
    {
      title: 'Check in regularly',
      body: 'The owner posts a check-in with a status and a note. A goal without one for a month is flagged, and Home lists the goals that need a look. You can replay this walkthrough from Settings, under Walkthroughs.',
    },
  ],
}

/**
 * Notifications, the first time someone closes the bell. Ends in Settings,
 * on the control that allows desktop notifications on this device, because
 * that is the part nobody finds on their own.
 */
export const notificationsTour: IWalkthrough = {
  id: 'acta-notifications',
  version: 1,
  steps: [
    {
      target: 'notifications',
      title: 'Your notifications',
      body: 'Anything that needs you lands here: a mention, a card assigned to you, a change to a card you work on. The number counts what you have not opened.',
      placement: 'right',
    },
    {
      id: 'notify-go-settings',
      title: 'Nothing slips past',
      body: 'Leave something unread for a while and Acta emails it to you, gathered into one message. Next, the settings where you decide how this works.',
    },
    {
      target: 'notify-email',
      title: 'When Acta emails you',
      body: 'Choose how long an unread notification waits before Acta emails it, or turn the emails off.',
      placement: 'bottom',
    },
    {
      target: 'notify-device',
      title: 'Notifications on this device',
      body: 'Allow them here to get a desktop notification the moment something arrives, while Acta is open in a tab. Each browser asks separately, so do this on every computer you use.',
      placement: 'bottom',
    },
  ],
}

export type TTourName = 'intro' | 'goals' | 'notifications'

/** Every walkthrough, as Settings lists them, in the order a person meets them. */
export const WALKTHROUGHS: {
  name: TTourName
  walkthrough: IWalkthrough
  title: string
  description: string
  /** What makes it play, finishing the sentence "Plays ..." */
  plays: string
}[] = [
  {
    name: 'intro',
    walkthrough: introTour,
    title: 'Getting around Acta',
    description:
      'Where things live: spaces, cards, filters, goals, documents and search.',
    plays: 'the next time you load Acta',
  },
  {
    name: 'goals',
    walkthrough: goalsTour,
    title: 'Goals',
    description:
      'What a goal is, how status differs from progress, and how cards count towards one.',
    plays: 'the next time you open Goals',
  },
  {
    name: 'notifications',
    walkthrough: notificationsTour,
    title: 'Notifications',
    description:
      'What reaches you, when Acta emails you, and how to allow notifications on this device.',
    plays: 'the next time you close the notifications panel',
  },
]

export const tourLabels: IWalkthroughLabels = {
  back: 'Back',
  next: 'Next',
  skip: 'Skip tour',
  done: 'Done',
  dialog: 'Acta tour',
  progress: (current: number, total: number) => `${current} of ${total}`,
}

import type { IWalkthrough, IWalkthroughLabels } from '@nubisco/ui'

/**
 * First-run walkthrough. Targets are `v-nb-tour-step` ids stamped in
 * App.vue; steps whose target is not on screen are skipped automatically.
 * Bump `version` to show the tour again after a major shell change.
 */
export const introTour: IWalkthrough = {
  id: 'acta-intro',
  version: 1,
  steps: [
    {
      title: 'Welcome to Acta',
      body: 'Boards, docs and activity for your workspace, in one place. This tour takes thirty seconds.',
    },
    {
      target: 'nav-home',
      title: 'Home',
      body: 'Every board at a glance: lists, open counts, and the latest activity.',
      placement: 'right',
    },
    {
      target: 'nav-docs',
      title: 'Docs',
      body: 'The knowledge base. Pages are versioned; edit in place and compare any two versions.',
      placement: 'right',
    },
    {
      target: 'nav-activity',
      title: 'Activity',
      body: 'Every change made by a person, an agent, or a rule lands here.',
      placement: 'right',
    },
    {
      target: 'topbar-search',
      title: 'Search everything',
      body: 'Items, documents and comments, from anywhere.',
      placement: 'bottom',
    },
    {
      target: 'notifications',
      title: 'Notifications',
      body: 'Mentions and assignments reach you here.',
      placement: 'right',
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

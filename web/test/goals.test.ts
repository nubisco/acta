/**
 * The browser's half of goals: ordering them as a tree, reading a goal out of
 * a reference, linking goal keys in the activity feed, and opening a goal
 * from a notification. The summaries are the server's own sentences, taken
 * from `server/src/services/goals.ts`.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { activitySegments } from '@/lib/activity'
import { goalStatus, goalTree, metricValue, parseGoalNumber } from '@/lib/goals'
import { classifyRef, goalRefLabel } from '@/components/decorations/refs'
import { notificationPath, type IAppNotification } from '@/stores/workspace'
import { setWorkspaceSlug } from '@/api/client'
import GoalsBreakdown from '@/components/goals/GoalsBreakdown.vue'
import type { IGoalSummary } from '@/types/api'

describe('goal tree', () => {
  it('puts each sub-goal under its parent, with its depth', () => {
    const rows = goalTree([
      { number: 3, parent: 1 },
      { number: 1 },
      { number: 2 },
      { number: 4, parent: 3 },
    ])
    expect(rows.map((r) => [r.number, r.depth])).toEqual([
      [1, 0],
      [3, 1],
      [4, 2],
      [2, 0],
    ])
  })

  it('starts a branch at the top when its parent is filtered out', () => {
    // Filtering to "at risk" must not make an at-risk sub-goal vanish just
    // because its parent is on track.
    const rows = goalTree([{ number: 5, parent: 1 }])
    expect(rows.map((r) => [r.number, r.depth])).toEqual([[5, 0]])
  })
})

describe('reading a goal reference', () => {
  it('takes 12 and G-12 as the same goal', () => {
    expect(parseGoalNumber('12')).toBe(12)
    expect(parseGoalNumber('G-12')).toBe(12)
    expect(parseGoalNumber('ST-12')).toBeNull()
    expect(classifyRef('goal:G-7')).toEqual({ kind: 'goal', value: '7' })
    expect(classifyRef('goal:7')).toEqual({ kind: 'goal', value: '7' })
  })

  it('reads as the goal, the alias, or the bare key when it is gone', () => {
    const goals = [{ number: 7, key: 'G-7', title: 'Ship 2.0' }]
    expect(goalRefLabel('7', goals)).toBe('G-7 Ship 2.0')
    expect(goalRefLabel('7', goals, 'the release')).toBe('the release')
    expect(goalRefLabel('9', goals)).toBe('G-9')
  })
})

describe('goal keys in the activity feed', () => {
  const kinds = (summary: string, goals: boolean) =>
    activitySegments(summary, undefined, goals).map((s) => [s.kind, s.text])

  it('links the goal and the card in a link event', () => {
    expect(kinds('ST-4 serves G-2', true)).toEqual([
      ['item', 'ST-4'],
      ['text', ' serves '],
      ['goal', 'G-2'],
    ])
  })

  it('links both goals when one becomes part of another', () => {
    expect(kinds('G-3 is part of G-1', true)).toEqual([
      ['goal', 'G-3'],
      ['text', ' is part of '],
      ['goal', 'G-1'],
    ])
  })

  it('leaves G-12 alone in a card title', () => {
    expect(kinds('created ST-1: Fix the G-12 cable', false)).toEqual([
      ['text', 'created '],
      ['item', 'ST-1'],
      ['text', ': Fix the G-12 cable'],
    ])
  })
})

describe('opening a goal notification', () => {
  it('goes to the goal', () => {
    setWorkspaceSlug('nubisco')
    const note: IAppNotification = {
      id: 'n',
      title: 'checked in on G-4: at risk',
      reason: 'assigned',
      verb: 'goal.checked_in',
      itemKey: null,
      docSlug: null,
      goalNumber: 4,
      actorHandle: 'ivan',
      timestamp: '',
      read: false,
    }
    expect(notificationPath(note)).toBe('/nubisco/goals/4')
  })
})

describe('formatting', () => {
  it('puts a currency before the number and a word after it', () => {
    expect(metricValue(10000, '€')).toBe(`€${(10000).toLocaleString()}`)
    expect(metricValue(40, '%')).toBe('40%')
    expect(metricValue(3, 'users')).toBe('3 users')
  })

  it('falls back to pending for a status it does not know', () => {
    expect(goalStatus('something new').label).toBe('Pending')
  })
})

describe('the breakdown', () => {
  const summary: IGoalSummary = {
    total: 4,
    in_flight: 3,
    by_status: {
      pending: 0,
      on_track: 2,
      at_risk: 0,
      off_track: 1,
      done: 1,
      paused: 0,
      cancelled: 0,
    },
    overdue: 1,
    stale: 0,
    work: {
      cards_total: 10,
      cards_done: 4,
      cards_active: 2,
      cards_waiting: 1,
      cards_overdue: 1,
      weight_total: 10,
      weight_done: 4,
      percent: 40,
    },
  }

  it('lists only the statuses that have goals, worst first, with words', () => {
    const wrapper = mount(GoalsBreakdown, {
      props: { summary },
      global: { directives: { nbTooltip: {} } },
    })
    const legend = wrapper.find('[aria-label="Goals by status"]').text()
    expect(legend.indexOf('Off track')).toBeLessThan(legend.indexOf('On track'))
    expect(legend).not.toContain('Paused')
    expect(wrapper.text()).toContain('40% done, 4 of 10 cards, 1 late')
  })
})

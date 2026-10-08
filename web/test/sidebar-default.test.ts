/** Which routes open with the sidebar folded to its icon rail. */
import { describe, expect, it } from 'vitest'
import { sidebarDefaultFor } from '@/stores/workspace'

describe('sidebarDefaultFor', () => {
  it('folds the sidebar on boards, docs and goals', () => {
    for (const name of ['space', 'docs', 'goals', 'goal'])
      expect(sidebarDefaultFor(name)).toBe('compact')
  })

  it('keeps it open where navigating is the point', () => {
    for (const name of ['home', 'activity', 'settings'])
      expect(sidebarDefaultFor(name)).toBe('verbose')
  })
})

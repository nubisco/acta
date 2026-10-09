/** A saved Home layout made whole against the panels this build knows. */
import { describe, expect, it } from 'vitest'
import { HOME_PANELS, defaultLayout, mergeLayout } from '@/lib/homePanels'

describe('mergeLayout', () => {
  it('gives the defaults to somebody who never customised', () => {
    expect(mergeLayout(null)).toEqual(defaultLayout())
    expect(defaultLayout().find((p) => p.id === 'recent')?.hidden).toBe(true)
  })

  it('keeps their order, drops what no longer exists, and never hides Next up', () => {
    const got = mergeLayout([
      { id: 'spaces' },
      { id: 'gone-panel' },
      { id: 'next-up', hidden: true },
      { id: 'goals', wide: false },
    ])
    expect(got.slice(0, 3).map((p) => p.id)).toEqual([
      'spaces',
      'next-up',
      'goals',
    ])
    expect(got.find((p) => p.id === 'next-up')?.hidden).toBe(false)
    expect(got.some((p) => p.id === 'gone-panel')).toBe(false)
  })

  it('puts a panel added since back after the one it follows by default', () => {
    const saved = HOME_PANELS.filter((p) => p.id !== 'behind').map((p) => ({
      id: p.id,
    }))
    const got = mergeLayout(saved).map((p) => p.id)
    expect(got.indexOf('behind')).toBe(got.indexOf('goals') + 1)
    expect(got).toHaveLength(HOME_PANELS.length)
  })
})

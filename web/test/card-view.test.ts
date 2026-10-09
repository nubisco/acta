/**
 * The side panel and the full-size view are one card view at two sizes.
 *
 * The full-size view used to be a separate dialog with no address and no
 * trail: a reload or Back lost it, following a part inside it gave no way
 * back, and a card mention in it opened the side panel behind it (UX audit,
 * 2026-10-09).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useInspector } from '@/stores/workspace'

const inspector = useInspector()

beforeEach(() => inspector.close())

describe('one card view, two sizes', () => {
  it('keeps the size when following a card from inside it', () => {
    inspector.open('ST-21', { full: true })
    inspector.open('ST-19')
    expect(inspector.itemKey.value).toBe('ST-19')
    expect(inspector.full.value).toBe(true)
    expect(inspector.trail.value).toEqual(['ST-21'])
  })

  it('changes size in place, as a replace rather than a new entry', () => {
    inspector.open('ST-21')
    inspector.setFull(true)
    expect(inspector.itemKey.value).toBe('ST-21')
    expect(inspector.navMode.value).toBe('replace')
    inspector.setFull(false)
    expect(inspector.full.value).toBe(false)
  })

  it('forgets the size and the trail when closed', () => {
    inspector.open('ST-21', { full: true })
    inspector.open('ST-19')
    inspector.close()
    expect(inspector.full.value).toBe(false)
    expect(inspector.trail.value).toEqual([])
    expect(inspector.trailAt.value).toEqual([])
  })
})

describe('going back', () => {
  it('asks for a history step rather than moving by itself', () => {
    inspector.open('ST-21')
    inspector.open('ST-19')
    const before = inspector.backRequest.value
    inspector.back()
    expect(inspector.backRequest.value).toBe(before + 1)
    // Unchanged until history (or the in-place fallback) moves it.
    expect(inspector.itemKey.value).toBe('ST-19')
  })

  it('pops the trail when history lands on its tail', () => {
    inspector.open('ST-21')
    inspector.open('ST-19')
    inspector.restore('ST-21')
    expect(inspector.itemKey.value).toBe('ST-21')
    expect(inspector.trail.value).toEqual([])
    expect(inspector.trailAt.value).toEqual([])
  })

  it('falls back to stepping in place', () => {
    inspector.open('ST-21')
    inspector.open('ST-19')
    inspector.backInPlace()
    expect(inspector.itemKey.value).toBe('ST-21')
    expect(inspector.navMode.value).toBe('replace')
  })

  it('does nothing with no trail', () => {
    inspector.open('ST-21')
    const before = inspector.backRequest.value
    inspector.back()
    expect(inspector.backRequest.value).toBe(before)
  })
})

describe('closing', () => {
  it('asks App to close, and only when a card is open', () => {
    const before = inspector.dismissRequest.value
    inspector.dismiss()
    expect(inspector.dismissRequest.value).toBe(before)
    inspector.open('ST-21')
    inspector.dismiss()
    expect(inspector.dismissRequest.value).toBe(before + 1)
  })

  it('remembers where a card was opened from, and only the first one', () => {
    inspector.open('ST-21')
    const base = inspector.baseAt.value
    inspector.open('ST-19')
    expect(inspector.baseAt.value).toBe(base)
    inspector.close()
    expect(inspector.baseAt.value).toBe(-1)
  })
})

describe('Escape', () => {
  it('closes the panel, unless a field or a dialog has it', async () => {
    const { mount, flushPromises } = await import('@vue/test-utils')
    const { default: ItemInspector } =
      await import('@/components/ItemInspector.vue')
    inspector.open('ST-21')
    const before = inspector.dismissRequest.value
    const view = mount(ItemInspector, {
      props: { itemKey: 'ST-21' },
      attachTo: document.body,
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(inspector.dismissRequest.value).toBe(before)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(inspector.dismissRequest.value).toBe(before + 1)
    input.remove()
    view.unmount()
  })
})

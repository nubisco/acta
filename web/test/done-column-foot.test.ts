/** The Done column says what it is not showing (Jose, 2026-10-09). */
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DoneColumnFoot from '@/components/DoneColumnFoot.vue'

const render = (props: Record<string, unknown>) =>
  mount(DoneColumnFoot, {
    props: { hidden: 0, windowDays: 14, showingAll: false, ...props },
    attachTo: document.body,
  })

describe('the Done column foot', () => {
  it('counts the done cards it left out', () => {
    expect(render({ hidden: 148 }).text()).toContain(
      '148 older done cards hidden',
    )
    expect(render({ hidden: 1 }).text()).toContain('1 older done card hidden')
  })

  it('names the window when nothing is hidden yet', () => {
    expect(render({}).text()).toContain('Showing the last 14 days')
    expect(render({ windowDays: null }).text()).toContain(
      'Showing every done card',
    )
  })

  it('offers showing them, clearing, and the window', async () => {
    const view = render({ hidden: 3 })
    await view.find('button[aria-label="Done column options"]').trigger('click')
    await flushPromises()
    const items = Array.from(document.body.querySelectorAll('.nb-menu-item'))
    const labels = items.map((i) => i.textContent?.trim())
    expect(labels).toContain('Show older done cards')
    expect(labels).toContain('Clear done now')
    expect(labels).toContain('Keep every done card')
    ;(
      items.find((i) => i.textContent?.includes('30 days')) as HTMLElement
    ).click()
    expect(view.emitted('set-window')?.[0]).toEqual([30])
    view.unmount()
  })
})

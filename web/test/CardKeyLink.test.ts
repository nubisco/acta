/**
 * A card key in text is a real link: a plain click opens the card in the
 * page, a modified or middle click is left to the browser, which opens the
 * card's address in a new tab.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/api/client', () => ({ getWorkspaceSlug: () => 'acme' }))

import CardKeyLink from '@/components/CardKeyLink.vue'

const render = (slot?: string) =>
  mount(CardKeyLink, {
    props: { cardKey: 'ST-4' },
    slots: slot ? { default: slot } : {},
    attachTo: document.body,
  })

describe('CardKeyLink', () => {
  it('is the library link button, pointing at the card', () => {
    const link = render().find('a')
    expect(link.classes()).toContain('nb-button--link')
    expect(link.attributes('href')).toContain('item=ST-4')
    expect(link.text()).toBe('ST-4')
  })

  it('opens the card in the page on a plain click', async () => {
    const view = render()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    view.find('a').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(view.emitted('open')).toEqual([['ST-4']])
  })

  it('leaves a modified click to the browser', () => {
    const view = render()
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    })
    view.find('a').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(view.emitted('open')).toBeUndefined()
  })

  it('keeps the click from reaching the row or label around it', () => {
    const outer = vi.fn()
    const view = render()
    document.body.addEventListener('click', outer)
    view
      .find('a')
      .element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    document.body.removeEventListener('click', outer)
    expect(outer).not.toHaveBeenCalled()
  })

  it('takes a label in place of the key, without the key styling', () => {
    const link = render('Ship the editor').find('a')
    expect(link.text()).toBe('Ship the editor')
    expect(link.classes()).not.toContain('card-key-link--key')
  })
})

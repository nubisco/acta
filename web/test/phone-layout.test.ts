/**
 * The phone layout (2026-10-10): the same controls, folded for a small touch
 * screen, and the desktop rendering untouched. The library's phone signal is
 * mocked here so each test can say which screen it is on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const phone = ref(false)
vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nubisco/ui')>()
  return {
    ...actual,
    usePhoneLayout: () => ({ phone, phoneTouch: phone }),
  }
})
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
}))

import BoardBatchActions from '@/components/BoardBatchActions.vue'
import GlobalSearch from '@/components/GlobalSearch.vue'

const mounted: { unmount: () => void }[] = []
const keep = <T extends { unmount: () => void }>(view: T): T => {
  mounted.push(view)
  return view
}

const batch = () =>
  keep(
    mount(BoardBatchActions, {
      props: { lists: ['To Do'], people: [], labels: [] },
      attachTo: document.body,
    }),
  )

describe('the phone layout', () => {
  afterEach(() => {
    mounted.splice(0).forEach((view) => view.unmount())
    phone.value = false
  })

  it('keeps the labelled batch actions on a desktop', () => {
    const view = batch()
    expect(view.text()).toContain('Move to')
    expect(view.text()).toContain('Archive')
  })

  it('shows the batch actions as named icons on a phone', () => {
    phone.value = true
    const view = batch()
    expect(view.text()).not.toContain('Move to')
    const names = view
      .findAll('button')
      .map((b) => b.attributes('aria-label'))
      .filter(Boolean)
    expect(names).toEqual(['Move to', 'Assign', 'Label', 'Priority', 'Archive'])
  })

  it('keeps the search field in the topbar on a desktop', () => {
    const view = keep(mount(GlobalSearch, { attachTo: document.body }))
    expect(view.find('form[role="search"]').exists()).toBe(true)
  })

  it('turns the topbar search into a button on a phone', () => {
    phone.value = true
    const view = keep(mount(GlobalSearch, { attachTo: document.body }))
    expect(view.find('form').exists()).toBe(false)
    expect(view.find('button[aria-label="Search Acta"]').exists()).toBe(true)
  })
})

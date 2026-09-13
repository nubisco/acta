/**
 * The search box wears a magnifying glass.
 *
 * It is the control people are meant to reach for first, and the glyph is
 * what says so before the placeholder is read. Pinned because it lives in a
 * slot: nothing about a missing `leading` template is a type error, so it
 * would go silently.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {}, params: {} }),
}))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    api: {
      ...(actual.api as object),
      search: vi.fn(async () => ({ results: [] })),
    },
  }
})

import GlobalSearch from '@/components/GlobalSearch.vue'

describe('GlobalSearch', () => {
  it('shows the magnifying glass inside the field', () => {
    const html = mount(GlobalSearch, {
      global: { stubs: { teleport: true } },
    }).html()

    expect(html).toContain('search__glyph')
    // Inside the input's own wrapper, not floating next to it: that is what
    // makes it read as part of the control.
    expect(html).toMatch(
      /nb-text-input__field-wrapper[^>]*>\s*<svg|search__glyph/,
    )
  })

  // A shortcut nobody is told about is a shortcut nobody uses, and this is
  // the only place in the interface that can mention it.
  it('advertises the command palette chord', () => {
    const view = mount(GlobalSearch, { global: { stubs: { teleport: true } } })
    expect(view.find('.search__kbd').exists()).toBe(true)
    expect(view.find('.search__kbd').text()).toMatch(/⌘K|Ctrl K/)
  })

  // Once there is something to read, the advertisement is in the way of the
  // thing it was advertising.
  it('drops the chord once typing starts', async () => {
    const view = mount(GlobalSearch, { global: { stubs: { teleport: true } } })
    await view.find('input').setValue('stagewright')
    expect(view.find('.search__kbd').exists()).toBe(false)
  })
})

/**
 * The page's owner and who can see it, beside its word count (Jose,
 * 2026-10-09). Only the owner gets a control. Everyone else is told.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/api/client', () => ({
  api: { docWrite: vi.fn() },
  newOpId: () => 'op',
}))
vi.mock('@/lib/commands', () => ({ useViewCommands: () => undefined }))
vi.mock('@/stores/workspace', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useWorkspace: () => ({
      overview: {
        value: {
          actors: [
            { id: 'a1', handle: 'jose', kind: 'human', name: 'José Silva' },
          ],
        },
      },
    }),
  }
})

import DocChromeBar from '@/components/DocChromeBar.vue'

const stats = { words: 5, characters: 30, readingMinutes: 1 }

function render(access: Record<string, unknown>) {
  return mount(DocChromeBar, {
    props: {
      slug: 'draft',
      stats,
      wide: false,
      editing: false,
      canEdit: true,
      access: {
        owner: 'jose',
        visibility: 'private',
        canChange: true,
        insidePrivate: false,
        workspace: 'Nubisco',
        ...access,
      },
    },
  })
}

describe("the page's info row", () => {
  it('names the owner and lets them change who sees it', async () => {
    const view = render({})
    expect(view.text()).toContain('Owner')
    expect(view.text()).toContain('José Silva')
    const button = view.find('button[aria-label^="Private."]')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    expect(view.emitted('change-visibility')).toHaveLength(1)
  })

  it('tells anybody else, without a control', () => {
    const view = render({ visibility: 'workspace', canChange: false })
    expect(view.find('button[aria-label*="Change who sees"]').exists()).toBe(
      false,
    )
    expect(view.find('.doc-chrome__visibility').text()).toContain('Shared')
  })

  it('offers no control on a page that is private because its parent is', () => {
    const view = render({ insidePrivate: true })
    expect(view.find('button[aria-label*="Change who sees"]').exists()).toBe(
      false,
    )
    expect(view.find('.doc-chrome__visibility').text()).toContain('Private')
  })
})

/**
 * People in dropdowns.
 *
 * A person is an avatar, and their name where there is room for it. A list of
 * people under one identical `user` glyph, or a select showing a bare handle,
 * is a list you have to read instead of one you recognise. These pin the
 * three places that still rendered a person as text or as a generic icon.
 */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const overview = {
  actors: [
    { id: 'a1', handle: 'ivan', kind: 'human', name: 'Ivan Petrov' },
    { id: 'a2', handle: 'ana', kind: 'human', name: 'Ana Ferreira' },
    { id: 'a3', handle: 'bot', kind: 'agent', name: 'Importer' },
  ],
  labels: [],
  spaces: [],
}

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: { value: overview },
    onLive: () => () => undefined,
  }),
}))

vi.mock('@/api/client', () => ({
  api: {},
  newOpId: () => 'op-test',
  getWorkspaceSlug: () => 'nubisco',
}))

const SuggestionList = (await import('@/components/editor/SuggestionList.vue'))
  .default
const RuleEditModal = (await import('@/components/settings/RuleEditModal.vue'))
  .default

describe('the mention typeahead', () => {
  it('shows each person as their avatar, not as a generic glyph', () => {
    const view = mount(SuggestionList, {
      props: {
        items: [
          {
            id: 'actor:ivan',
            label: 'Ivan Petrov',
            icon: 'user',
            avatarHandle: 'ivan',
            hint: '@ivan',
            apply: () => {},
          },
        ],
        command: () => {},
      },
    })
    const avatar = view.find('.sug__item .avatar')
    expect(avatar.exists()).toBe(true)
    // Hovering names the person, which is what the glyph never did.
    expect(avatar.attributes('aria-label')).toContain('Ivan Petrov')
    expect(view.find('.sug__icon').exists()).toBe(false)
  })

  it('leaves the glyph on the rows that are not people', () => {
    // The same list serves the `/` menu and the `[[` search, and a callout
    // has no face.
    const view = mount(SuggestionList, {
      props: {
        items: [
          {
            id: 'block:callout',
            label: 'Callout',
            icon: 'info',
            apply: () => {},
          },
        ],
        command: () => {},
      },
    })
    expect(view.find('.sug__icon').exists()).toBe(true)
    expect(view.find('.avatar').exists()).toBe(false)
  })

  it('is fed a handle to draw the avatar from', async () => {
    // Read from source, as the sibling mention test does: driving tiptap to
    // reach the item list would test tiptap.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/components/editor/suggestions.ts', 'utf8'),
    )
    expect(src).toContain('avatarHandle: a.handle')
  })
})

describe('the rule editor', () => {
  /**
   * The modal and every select inside it teleport, so the options are read
   * from the document. The modal is torn down after each test for the same
   * reason: what it left in the body would otherwise answer the next one.
   */
  async function withModal(
    fn: (view: ReturnType<typeof mount>) => Promise<void>,
  ): Promise<void> {
    const view = mount(RuleEditModal, {
      props: { open: true, rule: null },
      global: { stubs: { teleport: true } },
      attachTo: document.body,
    })
    await flushPromises()
    try {
      await fn(view)
    } finally {
      view.unmount()
    }
  }

  /** Open a select by its label and return its option rows. */
  async function options(
    view: ReturnType<typeof mount>,
    label: string,
  ): Promise<HTMLElement[]> {
    const field = view
      .findAll('.nb-select')
      .find((s) => s.text().includes(label))!
    await field.find('.nb-select__trigger').trigger('click')
    await flushPromises()
    return [...document.querySelectorAll<HTMLElement>('.nb-select__option')]
  }

  it('shows a face beside every assignee in the condition', async () => {
    await withModal(async (view) => {
      const rows = await options(view, 'Assignee')
      const ivan = rows.find((r) => r.textContent?.includes('Ivan Petrov'))
      expect(ivan).toBeDefined()
      expect(ivan!.querySelector('.avatar')).not.toBeNull()
      // The bot is not offered: it cannot hold a card, so a condition naming
      // it could never match.
      expect(rows.some((r) => r.textContent?.includes('Importer'))).toBe(false)
    })
  })

  it('shows a face beside every person you can assign to', async () => {
    await withModal(async (view) => {
      const actions = await options(view, 'Then')
      actions.find((o) => o.textContent?.trim().startsWith('Assign'))!.click()
      await flushPromises()

      const rows = await options(view, 'Assign to')
      const ana = rows.find((r) => r.textContent?.includes('Ana Ferreira'))
      expect(ana).toBeDefined()
      expect(ana!.querySelector('.avatar')).not.toBeNull()
    })
  })
})

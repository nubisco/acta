/**
 * People as a filter.
 *
 * The rule worth pinning is that an empty selection means everyone, because
 * it is the state you land in and the one a "clear" button returns you to.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ActorFilter from '@/components/ActorFilter.vue'

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: {
      value: {
        actors: [
          { id: 'a1', handle: 'jose', kind: 'human', name: 'José Silva' },
          { id: 'a2', handle: 'ana', kind: 'human', name: 'Ana Ferreira' },
          { id: 'a3', handle: 'bot', kind: 'agent', name: 'Importer' },
          { id: 'a4', handle: 'acta', kind: 'system', name: 'Acta' },
        ],
      },
    },
  }),
}))

function render(modelValue: string[] = []) {
  return mount(ActorFilter, { props: { modelValue } })
}

describe('ActorFilter', () => {
  it('offers people and agents but not the system actor', () => {
    // Acta acts on its own behalf constantly; filtering to it is noise.
    const handles = render()
      .findAll('.people__one')
      .map((b) => b.attributes('aria-label'))
    expect(handles).toHaveLength(3)
    expect(handles.join(' ')).not.toContain('Acta')
  })

  it('adds a person to the selection', async () => {
    const view = render()
    await view.findAll('.people__one')[0].trigger('click')
    expect(view.emitted('update:modelValue')?.[0]).toEqual([['jose']])
  })

  it('removes a person who is already selected', async () => {
    const view = render(['jose', 'ana'])
    await view.findAll('.people__one')[0].trigger('click')
    expect(view.emitted('update:modelValue')?.[0]).toEqual([['ana']])
  })

  it('marks the selected people as pressed', () => {
    const view = render(['ana'])
    const pressed = view
      .findAll('.people__one')
      .map((b) => b.attributes('aria-pressed'))
    expect(pressed).toEqual(['false', 'true', 'false'])
  })

  it('offers a way back to everyone only once something is selected', async () => {
    expect(render().text()).not.toContain('Everyone')
    const view = render(['jose'])
    expect(view.text()).toContain('Everyone')
    await view.find('button.nb-button').trigger('click')
    expect(view.emitted('update:modelValue')?.[0]).toEqual([[]])
  })
})

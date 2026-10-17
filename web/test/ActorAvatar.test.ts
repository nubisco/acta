/**
 * The `@acta` system account wears the app's mark.
 *
 * Reminders, automations and imports are credited to it, so it shows up in
 * the bell and the activity feed constantly. It used to draw "AC" on a
 * coloured disc, which reads as a colleague called Ac.
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'

const overview = ref({
  actors: [
    { id: 'a1', handle: 'acta', kind: 'system', name: 'Acta' },
    { id: 'a2', handle: 'ivan', kind: 'human', name: 'Ivan Petrov' },
  ],
})

vi.mock('@/stores/workspace', async () => {
  const actual =
    await vi.importActual<typeof import('@/stores/workspace')>(
      '@/stores/workspace',
    )
  return { ...actual, useWorkspace: () => ({ overview }) }
})

const ActorAvatar = (await import('@/components/ActorAvatar.vue')).default

describe('ActorAvatar', () => {
  it('draws the Acta mark for the system account, squared off', () => {
    const view = mount(ActorAvatar, { props: { handle: 'acta' } })
    expect(view.find('img').attributes('src')).toBe('/icons/acta-128.png')
    expect(view.classes()).toContain('avatar--system')
  })

  it('leaves a person without a picture on their initials', () => {
    const view = mount(ActorAvatar, { props: { handle: 'ivan' } })
    expect(view.find('img').exists()).toBe(false)
    expect(view.text()).toBe('IP')
    expect(view.classes()).not.toContain('avatar--system')
  })
})

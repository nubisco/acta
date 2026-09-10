/**
 * A thread has to read as a sequence of people saying things.
 *
 * Imported comments carry the original author's display NAME and no handle,
 * and used to render as a bold name with no avatar. Half a migrated thread
 * was therefore a wall of identical bold text with nothing to follow down
 * the column, which is what made an eleven-comment card unreadable even once
 * the comments were on screen.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// Only the overview call is stubbed; everything else in the client stays
// real, because a partial mock of the module breaks MarkdownView's setup
// silently rather than failing loudly.
const overview = vi.fn(async () => ({ boards: [], labels: [], actors: [] }))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    api: { ...(actual.api as object), overview: () => overview() },
  }
})

import CommentThread from '@/components/CommentThread.vue'
import { useWorkspace } from '@/stores/workspace'

/** Populate the store the way the app does, since `overview` is read-only. */
async function seedActors(actors: unknown[]) {
  overview.mockResolvedValue({ boards: [], labels: [], actors } as never)
  await useWorkspace().refresh()
}

interface ITestComment {
  id: string
  by: string
  ts: number
  body: string
  agent?: boolean
  imported?: { source: string; author?: string; created_at?: string }
}

function render(comments: ITestComment[]) {
  return mount(CommentThread, {
    props: { modelValue: '', comments, commenting: false },
    global: { stubs: { teleport: true } },
  })
}

const BASE = { id: 'c1', by: 'acta', ts: 1756000000000, body: 'hello' }

describe('CommentThread', () => {
  it('gives an imported comment an avatar, not just a name', () => {
    const view = render([
      { ...BASE, imported: { source: 'trello', author: 'José Silva' } },
    ])
    expect(view.findAllComponents({ name: 'ActorAvatar' })).toHaveLength(1)
    expect(view.text()).toContain('José Silva')
    expect(view.text()).toContain('imported')
  })

  // One person, one face, across the seam between what was migrated and what
  // was written here.
  it('matches an imported author to the member of the same name', async () => {
    await seedActors([{ handle: 'jose', name: 'José Silva', kind: 'human' }])

    const avatar = render([
      { ...BASE, imported: { source: 'trello', author: 'José Silva' } },
    ]).findComponent({ name: 'ActorAvatar' })
    expect(avatar.props('handle')).toBe('jose')

    // And an author who is nobody here still gets a stable identity rather
    // than being shown as a handle that does not exist.
    const stranger = render([
      { ...BASE, imported: { source: 'trello', author: 'Someone Else' } },
    ]).findComponent({ name: 'ActorAvatar' })
    expect(stranger.props('handle')).toBe('Someone Else')
    expect(stranger.props('name')).toBe('Someone Else')
  })

  it('still shows a member comment with their handle', () => {
    const avatar = render([{ ...BASE, by: 'ivan' }]).findComponent({
      name: 'ActorAvatar',
    })
    expect(avatar.props('handle')).toBe('ivan')
    expect(avatar.props('name')).toBeUndefined()
  })
})

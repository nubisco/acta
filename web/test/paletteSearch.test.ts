/**
 * Workspace content as command palette results.
 *
 * Acta had two overlays that both took typing, and which one you wanted
 * depended on knowing in advance whether the thing in your head was a command
 * or a card.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPaletteSuggester } from '@/lib/paletteSearch'
import { api } from '@/api/client'
import type { Router } from 'vue-router'

// `wpath` reads the slug from the client, so the mock has to keep that
// export alive or every link built here throws.
vi.mock('@/api/client', () => ({
  api: { search: vi.fn() },
  getWorkspaceSlug: () => 'nubisco',
}))

const push = vi.fn()
const router = { push } as unknown as Router
const openItem = vi.fn()

const suggest = createPaletteSuggester({ router, openItem })

beforeEach(() => {
  push.mockClear()
  openItem.mockClear()
  vi.mocked(api.search).mockReset()
})

describe('createPaletteSuggester', () => {
  it('turns hits into commands grouped by what they are', async () => {
    vi.mocked(api.search).mockResolvedValue({
      results: [
        { type: 'item', ref: 'ACTA-12', title: 'Fix login', space: 'ACTA' },
        { type: 'doc', ref: 'handbook', title: 'Handbook' },
      ],
    } as never)

    const commands = await suggest('login')
    expect(commands[0].label).toBe('Fix login')
    expect(commands[0].namespace).toBe('Cards')
    expect(commands[1].namespace).toBe('Documents')
  })

  it('namespaces ids so a card cannot displace a registered command', async () => {
    // The palette keys commands by id in a Map. A hit whose ref collided with
    // a command id would silently replace that command.
    vi.mocked(api.search).mockResolvedValue({
      results: [{ type: 'item', ref: 'go-home', title: 'Go home' }],
    } as never)

    const [first] = await suggest('home')
    expect(first.id).toBe('search:item:go-home')
  })

  it('opens a card in the inspector and a doc by route', async () => {
    vi.mocked(api.search).mockResolvedValue({
      results: [
        { type: 'item', ref: 'ACTA-12', title: 'Fix login' },
        { type: 'doc', ref: 'handbook', title: 'Handbook' },
      ],
    } as never)

    const commands = await suggest('x')
    commands[0].handler()
    expect(openItem).toHaveBeenCalledWith('ACTA-12')

    commands[1].handler()
    expect(push).toHaveBeenCalled()
  })

  it('opens the item a comment belongs to, not the comment', async () => {
    // Comment hits carry the owning item key as their title, which is the one
    // thing about this mapping that is not obvious from the shape.
    vi.mocked(api.search).mockResolvedValue({
      results: [{ type: 'comment', ref: 'cmt_1', title: 'ACTA-9' }],
    } as never)

    const [first] = await suggest('x')
    first.handler()
    expect(openItem).toHaveBeenCalledWith('ACTA-9')
  })

  it('offers the full search page, but only when there is something to see', async () => {
    vi.mocked(api.search).mockResolvedValue({ results: [] } as never)
    expect(await suggest('nothing')).toHaveLength(0)

    vi.mocked(api.search).mockResolvedValue({
      results: [{ type: 'item', ref: 'ACTA-1', title: 'One' }],
    } as never)
    const commands = await suggest('one')
    expect(commands.at(-1)?.id).toBe('search:all')
  })
})

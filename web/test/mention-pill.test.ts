/**
 * The mention pill, on both surfaces.
 *
 * A mention is stored as `[[@handle]]` and must never be read as one: what a
 * sentence shows is the person, as an avatar and their display name. The
 * reader used to patch its own disc and name into the rendered HTML while the
 * editor rendered a component, so the two already disagreed about the image
 * fallback and about the tooltip. These pin that they are now one component.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

/**
 * The directory, as a ref the test owns, because the order that matters here
 * is the one the app actually has: markdown renders, and the overview lands
 * afterwards.
 */
const overview = ref<{
  actors: {
    id: string
    handle: string
    kind: string
    name: string
    avatar_url?: string
  }[]
} | null>(null)

vi.mock('@/stores/workspace', async () => {
  const actual =
    await vi.importActual<typeof import('@/stores/workspace')>(
      '@/stores/workspace',
    )
  return {
    ...actual,
    useWorkspace: () => ({ overview, onLive: () => () => {} }),
  }
})

const IVAN = {
  id: 'a1',
  handle: 'ivan',
  kind: 'human',
  name: 'Ivan Petrov',
}

const MarkdownView = (await import('@/components/MarkdownView.vue')).default
const RefChip = (await import('@/components/decorations/RefChip.vue')).default

function reader(source: string) {
  return mount(MarkdownView, { props: { source } })
}

/** The editor's side of the same pill, as its node view sees it. */
function editor(target: string) {
  return mount(RefChip, {
    props: { node: { attrs: { target, alias: null } } } as never,
    global: { provide: { onDragStart: () => {}, decorationClasses: '' } },
  })
}

describe('the reader mention pill', () => {
  it('appears once the directory arrives, having rendered before it', async () => {
    overview.value = null
    const view = reader('Ask [[@ivan]] about it.')
    await flushPromises()
    expect(view.text()).not.toContain('Ivan Petrov')

    overview.value = { actors: [IVAN] }
    await nextTick()
    await flushPromises()

    const pill = view.find('.md__mention')
    expect(pill.text()).toContain('Ivan Petrov')
    expect(pill.find('.avatar').exists()).toBe(true)
  })

  it('names the person in a tooltip rather than a title attribute', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader('Ask [[@ivan]] about it.')
    await flushPromises()
    await nextTick()

    const avatar = view.find('.md__mention .avatar')
    // The library directive, not a native title: the same affordance the
    // editor has always had.
    expect(avatar.attributes('data-nb-tooltip-anchor')).toBeDefined()
    expect(avatar.attributes('aria-label')).toContain('Ivan Petrov')
    expect(view.find('.md__mention').attributes('title')).toBeUndefined()
  })

  it('still reads as a mention when the handle resolves to nobody', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader('Ask [[@ghost]] about it.')
    await flushPromises()
    await nextTick()

    const pill = view.find('.md__mention')
    // A pill saying @ghost, not raw markup and not a bare word in a sentence.
    expect(pill.find('.avatar').exists()).toBe(true)
    expect(pill.text()).toContain('@ghost')
    expect(view.text()).not.toContain('[[')
  })
})

describe('the two surfaces', () => {
  it('draw the same pill for the same handle', async () => {
    overview.value = { actors: [IVAN] }
    const read = reader('Ask [[@ivan]] about it.')
    await flushPromises()
    await nextTick()
    const write = editor('@ivan')
    await nextTick()

    // One component, so the assertion is that both surfaces mounted it.
    expect(read.find('.md__mention .actor-chip').exists()).toBe(true)
    expect(write.find('.actor-chip').exists()).toBe(true)
    expect(read.find('.md__mention .actor-chip').text()).toBe(
      write.find('.actor-chip').text(),
    )
    expect(read.find('.md__mention .avatar').attributes('aria-label')).toBe(
      write.find('.avatar').attributes('aria-label'),
    )
  })

  it('falls back to initials on both when the avatar image fails', async () => {
    // The platform gives every upload a new URL and 404s the old one, so a
    // stale URL is routine. The reader used to emit a bare <img> with nothing
    // behind it, which is a broken-image glyph in the middle of a sentence.
    overview.value = {
      actors: [{ ...IVAN, avatar_url: '/api/avatars/gone.png' }],
    }
    const read = reader('Ask [[@ivan]] about it.')
    await flushPromises()
    await nextTick()

    const img = read.find('.md__mention img')
    expect(img.exists()).toBe(true)
    await img.trigger('error')
    expect(read.find('.md__mention img').exists()).toBe(false)
    expect(read.find('.md__mention').text()).toContain('Ivan Petrov')
  })
})

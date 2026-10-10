/**
 * The mention pill, on both surfaces.
 *
 * A mention is stored as `[[@handle]]` and must never be read as one: what a
 * sentence shows is the person, as `@` and their display name. No avatar: in
 * a comment a face means the author, and a second face in the text read as a
 * second author (Jose, 2026-10-10). The reader used to patch its own disc and
 * name into the rendered HTML while the editor rendered a component, so the
 * two disagreed about the tooltip. These pin that they are now one component.
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
    expect(pill.text()).toBe('@Ivan Petrov')
    expect(pill.find('.avatar').exists()).toBe(false)
  })

  it('names the person in a tooltip rather than a title attribute', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader('Ask [[@ivan]] about it.')
    await flushPromises()
    await nextTick()

    const name = view.find('.md__mention .mention-name')
    // The library directive, not a native title: the same hint the avatar
    // gives, so who it is stays one hover away without the face.
    expect(name.attributes('data-nb-tooltip-anchor')).toBeDefined()
    expect(name.attributes('aria-label')).toContain('Ivan Petrov')
    expect(view.find('.md__mention').attributes('title')).toBeUndefined()
  })

  it('still reads as a mention when the handle resolves to nobody', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader('Ask [[@ghost]] about it.')
    await flushPromises()
    await nextTick()

    const pill = view.find('.md__mention')
    // A mention saying @ghost, not raw markup and not a bare word.
    expect(pill.find('.mention-name').exists()).toBe(true)
    expect(pill.text()).toBe('@ghost')
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
    expect(read.find('.md__mention .mention-name').exists()).toBe(true)
    expect(write.find('.mention-name').exists()).toBe(true)
    expect(read.find('.md__mention').text()).toBe(
      write.find('.mention-name').text(),
    )
    expect(
      read.find('.md__mention .mention-name').attributes('aria-label'),
    ).toBe(write.find('.mention-name').attributes('aria-label'))
  })

  it('draw no face on either', async () => {
    // In a comment the avatar is the author. A face inside the text read as
    // a second author, so a mention is a name only.
    overview.value = {
      actors: [{ ...IVAN, avatar_url: '/api/avatars/ivan.png' }],
    }
    const read = reader('Ask [[@ivan]] about it.')
    await flushPromises()
    await nextTick()
    const write = editor('@ivan')
    await nextTick()

    expect(read.find('.md__mention img').exists()).toBe(false)
    expect(read.find('.md__mention .avatar').exists()).toBe(false)
    expect(write.find('img').exists()).toBe(false)
    expect(write.find('.avatar').exists()).toBe(false)
  })
})

/**
 * `@ivan`, which is what people actually write.
 *
 * `[[@ivan]]` is what the typeahead inserts, and for a long time it was the
 * only thing that rendered. It is not what anybody types: in our own
 * workspace not one mention was ever bracketed, so every mention ever
 * written showed as grey text and notified nobody. Jose sent a screenshot of
 * exactly that, five hours after writing the comment.
 */
describe('a mention written the way people write it', () => {
  it('draws a pill for a plain @handle', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader('@ivan could you review this draft?')
    await flushPromises()
    const pill = view.find('.md__mention')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('Ivan Petrov')
  })

  it('leaves the rest of the sentence exactly where it was', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader('hey @ivan, ship it')
    await flushPromises()
    expect(view.text()).toContain('hey')
    expect(view.text()).toContain(', ship it')
  })

  it('leaves an address, a link and code alone', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader(
      'mail ivan@nubisco.io, see [the thread](https://x.com/@ivan), use `@ivan` in the template',
    )
    await flushPromises()
    expect(view.findAll('.md__mention')).toHaveLength(0)
  })

  it('leaves a handle nobody holds as ordinary text', async () => {
    overview.value = { actors: [IVAN] }
    const view = reader('@ivanmarjanovic said so')
    await flushPromises()
    expect(view.findAll('.md__mention')).toHaveLength(0)
    expect(view.text()).toContain('@ivanmarjanovic')
  })

  it('draws the same pill for both forms', async () => {
    overview.value = { actors: [IVAN] }
    const bare = reader('@ivan')
    const bracketed = reader('[[@ivan]]')
    await flushPromises()
    expect(bare.find('.md__mention').text()).toBe(
      bracketed.find('.md__mention').text(),
    )
  })
})

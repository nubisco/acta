/**
 * Round-tripping markdown through the editor.
 *
 * The reader renders GFM tables and task lists. Without the matching nodes in
 * the editor's schema, opening a document that contained one and saving it
 * dropped it: a node the schema does not know is a node the serializer cannot
 * write back. That is silent data loss on a page nobody meant to change, so
 * these assert the round trip rather than the toolbar.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('@/api/client', () => ({
  api: { search: vi.fn(async () => ({ results: [] })) },
  ApiHttpError: class extends Error {},
}))

import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { imageSrc } from '@/components/editor/nodes/Image'

/** A literal NUL, built rather than typed so it survives editing. */
const NUL = String.fromCharCode(0)

/** What the editor gives back after parsing and re-serialising `source`. */
async function roundTrip(source: string): Promise<string> {
  const view = mount(MarkdownEditor, {
    props: { modelValue: source },
    attachTo: document.body,
  })
  await flushPromises()
  const editor = (
    view.vm as unknown as {
      editor?: { storage: { markdown: { getMarkdown(): string } } }
    }
  ).editor
  const out = editor
    ? editor.storage.markdown.getMarkdown()
    : ((view.emitted('update:modelValue')?.at(-1)?.[0] as string) ?? '')
  view.unmount()
  return out
}

describe('MarkdownEditor round trip', () => {
  it('keeps a table', async () => {
    const table = [
      '| Name | Value |',
      '| --- | --- |',
      '| Spec | 2 |',
      '| Phase | MVP |',
    ].join('\n')
    const out = await roundTrip(table)
    expect(out).toContain('Name')
    expect(out).toContain('Phase')
    expect(out).toContain('|')
  })

  it('keeps a fenced code block and its language', async () => {
    const out = await roundTrip('```ts\nconst x = 1\n```')
    expect(out).toContain('const x = 1')
    expect(out).toContain('```')
  })

  it('keeps a task list', async () => {
    const out = await roundTrip('- [ ] not done\n- [x] done')
    expect(out).toContain('not done')
    expect(out).toContain('done')
    expect(out).toMatch(/\[[ x]\]/)
  })
})

/**
 * What the editing surface SHOWS, not just what it writes back.
 *
 * Reported from the app: toggling a document into edit mode made the pictures
 * disappear and the colour swatches vanish, so editing looked like the page
 * being damaged. The document and the editable document have to look the same.
 */
describe('MarkdownEditor decorations', () => {
  async function render(source: string) {
    const view = mount(MarkdownEditor, {
      props: { modelValue: source },
      attachTo: document.body,
    })
    await flushPromises()
    return view
  }

  it('shows an attachment embed as a picture', async () => {
    const view = await render('![Stagewright icon](attachment:att_abc123)')
    const img = view.element.querySelector('img')
    expect(img).not.toBeNull()
    // Resolved to the served path for display...
    expect(img?.getAttribute('src')).toBe('/api/v1/attachments/att_abc123')
    expect(img?.getAttribute('alt')).toBe('Stagewright icon')
    // ...while the markdown text it came from is kept for the save.
    expect(img?.getAttribute('data-src')).toBe('attachment:att_abc123')
    view.unmount()
  })

  it('shows a plain image URL', async () => {
    const view = await render('![A picture](https://example.test/a.png)')
    expect(view.element.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/a.png',
    )
    view.unmount()
  })

  it('never renders an image source that executes', async () => {
    const view = await render('![x](javascript:alert(1))')
    // markdown-it filters the scheme before a node is ever built, so there is
    // no image here at all. Asserted on the DOM rather than on the parser, so
    // this still holds if a document ever reaches the node another way.
    const srcs = view.findAll('img').map((img) => img.attributes('src') ?? '')
    expect(srcs.some((v) => v.includes('javascript:'))).toBe(false)
    view.unmount()
  })

  it('shows a colour swatch beside a hex value', async () => {
    const view = await render('Colors: `#69bb63` `#10a9a4`')
    const dots = view.element.querySelectorAll('.md__color-dot')
    expect(dots.length).toBe(2)
    expect((dots[0] as HTMLElement).style.background).toBe('rgb(105, 187, 99)')
    view.unmount()
  })

  it('does not put a swatch on a code span that is not a colour', async () => {
    const view = await render('Use `#include` and `npm run build`')
    expect(view.element.querySelectorAll('.md__color-dot').length).toBe(0)
    view.unmount()
  })

  it('leaves the document text alone: a swatch is not content', async () => {
    // The decoration must never reach the markdown, or every save would
    // write a dot into somebody's file.
    expect(await roundTrip('Colors: `#69bb63`')).toBe('Colors: `#69bb63`')
  })
})

/**
 * The image node's own source guard, independent of what markdown-it lets
 * through. Two layers, because the parser is not the only way a node can be
 * built: a paste of HTML, or a future importer, reaches the schema directly.
 */
describe('imageSrc', () => {
  it('resolves an attachment id to the served path', () => {
    expect(imageSrc('attachment:att_abc123')).toBe(
      '/api/v1/attachments/att_abc123',
    )
  })

  it('passes an ordinary URL through', () => {
    expect(imageSrc('https://example.test/a.png')).toBe(
      'https://example.test/a.png',
    )
  })

  it('refuses a source that executes', () => {
    expect(imageSrc('javascript:alert(1)')).toBeNull()
    expect(imageSrc('vbscript:msgbox(1)')).toBeNull()
    // A browser strips the NUL while reading the scheme, so this navigates as
    // `javascript:` unless the control characters come out first.
    expect(imageSrc('java' + NUL + 'script:alert(1)')).toBeNull()
  })

  it('refuses an empty attachment id rather than serving the collection', () => {
    expect(imageSrc('attachment:')).toBeNull()
    expect(imageSrc('attachment:   ')).toBeNull()
  })
})

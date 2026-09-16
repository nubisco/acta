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
import {
  IMAGE_MAX_WIDTH,
  IMAGE_MIN_WIDTH,
  resizedWidth,
} from '@/lib/imageAttrs'

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

/**
 * The arithmetic every drag-resize depends on.
 *
 * Asserted on the function rather than through the DOM on purpose: jsdom has
 * no layout engine, so every box it reports is zero and a resize driven
 * through pointer events would assert nothing at all.
 */
describe('resizedWidth', () => {
  it('follows the pointer from a right-hand handle', () => {
    expect(resizedWidth(400, 120, 'right')).toBe(520)
    expect(resizedWidth(400, -120, 'right')).toBe(280)
  })

  it('grows the other way from a left-hand handle', () => {
    // Dragging the left edge leftwards makes the picture wider, which is the
    // opposite sign and the thing most likely to be got backwards.
    expect(resizedWidth(400, -120, 'left')).toBe(520)
    expect(resizedWidth(400, 120, 'left')).toBe(280)
  })

  it('will not shrink a picture below something you can still grab', () => {
    expect(resizedWidth(400, -10000, 'right')).toBe(IMAGE_MIN_WIDTH)
  })

  it('stops at the column it is in', () => {
    expect(resizedWidth(400, 10000, 'right', 720)).toBe(720)
  })

  it('stops at the absolute ceiling when there is no column to ask', () => {
    expect(resizedWidth(400, 100000, 'right')).toBe(IMAGE_MAX_WIDTH)
  })

  it('answers in whole pixels, because the attribute is an integer', () => {
    expect(resizedWidth(400.4, 0.2, 'right')).toBe(401)
    expect(Number.isInteger(resizedWidth(123.45, 6.78, 'right'))).toBe(true)
  })
})

/**
 * The attribute block, as the editor draws it and as its controls change it.
 *
 * The grammar itself is covered by the round-trip suite, which is where a
 * disagreement between the parser and the serializer would show up as damage
 * to a file. These assert the other half: that what is stored is what is
 * drawn, and that pressing a control changes the document rather than only
 * the picture on screen.
 */
describe('MarkdownEditor image attributes', () => {
  async function open(source: string) {
    const view = mount(MarkdownEditor, {
      props: { modelValue: source },
      attachTo: document.body,
    })
    await flushPromises()
    return view
  }

  it('draws the alignment the markdown asked for', async () => {
    const view = await open('![Icon](attachment:att_x){align=center}')
    const img = view.element.querySelector('img')
    expect(img?.getAttribute('class')).toContain('md__img--center')
    // Mirrored onto data so a copy and a paste inside the editor keeps it.
    expect(img?.getAttribute('data-align')).toBe('center')
    view.unmount()
  })

  it('draws the width the markdown asked for', async () => {
    const view = await open('![Icon](attachment:att_x){width=640}')
    const img = view.element.querySelector('img') as HTMLImageElement
    // Read off the parsed style rather than the attribute text, which the
    // DOM reformats (`inline-size: 640px;`) as it takes it in.
    expect(img.style.inlineSize).toBe('640px')
    expect(img.getAttribute('data-width')).toBe('640')
    view.unmount()
  })

  it('leaves no braces in the document text', async () => {
    const view = await open('![Icon](attachment:att_x){align=center width=640}')
    // The block is an instruction to the renderer, never prose. Before it was
    // hoisted onto the node it survived a save as a stray paragraph, adding a
    // line of braces to the file every time the document was opened.
    expect(view.text()).not.toContain('{')
    view.unmount()
  })

  it('shows its controls on the selected picture', async () => {
    const view = await open('![Icon](attachment:att_x)')
    const editor = (
      view.vm as unknown as {
        editor: { commands: { setNodeSelection(p: number): void } }
      }
    ).editor
    editor.commands.setNodeSelection(0)
    await flushPromises()
    expect(view.find('[data-testid="image-tools"]').exists()).toBe(true)
    // Four corners, so a picture can be grabbed from whichever side has room.
    expect(view.findAll('[data-testid^="image-handle-"]').length).toBe(4)
    view.unmount()
  })

  it('writes an alignment into the markdown when the control is pressed', async () => {
    const view = await open('![Icon](attachment:att_x)')
    const editor = (
      view.vm as unknown as {
        editor: {
          commands: { setNodeSelection(p: number): void }
          storage: { markdown: { getMarkdown(): string } }
        }
      }
    ).editor
    editor.commands.setNodeSelection(0)
    await flushPromises()
    await view.get('[aria-label="Align centre"]').trigger('click')
    await flushPromises()
    expect(editor.storage.markdown.getMarkdown()).toBe(
      '![Icon](attachment:att_x){align=center}',
    )
    view.unmount()
  })

  it('takes the alignment back off when the same control is pressed again', async () => {
    const view = await open('![Icon](attachment:att_x){align=center}')
    const editor = (
      view.vm as unknown as {
        editor: {
          commands: { setNodeSelection(p: number): void }
          storage: { markdown: { getMarkdown(): string } }
        }
      }
    ).editor
    editor.commands.setNodeSelection(0)
    await flushPromises()
    await view.get('[aria-label="Align centre"]').trigger('click')
    await flushPromises()
    // Back to a plain image, with no empty braces left behind.
    expect(editor.storage.markdown.getMarkdown()).toBe(
      '![Icon](attachment:att_x)',
    )
    view.unmount()
  })

  it('resets the width without disturbing the alignment', async () => {
    const view = await open('![Icon](attachment:att_x){align=right width=640}')
    const editor = (
      view.vm as unknown as {
        editor: {
          commands: { setNodeSelection(p: number): void }
          storage: { markdown: { getMarkdown(): string } }
        }
      }
    ).editor
    editor.commands.setNodeSelection(0)
    await flushPromises()
    await view.get('[aria-label="Reset width"]').trigger('click')
    await flushPromises()
    expect(editor.storage.markdown.getMarkdown()).toBe(
      '![Icon](attachment:att_x){align=right}',
    )
    view.unmount()
  })

  it('keeps an attribute it does not understand while changing one it does', async () => {
    const view = await open('![Icon](attachment:att_x){caption="a b"}')
    const editor = (
      view.vm as unknown as {
        editor: {
          commands: { setNodeSelection(p: number): void }
          storage: { markdown: { getMarkdown(): string } }
        }
      }
    ).editor
    editor.commands.setNodeSelection(0)
    await flushPromises()
    await view.get('[aria-label="Align left"]').trigger('click')
    await flushPromises()
    expect(editor.storage.markdown.getMarkdown()).toBe(
      '![Icon](attachment:att_x){align=left caption="a b"}',
    )
    view.unmount()
  })
})

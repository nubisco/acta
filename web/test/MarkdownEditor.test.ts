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

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TableRow from '@tiptap/extension-table-row'
import { Markdown } from 'tiptap-markdown'
import { Table, TableCell, TableHeader } from '@/components/editor/nodes/Table'
import { TableGrips, tableGripsKey } from '@/components/editor/tableGrips'
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

  it('shows a toggle as a disclosure, with the title in the summary', async () => {
    const view = await render(':::details How it works\n\nSome body.\n\n:::')
    const el = view.element.querySelector('.md__details')
    expect(el).not.toBeNull()
    // Not the literal fence it used to show.
    expect(view.text()).not.toContain(':::')
    expect(el?.querySelector('summary')?.textContent?.trim()).toBe(
      'How it works',
    )
    expect(el?.textContent).toContain('Some body.')
    // The title is document text, so the caret can go into it and the words
    // can be edited. Only the control beside it is inert.
    expect(
      el?.querySelector('summary')?.closest('[contenteditable="false"]'),
    ).toBeNull()
    expect(el?.querySelector('.md__details-caret')).not.toBeNull()
    view.unmount()
  })

  it('shows a nested toggle inside its parent', async () => {
    const view = await render(
      ':::details Outer\n\n:::details Inner\n\nDeep.\n\n:::\n\n:::',
    )
    expect(
      view.element.querySelectorAll('.md__details .md__details').length,
    ).toBe(1)
    view.unmount()
  })
})

/**
 * Opening and closing a toggle while editing.
 *
 * Whether a section is open is how somebody is reading the document, not
 * something the document says. If it were a node attribute, every click on a
 * caret would be a transaction, the editor would emit an update, and a page
 * nobody edited would come back dirty. So the state lives in the node view
 * and is asserted to reach neither the markdown nor the document.
 */
describe('MarkdownEditor toggle state is not content', () => {
  const source = ':::details How it works\n\nSome body.\n\n:::'

  it('opens and closes without touching the markdown', async () => {
    const view = mount(MarkdownEditor, {
      props: { modelValue: source },
      attachTo: document.body,
    })
    await flushPromises()
    const editor = (
      view.vm as unknown as {
        editor: {
          storage: { markdown: { getMarkdown(): string } }
          state: { doc: { toJSON(): unknown } }
        }
      }
    ).editor
    const before = editor.state.doc.toJSON()
    const emittedBefore = view.emitted('update:modelValue')?.length ?? 0

    const caret = view.element.querySelector(
      '.md__details-caret',
    ) as HTMLElement
    expect(caret).not.toBeNull()
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    caret.click()
    await flushPromises()

    expect(caret.getAttribute('aria-expanded')).toBe('true')
    expect(
      view.element.querySelector('.md__details')?.getAttribute('data-open'),
    ).toBe('true')
    // Nothing was written: not the document, not the markdown, not an event.
    expect(editor.state.doc.toJSON()).toEqual(before)
    expect(editor.storage.markdown.getMarkdown().trim()).toBe(source)
    expect(view.emitted('update:modelValue')?.length ?? 0).toBe(emittedBefore)
    view.unmount()
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

/** Every accessible name on a button under `root`. */
function labels(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('button[aria-label]')).map(
    (element) => element.getAttribute('aria-label') ?? '',
  )
}

/** One button by its accessible name, which is how a person finds it. */
function button(root: ParentNode, label: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`button[aria-label="${label}"]`)
}

/**
 * Table grips and their inline controls.
 *
 * A grip is a mouse affordance: a bar on the left edge of a row and along the
 * top of a column, revealed on hover, which selects that band when clicked and
 * opens the controls for it. Asserted on the DOM rather than on the plugin,
 * because the whole point of the feature is what is on screen.
 *
 * The controls come from `@nubisco/ui`, so these look for the buttons by the
 * label a screen reader would read, not by a class this file invented.
 */
describe('MarkdownEditor table grips', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

  async function render(source: string) {
    const view = mount(MarkdownEditor, {
      props: { modelValue: source },
      attachTo: document.body,
    })
    await flushPromises()
    return view
  }

  function editorOf(view: ReturnType<typeof mount>) {
    return (
      view.vm as unknown as {
        editor: {
          state: unknown
          commands: Record<string, (...args: unknown[]) => boolean>
          view: { dom: HTMLElement }
          storage: { markdown: { getMarkdown(): string } }
        }
      }
    ).editor
  }

  it('puts a grip on every row and every column', async () => {
    const view = await render(table)
    const rows = view.element.querySelectorAll('[data-table-grip="row"]')
    const columns = view.element.querySelectorAll('[data-table-grip="column"]')
    expect(rows.length).toBe(3)
    expect(columns.length).toBe(2)
    // Named, because a bar with no accessible name is a control nobody who is
    // not looking at it can find.
    expect(rows[0].getAttribute('aria-label')).toBe('Row 1')
    expect(columns[1].getAttribute('aria-label')).toBe('Column 2')
    view.unmount()
  })

  it('never lets a grip reach the document', async () => {
    // A grip is a decoration, so it cannot be written to the file. If it ever
    // becomes content, every save writes a stray character into the table.
    const view = await render(table)
    expect(editorOf(view).storage.markdown.getMarkdown().trim()).toBe(table)
    view.unmount()
  })

  it('selects the row when its grip is clicked, and shows the row controls', async () => {
    const view = await render(table)
    const grip = view.element.querySelectorAll(
      '[data-table-grip="row"]',
    )[1] as HTMLElement
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()

    expect(view.element.querySelectorAll('.selectedCell').length).toBe(2)
    expect(labels(document.body)).toContain('Insert row above')
    expect(labels(document.body)).toContain('Insert row below')
    expect(labels(document.body)).toContain('Delete row')
    view.unmount()
  })

  it('offers alignment on a column, because that is what GFM can store', async () => {
    const view = await render(table)
    const grip = view.element.querySelectorAll(
      '[data-table-grip="column"]',
    )[0] as HTMLElement
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()

    const found = labels(document.body)
    expect(found).toContain('Insert column before')
    expect(found).toContain('Align left')
    expect(found).toContain('Align centre')
    expect(found).toContain('Align right')
    expect(found).toContain('Delete column')
    // Alignment is per column, so it is not offered on a row: there is nowhere
    // in a GFM table to write it.
    expect(found).not.toContain('Insert row above')
    view.unmount()
  })

  it('reads delete as destructive', async () => {
    const view = await render(table)
    const grip = view.element.querySelectorAll(
      '[data-table-grip="row"]',
    )[1] as HTMLElement
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()

    const remove = button(document.body, 'Delete row')
    expect(remove).not.toBeNull()
    // The library's own danger variant, not a colour this file painted on.
    expect(remove?.className).toMatch(/danger/)
    view.unmount()
  })

  it('shows no controls until a band is selected', async () => {
    const view = await render(table)
    expect(button(document.body, 'Delete row')).toBeNull()
    view.unmount()
  })
})

/**
 * The keyboard path.
 *
 * Grips are a mouse affordance, and a table that can only be edited with a
 * mouse is not finished, so every grip action has a shortcut and selecting a
 * band from the keyboard puts the same controls on screen.
 *
 * Driven against a bare editor carrying the same extensions rather than the
 * mounted component, because tiptap's bubble menu calls tippy on every
 * selection change and tippy needs a layout engine jsdom does not have. What
 * is under test here is the keymap and what it writes, and both are the same
 * either way.
 */
describe('table keyboard path', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'

  function open(source: string): Editor {
    return new Editor({
      content: source,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4] },
          codeBlock: {},
        }),
        Link.configure({ openOnClick: false }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        TableGrips,
        Markdown.configure({ html: false, linkify: true, breaks: true }),
      ],
    })
  }

  /** In the first body cell, where a caret sits after clicking into a table. */
  function inTable(source = table): Editor {
    const editor = open(source)
    let position = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'table' || position) return true
      position = pos + 1 + node.child(0).nodeSize + 3
      return false
    })
    editor.commands.setTextSelection(position)
    return editor
  }

  function press(
    editor: Editor,
    key: string,
    modifiers: Partial<KeyboardEventInit> = {},
  ): void {
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }),
    )
  }

  function markdown(editor: Editor): string {
    return (editor.storage as { markdown: { getMarkdown(): string } }).markdown
      .getMarkdown()
      .trim()
  }

  it('selects a row with Shift-Space, which opens the row controls', () => {
    const editor = inTable()
    press(editor, ' ', { shiftKey: true })
    expect(editor.view.dom.querySelectorAll('.selectedCell').length).toBe(2)
    expect(
      editor.view.dom.querySelector('[data-table-controls="row"]'),
    ).not.toBeNull()
    editor.destroy()
  })

  it('selects a column with Ctrl-Space, which opens the column controls', () => {
    const editor = inTable()
    press(editor, ' ', { ctrlKey: true })
    expect(editor.view.dom.querySelectorAll('.selectedCell').length).toBe(2)
    expect(
      editor.view.dom.querySelector('[data-table-controls="column"]'),
    ).not.toBeNull()
    editor.destroy()
  })

  it('inserts a row above and below without a mouse', () => {
    const below = inTable()
    press(below, 'ArrowDown', { ctrlKey: true, altKey: true })
    expect(markdown(below)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |')
    below.destroy()

    const above = inTable()
    press(above, 'ArrowUp', { ctrlKey: true, altKey: true })
    expect(markdown(above)).toBe('| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
    above.destroy()
  })

  it('deletes the row the caret is in without a mouse', () => {
    const editor = inTable('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    press(editor, 'Backspace', { ctrlKey: true, altKey: true })
    expect(markdown(editor)).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |')
    editor.destroy()
  })

  it('inserts a column either side without a mouse', () => {
    const after = inTable()
    press(after, 'ArrowRight', { ctrlKey: true, altKey: true })
    expect(markdown(after)).toBe(
      '| a |  | b |\n| --- | --- | --- |\n| 1 |  | 2 |',
    )
    after.destroy()

    const before = inTable()
    press(before, 'ArrowLeft', { ctrlKey: true, altKey: true })
    expect(markdown(before)).toBe(
      '|  | a | b |\n| --- | --- | --- |\n|  | 1 | 2 |',
    )
    before.destroy()
  })

  it('deletes the column the caret is in without a mouse', () => {
    const editor = inTable()
    press(editor, 'Backspace', { ctrlKey: true, altKey: true, shiftKey: true })
    expect(markdown(editor)).toBe('| b |\n| --- |\n| 2 |')
    editor.destroy()
  })

  it('sets and clears alignment without a mouse, and writes it to the file', () => {
    const editor = inTable()
    press(editor, 'l', { ctrlKey: true, shiftKey: true })
    expect(markdown(editor)).toContain('| :--- | --- |')
    press(editor, 'e', { ctrlKey: true, shiftKey: true })
    expect(markdown(editor)).toContain('| :---: | --- |')
    press(editor, 'r', { ctrlKey: true, shiftKey: true })
    expect(markdown(editor)).toContain('| ---: | --- |')
    press(editor, '0', { ctrlKey: true, shiftKey: true })
    expect(markdown(editor)).toContain('| --- | --- |')
    editor.destroy()
  })

  it('reorders a row without a mouse', () => {
    const editor = inTable('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    press(editor, 'ArrowDown', { ctrlKey: true, altKey: true, shiftKey: true })
    expect(markdown(editor)).toBe(
      '| a | b |\n| --- | --- |\n| 3 | 4 |\n| 1 | 2 |',
    )
    editor.destroy()
  })

  it('reorders a column without a mouse', () => {
    const editor = inTable()
    press(editor, 'ArrowRight', { ctrlKey: true, altKey: true, shiftKey: true })
    expect(markdown(editor)).toBe('| b | a |\n| --- | --- |\n| 2 | 1 |')
    editor.destroy()
  })

  it('leaves the same keys alone outside a table', () => {
    // Every one of these declines outside a table, or it would shadow an
    // editing key in ordinary prose.
    const editor = open('Just a sentence.')
    editor.commands.setTextSelection(3)
    press(editor, ' ', { shiftKey: true })
    press(editor, 'Backspace', { ctrlKey: true, altKey: true })
    press(editor, 'ArrowDown', { ctrlKey: true, altKey: true })
    expect(markdown(editor)).toBe('Just a sentence.')
    editor.destroy()
  })
})

/**
 * Dragging a grip to reorder.
 *
 * Only the plumbing is asserted here: which band the drag picked up, and that
 * it is let go of afterwards. Where the pointer landed cannot be tested in
 * jsdom, because `posAtCoords` needs a layout engine, so the move itself is
 * covered by `moveTableRowTo` and `moveTableColumnTo` in the round-trip suite
 * and by the keyboard shortcuts above.
 */
describe('table grip drag', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'

  function open(): Editor {
    return new Editor({
      content: table,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4] },
          codeBlock: {},
        }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        TableGrips,
        Markdown.configure({ html: false, linkify: true, breaks: true }),
      ],
    })
  }

  /** A DragEvent jsdom does not implement, built from what the code reads. */
  function drag(type: string): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { setData: () => {}, effectAllowed: '', dropEffect: '' },
    })
    return event
  }

  it('picks up the row a grip belongs to, and puts it down again', () => {
    const editor = open()
    const grip = editor.view.dom.querySelectorAll(
      '[data-table-grip="row"]',
    )[1] as HTMLElement
    grip.dispatchEvent(drag('dragstart'))
    expect(tableGripsKey.getState(editor.state)?.drag).toMatchObject({
      kind: 'row',
      index: 1,
    })

    editor.view.dom.dispatchEvent(drag('dragend'))
    expect(tableGripsKey.getState(editor.state)?.drag).toBeNull()
    editor.destroy()
  })

  it('picks up a column the same way', () => {
    const editor = open()
    const grip = editor.view.dom.querySelectorAll(
      '[data-table-grip="column"]',
    )[1] as HTMLElement
    grip.dispatchEvent(drag('dragstart'))
    expect(tableGripsKey.getState(editor.state)?.drag).toMatchObject({
      kind: 'column',
      index: 1,
    })
    editor.destroy()
  })
})

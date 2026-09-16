/**
 * Inline comments in the browser: anchoring against what the reader and the
 * editor actually show, and the property the storage decision exists to
 * protect: commenting never changes a byte of the document.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    api: {
      ...(actual.api as object),
      search: vi.fn(async () => ({ results: [] })),
      overview: vi.fn(async () => ({ spaces: [], labels: [], actors: [] })),
    },
  }
})

import type { Editor } from '@tiptap/core'
import { anchorTextFromMarkdown } from '@nubisco/acta-shared'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import CommentThread from '@/components/CommentThread.vue'
import DocCommentLayer from '@/components/comments/DocCommentLayer.vue'
import {
  COMMENT_OPEN_EVENT,
  commentsAt,
  setCommentHighlights,
  type ICommentHighlight,
} from '@/components/comments/commentHighlights'
import {
  HIGHLIGHT,
  HIGHLIGHT_ACTIVE,
  locateHighlights,
  paintHighlights,
} from '@/components/comments/readerHighlights'
import {
  anchorFromDocRange,
  anchorFromDomRange,
  anchorFromQuote,
  createAnchor,
  docTextIndex,
  domTextIndex,
  resolveInDoc,
  resolveInDom,
} from '@/lib/anchors'

/** A document that already survives the editor's own round trip unchanged. */
const SOURCE = [
  '# Release plan',
  '',
  'We ship the **audio host** on Friday, after the soak test passes.',
  '',
  '## Risks',
  '',
  '- The licensing service must be reachable, or activation stalls.',
  '- Run the tests before tagging. Then run the tests again on staging.',
].join('\n')

type TMounted = ReturnType<typeof mount>

const mounted: TMounted[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

async function mountEditor(source = SOURCE) {
  const view = mount(MarkdownEditor, {
    props: { modelValue: source },
    attachTo: document.body,
  })
  mounted.push(view)
  await flushPromises()
  const editor = (view.vm as unknown as { editor: Editor }).editor
  const markdown = () =>
    (
      editor.storage as { markdown: { getMarkdown: () => string } }
    ).markdown.getMarkdown()
  return { view, editor, markdown }
}

async function mountReader(source = SOURCE) {
  const view = mount(MarkdownView, {
    props: { source },
    attachTo: document.body,
  })
  mounted.push(view)
  await flushPromises()
  return { view, root: view.find('.md').element as HTMLElement }
}

/** An anchor on `quote` in whatever text a surface reports. */
function quoteIn(text: string, quote: string, prefix?: string) {
  const found = anchorFromQuote(text, { exact: quote, prefix })
  if (!found.ok) throw new Error(`fixture: ${quote} -> ${found.reason}`)
  return found.anchor
}

describe('text indexes', () => {
  it('reads the reader as the words on the page, blocks on their own lines', async () => {
    const { root } = await mountReader()
    const index = domTextIndex(root)
    expect(index.text).toContain(
      'We ship the audio host on Friday, after the soak test passes.',
    )
    expect(index.text).toMatch(/Release plan\s*\n\s*We ship/)
    const range = index.rangeOf(
      index.text.indexOf('audio host'),
      index.text.indexOf('audio host') + 'audio host on Friday'.length,
    )
    // Across the bold element and out the other side.
    expect(range?.toString()).toBe('audio host on Friday')
  })

  it('reads the editor the same way and maps back to positions', async () => {
    const { editor } = await mountEditor()
    const index = docTextIndex(editor.state.doc)
    const at = index.text.indexOf('soak test')
    const range = index.rangeOf(at, at + 'soak test'.length)!
    expect(editor.state.doc.textBetween(range.from, range.to)).toBe('soak test')
    expect(index.offsetAt(range.from)).toBe(at)
    expect(index.posAt(at)).toBe(range.from)
  })

  it('anchors made on one surface resolve on the others', async () => {
    const { root } = await mountReader()
    const { editor } = await mountEditor()

    // Made in the reader, from a real DOM selection range.
    const readerIndex = domTextIndex(root)
    const start = readerIndex.text.indexOf('licensing service must')
    const range = readerIndex.rangeOf(
      start,
      start + 'licensing service must'.length,
    )!
    const fromReader = anchorFromDomRange(readerIndex, range)!
    expect(fromReader.exact).toBe('licensing service must')

    // ...found in the editor,
    const docIndex = docTextIndex(editor.state.doc)
    const inEditor = resolveInDoc(docIndex, fromReader)!
    expect(editor.state.doc.textBetween(inEditor.from, inEditor.to)).toBe(
      'licensing service must',
    )
    // ...and by the server, which only has the markdown.
    const serverText = anchorTextFromMarkdown(SOURCE)
    expect(anchorFromQuote(serverText, fromReader).ok).toBe(true)

    // Made in the editor, found in the reader.
    const repeat = docIndex.text.lastIndexOf('run the tests')
    const fromEditor = anchorFromDocRange(
      docIndex,
      docIndex.posAt(repeat),
      docIndex.posAt(repeat + 'run the tests'.length),
    )!
    const inReader = resolveInDom(domTextIndex(root), fromEditor)!
    expect(inReader.toString()).toBe('run the tests')
    // The second repeat, not the first.
    expect(
      domTextIndex(root).offsetAt(
        inReader.startContainer,
        inReader.startOffset,
      ),
    ).toBe(domTextIndex(root).text.lastIndexOf('run the tests'))
  })

  it('addresses a whole block, the way a block link would', async () => {
    const { root } = await mountReader()
    const index = domTextIndex(root)
    const item = root.querySelectorAll('li')[1]
    const span = index.offsetsOf(item)!
    const anchor = createAnchor(index.text, span.start, span.end)
    expect(anchor.exact).toBe(
      'Run the tests before tagging. Then run the tests again on staging.',
    )
    const found = resolveInDom(index, anchor)!
    expect(found.startContainer.parentElement?.closest('li')).toBe(item)
  })
})

describe('editor highlights', () => {
  it('decorates anchored text and never writes it to the markdown', async () => {
    const { editor, markdown } = await mountEditor()
    const before = markdown()
    const text = docTextIndex(editor.state.doc).text
    const highlights: ICommentHighlight[] = [
      { id: 'c1', anchor: quoteIn(text, 'audio host on Friday') },
      { id: 'c2', anchor: quoteIn(text, 'run the tests', 'Then') },
    ]
    setCommentHighlights(editor.view, highlights, 'c2')
    const marked = editor.view.dom.querySelectorAll('.md__comment-anchor')
    expect(marked.length).toBeGreaterThanOrEqual(2)
    expect(
      editor.view.dom.querySelector('.md__comment-anchor--active')?.textContent,
    ).toBe('run the tests')
    expect(markdown()).toBe(before)
    expect(markdown()).not.toContain('comment')
    expect(JSON.stringify(editor.getJSON())).not.toContain('comment')
  })

  it('follows the text through edits and drops a deleted range', async () => {
    const { editor } = await mountEditor()
    const text = docTextIndex(editor.state.doc).text
    setCommentHighlights(editor.view, [
      { id: 'c1', anchor: quoteIn(text, 'soak test') },
    ])
    // Type at the very start of the document.
    editor.commands.insertContentAt(1, 'Draft: ')
    const mark = editor.view.dom.querySelector('.md__comment-anchor')
    expect(mark?.textContent).toBe('soak test')
    const pos = docTextIndex(editor.state.doc).text.indexOf('soak test')
    const range = docTextIndex(editor.state.doc).rangeOf(pos, pos + 9)!
    expect(commentsAt(editor.state, range.from + 2)).toEqual(['c1'])
    editor.commands.deleteRange(range)
    expect(editor.view.dom.querySelector('.md__comment-anchor')).toBeNull()
  })

  it('announces a click on a highlight', async () => {
    const { editor } = await mountEditor()
    const text = docTextIndex(editor.state.doc).text
    setCommentHighlights(editor.view, [
      { id: 'c9', anchor: quoteIn(text, 'soak test') },
    ])
    const heard: string[] = []
    editor.view.dom.addEventListener(COMMENT_OPEN_EVENT, (e) =>
      heard.push((e as CustomEvent<{ id: string }>).detail.id),
    )
    const at = docTextIndex(editor.state.doc).text.indexOf('soak test')
    const pos = docTextIndex(editor.state.doc).posAt(at + 3)
    editor.view.someProp('handleClick', (f) =>
      f(editor.view, pos, new MouseEvent('click')),
    )
    expect(heard).toEqual(['c9'])
  })
})

describe('reader highlights', () => {
  it('paints through the highlight registry and leaves the HTML alone', async () => {
    const registry = new Map<string, { ranges: Range[] }>()
    class FakeHighlight {
      ranges: Range[]
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
    vi.stubGlobal('Highlight', FakeHighlight)
    vi.stubGlobal('CSS', {
      ...(globalThis.CSS ?? {}),
      escape: (v: string) => v,
      highlights: registry,
    })
    try {
      const { root } = await mountReader()
      const html = root.innerHTML
      const text = domTextIndex(root).text
      const painted = locateHighlights(root, [
        { id: 'c1', anchor: quoteIn(text, 'soak test') },
        { id: 'c2', anchor: quoteIn(text, 'activation stalls') },
        // Detached: its text is not on the page, so nothing is painted.
        {
          id: 'c3',
          anchor: createAnchor('a sentence that was deleted', 0, 27),
        },
      ])
      paintHighlights(painted, 'c2')
      expect(painted.map((p) => p.id)).toEqual(['c1', 'c2'])
      expect(registry.get(HIGHLIGHT)!.ranges.map((r) => r.toString())).toEqual([
        'soak test',
      ])
      expect(
        registry.get(HIGHLIGHT_ACTIVE)!.ranges.map((r) => r.toString()),
      ).toEqual(['activation stalls'])
      // Nothing was written into the page.
      expect(root.innerHTML).toBe(html)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the document is never changed by commenting', () => {
  it('stays byte-identical through adding, anchoring and resolving', async () => {
    const { editor, markdown } = await mountEditor()
    // The source already round-trips, so any difference below is the
    // comment machinery's doing.
    const original = markdown()
    expect(original).toBe(SOURCE)

    const layer = mount(DocCommentLayer, {
      props: {
        editor,
        comments: [],
      },
      attachTo: document.body,
    })
    mounted.push(layer)
    await flushPromises()
    const text = docTextIndex(editor.state.doc).text

    // Add a comment being written: its pending highlight appears.
    const pending = quoteIn(text, 'licensing service')
    await layer.setProps({ pending })
    expect(editor.view.dom.querySelector('.md__comment-anchor')).not.toBeNull()
    expect(markdown()).toBe(original)

    // Anchor it and another, as the server hands them back.
    const comments: {
      id: string
      anchor: ReturnType<typeof quoteIn>
      resolved?: { ts: number }
    }[] = [
      { id: 'c1', anchor: pending },
      { id: 'c2', anchor: quoteIn(text, 'on Friday') },
    ]
    await layer.setProps({ pending: null, comments, activeId: 'c2' })
    expect(
      editor.view.dom.querySelectorAll('.md__comment-anchor').length,
    ).toBeGreaterThanOrEqual(2)
    expect(markdown()).toBe(original)

    // Resolve both: highlights go, the document does not move.
    await layer.setProps({
      comments: comments.map((c) => ({ ...c, resolved: { ts: 1 } })),
      activeId: null,
    })
    expect(editor.view.dom.querySelector('.md__comment-anchor')).toBeNull()
    expect(markdown()).toBe(original)
    expect(markdown()).toBe(SOURCE)

    // And the model the markdown is written from carries no trace either.
    expect(JSON.stringify(editor.getJSON())).not.toMatch(/comment/i)
    // Nothing was ever emitted as an edit.
    const editorView = mounted[0]
    expect(editorView.emitted('update:modelValue')).toBeUndefined()
  })
})

describe('comment thread', () => {
  it('shows the quote, marks detached and resolved, and offers resolve', async () => {
    const view = mount(CommentThread, {
      props: {
        modelValue: '',
        commenting: false,
        resolvable: true,
        comments: [
          {
            id: 'c1',
            by: 'jose',
            ts: 1756000000000,
            body: 'Gone?',
            anchor: { exact: 'deleted sentence' },
            anchor_status: 'detached',
          },
          {
            id: 'c2',
            by: 'jose',
            ts: 1756000000000,
            body: 'Done.',
            anchor: { exact: 'kept sentence' },
            anchor_status: 'anchored',
            resolved: { ts: 1756000001000, by: 'jose' },
          },
          { id: 'c3', by: 'jose', ts: 1756000000000, body: 'Page comment.' },
        ],
      },
      global: { stubs: { teleport: true } },
    })
    mounted.push(view)
    await flushPromises()
    const items = view.findAll('li')
    // Detached is still listed, with what it was about.
    expect(items[0].text()).toContain('detached')
    expect(items[0].find('.thread__quote').text()).toBe('deleted sentence')
    expect(items[1].text()).toContain('resolved')
    expect(items[2].find('.thread__quote').exists()).toBe(false)
    expect(items[2].find('[aria-label="Resolve comment"]').exists()).toBe(false)

    await items[0].find('[aria-label="Resolve comment"]').trigger('click')
    await items[1].find('[aria-label="Reopen comment"]').trigger('click')
    expect(view.emitted('resolve')).toEqual([
      ['c1', true],
      ['c2', false],
    ])
  })

  it('shows the pending quote with a way out', async () => {
    const view = mount(CommentThread, {
      props: {
        modelValue: '',
        commenting: false,
        comments: [],
        quote: 'soak test',
      },
      global: { stubs: { teleport: true } },
    })
    mounted.push(view)
    await flushPromises()
    expect(view.find('.thread__pending').text()).toContain('soak test')
    await view
      .find('[aria-label="Stop commenting on this text"]')
      .trigger('click')
    expect(view.emitted('clear-quote')).toHaveLength(1)
  })
})

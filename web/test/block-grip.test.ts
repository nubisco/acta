/**
 * The editor's block tools: the one selection toolbar, the grip menu (turn
 * into, duplicate, copy link, delete), the `+` insert menu, reordering, and
 * links to a block.
 *
 * Documents are stored as markdown, and every one of these acts on a document
 * that is saved back to a file. So most of what is asserted here is bytes:
 * what each operation writes, that writing it again reads back the same
 * (stable), and that the tools which are not supposed to write anything do
 * not.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

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
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import DocCommentLayer from '@/components/comments/DocCommentLayer.vue'
import {
  blockConversions,
  convertBlock,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  type TBlockKind,
  type TDispatch,
} from '@/components/editor/blockOps'
import {
  blockAnchor,
  blockFragment,
  blockLinkUrl,
  findLinkedBlock,
  isBlockFragment,
  parseBlockFragment,
} from '@/lib/blockLinks'

/*
 * jsdom has no layout engine. ProseMirror asks for rectangles when a focused
 * editor scrolls its selection into view, and the table plugin asks which
 * element is under the pointer on every mousemove. Empty answers, which
 * ProseMirror already handles, rather than a TypeError from a missing method.
 */
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.getClientRects ??= () => []
  const range = Range.prototype as unknown as Record<string, unknown>
  range.getClientRects ??= () => []
  range.getBoundingClientRect ??= () => new DOMRect()
  const doc = document as unknown as Record<string, unknown>
  doc.elementFromPoint ??= () => null
})

const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

function markdownOf(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown()
}

async function mountEditor(
  source: string,
  props: Record<string, unknown> = {},
): Promise<{ view: VueWrapper; editor: Editor }> {
  const view = mount(MarkdownEditor, {
    props: { modelValue: source, ...props },
    attachTo: document.body,
  })
  mounted.push(view)
  await flushPromises()
  return { view, editor: (view.vm as unknown as { editor: Editor }).editor }
}

/**
 * A separate editor used only to read markdown back in. Stable means: what an
 * operation wrote, parsed and written again, is the same bytes.
 */
let reader: Editor
beforeAll(async () => {
  reader = (await mountEditor('')).editor
  mounted.length = 0
})

function reparsed(markdown: string): string {
  reader.commands.setContent(markdown)
  return markdownOf(reader)
}

/** Runs a block operation the way the gutter does, through the view. */
function apply(editor: Editor, op: (dispatch: TDispatch) => boolean): boolean {
  return op((tr) => editor.view.dispatch(tr))
}

function words(markdown: string): string[] {
  return (
    markdown
      // Syntax that carries no words: list numbers, task boxes, callout keywords.
      .replace(/^(?:>\s*)*\d+\.\s/gm, '')
      .replace(/\[[ xX]\]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(
        (w) =>
          w &&
          !['NOTE', 'TIP', 'INFO', 'WARNING', 'DANGER', 'details'].includes(w),
      )
      .sort()
  )
}

// ---------------------------------------------------------------------------
// The selection toolbar
// ---------------------------------------------------------------------------

describe('selection toolbar', () => {
  /** The editor and the comment layer, wired the way the docs page wires them. */
  async function page(source: string) {
    const composed: unknown[] = []
    const Host = defineComponent({
      setup() {
        const editorRef = shallowRef<{ editor: Editor } | null>(null)
        return () => [
          h(MarkdownEditor, {
            ref: editorRef,
            modelValue: source,
            commentable: true,
            onComment: (anchor: unknown) => composed.push(anchor),
          }),
          h(DocCommentLayer, {
            editor: editorRef.value?.editor ?? null,
            comments: [],
          }),
        ]
      },
    })
    const view = mount(Host, { attachTo: document.body })
    mounted.push(view)
    await flushPromises()
    const editor = (
      view.findComponent(MarkdownEditor).vm as unknown as { editor: Editor }
    ).editor
    return { view, editor, composed }
  }

  async function select(editor: Editor, from: number, to: number) {
    // The view's own focus, which is synchronous. Tiptap's focus command
    // waits a frame first.
    editor.view.focus()
    editor.commands.setTextSelection({ from, to })
    document.dispatchEvent(new Event('selectionchange'))
    await flushPromises()
    await nextTick()
  }

  it('shows exactly one toolbar for an editor selection, holding formatting and comment', async () => {
    const { editor } = await page('We ship the audio host on Friday.')
    await select(editor, 4, 20)

    const toolbars = document.querySelectorAll('[role="toolbar"]')
    expect(toolbars.length).toBe(1)
    const labels = Array.from(
      toolbars[0].querySelectorAll('button[aria-label]'),
    ).map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual([
      'Bold',
      'Italic',
      'Strikethrough',
      'Inline code',
      'Heading 2',
      'Heading 3',
      'Bullet list',
      'Numbered list',
      'Quote',
      'Comment on this text',
    ])
    // The old bubble menu and the tippy box it lived in are gone.
    expect(document.querySelector('.md-editor__bubble')).toBeNull()
    expect(document.querySelector('[data-tippy-root]')).toBeNull()
  })

  it('shows nothing for a collapsed caret', async () => {
    const { editor } = await page('We ship the audio host on Friday.')
    await select(editor, 4, 4)
    expect(document.querySelectorAll('[role="toolbar"]').length).toBe(0)
  })

  it('keeps the selection through every action', async () => {
    const { editor, composed } = await page(
      'We ship the audio host on Friday, after the soak test passes.',
    )
    await select(editor, 13, 23)
    const selected = () =>
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      )
    expect(selected()).toBe('audio host')

    const buttons = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[role="toolbar"] button[data-action]',
        ),
      )
    const ids = buttons().map((b) => b.dataset.action!)
    expect(ids).toHaveLength(10)
    for (const id of ids) {
      const button = buttons().find((b) => b.dataset.action === id)!
      const down = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      })
      button.dispatchEvent(down)
      // Cancelled, so the press never moves focus or collapses the selection.
      expect(down.defaultPrevented).toBe(true)
      button.click()
      await flushPromises()
      expect(selected(), `after ${id}`).toBe('audio host')
      expect(document.querySelectorAll('[role="toolbar"]').length).toBe(1)
    }
    expect(composed).toHaveLength(1)
    expect((composed[0] as { exact: string }).exact).toBe('audio host')
  })

  it('marks the formatting the selection already has', async () => {
    const { editor } = await page('We ship the **audio host** on Friday.')
    await select(editor, 13, 23)
    const bold = document.querySelector('[data-action="bold"]')!
    expect(bold.getAttribute('aria-pressed')).toBe('true')
    const italic = document.querySelector('[data-action="italic"]')!
    expect(italic.getAttribute('aria-pressed')).toBe('false')
  })

  it('leaves the reader its own comment toolbar', async () => {
    const view = mount(MarkdownView, {
      props: { source: 'Readers can comment on this sentence.' },
      attachTo: document.body,
    })
    mounted.push(view)
    await flushPromises()
    const layer = mount(DocCommentLayer, {
      props: { reader: view.element as HTMLElement, comments: [] },
      attachTo: document.body,
    })
    mounted.push(layer)
    await flushPromises()
    const p = view.element.querySelector('.md p')!
    const range = document.createRange()
    range.setStart(p.firstChild!, 0)
    range.setEnd(p.firstChild!, 7)
    range.getBoundingClientRect = () => new DOMRect(0, 0, 10, 10)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await flushPromises()
    const toolbars = document.querySelectorAll('[role="toolbar"]')
    expect(toolbars.length).toBe(1)
    expect(
      Array.from(toolbars[0].querySelectorAll('button')).map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Comment on this text'])
  })
})

// ---------------------------------------------------------------------------
// Turn into
// ---------------------------------------------------------------------------

const SOURCES: Record<string, string> = {
  paragraph: 'Ship the **audio host** on Friday.',
  heading: '## Release plan',
  bulletList: '- first item\n- second item',
  orderedList: '1. first item\n2. second item',
  // Task lists are written loose, one blank line between items.
  taskList: '- [ ] first task\n\n- [x] done task',
  blockquote: '> A quoted line.',
  callout: '> [!WARNING] Heads up\n> The service must be reachable.',
  details: ':::details More detail\n\nHidden body text.\n\n:::',
  codeBlock: '```\nconst x = 1\n```',
  // The awkward ones: a line break a heading cannot hold, code whose
  // indentation prose would swallow, and containers holding more than text.
  lineBreak: 'First line\\\nsecond line',
  indentedCode: '```ts\nif (ok) {\n  run()\n}\n```',
  calloutList: '> [!NOTE]\n> - one\n> - two',
  quoteWithCode: '> Intro\n>\n> ```\n> code\n> ```',
}

function framed(block: string): string {
  return `Before.\n\n${block}\n\nAfter.`
}

describe('turn into', () => {
  it('starts from sources that are themselves stable', () => {
    for (const source of Object.values(SOURCES))
      expect(reparsed(framed(source))).toBe(framed(source))
  })

  it('round-trips every offered conversion to stable markdown that keeps the words', async () => {
    const { editor } = await mountEditor('')
    let checked = 0
    for (const [name, source] of Object.entries(SOURCES)) {
      editor.commands.setContent(framed(source))
      const offered = blockConversions(editor.state, 1)
      expect(offered.length, name).toBeGreaterThan(0)
      for (const option of offered) {
        editor.commands.setContent(framed(source))
        const before = markdownOf(editor)
        expect(
          apply(editor, (d) => convertBlock(editor.state, 1, option.target, d)),
          `${name} -> ${option.target}`,
        ).toBe(true)
        const out = markdownOf(editor)
        expect(out, `${name} -> ${option.target}`).not.toBe(before)
        expect(reparsed(out), `${name} -> ${option.target} is stable`).toBe(out)
        expect(words(out), `${name} -> ${option.target} keeps words`).toEqual(
          words(before),
        )
        expect(out.startsWith('Before.\n\n')).toBe(true)
        expect(out.endsWith('\n\nAfter.')).toBe(true)
        checked += 1
      }
    }
    // Enough of the matrix ran that a regression cannot hide in it.
    expect(checked).toBeGreaterThan(80)
  })

  const EXPECTED: [string, TBlockKind, string][] = [
    ['paragraph', 'taskList', '- [ ] Ship the **audio host** on Friday.'],
    [
      'paragraph',
      'callout:note',
      '> [!NOTE]\n> Ship the **audio host** on Friday.',
    ],
    ['paragraph', 'heading1', '# Ship the **audio host** on Friday.'],
    ['heading', 'details', ':::details Release plan\n\n:::'],
    // Task lists are written loose and bullet lists tight, by the serializer.
    ['bulletList', 'taskList', '- [ ] first item\n\n- [ ] second item'],
    ['taskList', 'bulletList', '- first task\n- done task'],
    ['taskList', 'paragraph', 'first task\n\ndone task'],
    ['blockquote', 'callout:tip', '> [!TIP]\n> A quoted line.'],
    [
      'callout',
      'callout:danger',
      '> [!DANGER] Heads up\n> The service must be reachable.',
    ],
    [
      'callout',
      'details',
      ':::details Heads up\n\nThe service must be reachable.\n\n:::',
    ],
    ['details', 'paragraph', 'More detail\n\nHidden body text.'],
    [
      'details',
      'callout:info',
      '> [!INFO]\n> More detail\n>\n> Hidden body text.',
    ],
    ['codeBlock', 'paragraph', 'const x = 1'],
  ]

  it.each(EXPECTED)('turns a %s into %s', async (name, target, expected) => {
    const { editor } = await mountEditor(framed(SOURCES[name]))
    expect(apply(editor, (d) => convertBlock(editor.state, 1, target, d))).toBe(
      true,
    )
    expect(markdownOf(editor)).toBe(framed(expected))
  })

  it('says what a conversion loses when it keeps the words but not the rest', async () => {
    const { editor } = await mountEditor(framed(SOURCES.paragraph))
    const code = blockConversions(editor.state, 1).find(
      (c) => c.target === 'codeBlock',
    )
    expect(code?.warning).toBe('removes formatting')

    editor.commands.setContent(framed(SOURCES.taskList))
    const paragraph = blockConversions(editor.state, 1).find(
      (c) => c.target === 'paragraph',
    )
    expect(paragraph?.warning).toBe('clears ticked tasks')
  })

  it('offers nothing that would lose words', async () => {
    const { editor } = await mountEditor(
      framed('- first\n  - nested\n- second'),
    )
    const targets = blockConversions(editor.state, 1).map((c) => c.target)
    // A nested list has no single line to become, and no flat paragraphs.
    expect(targets).not.toContain('paragraph')
    expect(targets).not.toContain('heading1')
    expect(targets).not.toContain('codeBlock')
    // Multi-line code would be folded onto one line as a heading.
    editor.commands.setContent(framed('```\none\ntwo\n```'))
    const code = blockConversions(editor.state, 1).map((c) => c.target)
    expect(code).not.toContain('heading2')
    expect(code).not.toContain('paragraph')
  })

  it('offers no conversions for tables, images, diagrams or maths', async () => {
    const { editor } = await mountEditor(framed(SOURCES.paragraph))
    for (const block of [
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      '![Chart](attachment:att_1){align=center width=50%}',
      '```mermaid\ngraph TD;\n  A-->B;\n```',
      '$$\nE = mc^2\n$$',
    ]) {
      editor.commands.setContent(framed(block))
      expect(blockConversions(editor.state, 1), block).toEqual([])
      expect(
        apply(editor, (d) => convertBlock(editor.state, 1, 'paragraph', d)),
      ).toBe(false)
      expect(markdownOf(editor)).toBe(framed(block))
    }
  })

  it('joins a new list onto a list of the same kind beside it, as markdown will', async () => {
    const { editor } = await mountEditor('- one\n- two\n\nthree')
    apply(editor, (d) => convertBlock(editor.state, 1, 'bulletList', d))
    expect(editor.state.doc.childCount).toBe(1)
    const out = markdownOf(editor)
    expect(reparsed(out)).toBe(out)
    expect(words(out)).toEqual(['one', 'three', 'two'])
  })
})

// ---------------------------------------------------------------------------
// Duplicate, delete, reorder
// ---------------------------------------------------------------------------

const PARTS = [
  'Intro paragraph.',
  '> [!TIP] Title\n> Callout body.',
  ':::details Toggle\n\nToggle body.\n\n:::',
  '| a | b |\n| --- | --- |\n| 1 | 2 |',
  '![Chart](attachment:att_1){align=center width=50%}',
  '```mermaid\ngraph TD;\n  A-->B;\n```',
  '$$\nE = mc^2\n$$',
  'Outro paragraph.',
]
const DOC = PARTS.join('\n\n')

describe('duplicate, delete and reorder', () => {
  /**
   * The document index of each part. A picture on a line of its own leaves an
   * empty paragraph behind it when parsed, which writes nothing and is not a
   * part, so parts and top-level nodes are not one to one.
   */
  function partIndices(editor: Editor): number[] {
    const out: number[] = []
    editor.state.doc.forEach((node, _offset, index) => {
      if (node.type.name === 'paragraph' && node.childCount === 0) return
      out.push(index)
    })
    return out
  }

  it('starts from a document the editor writes back unchanged', async () => {
    const { editor } = await mountEditor(DOC)
    expect(partIndices(editor)).toHaveLength(PARTS.length)
    expect(markdownOf(editor)).toBe(DOC)
  })

  it('duplicates every kind of block', async () => {
    const { editor } = await mountEditor(DOC)
    for (let i = 0; i < PARTS.length; i++) {
      editor.commands.setContent(DOC)
      const at = partIndices(editor)[i]
      expect(apply(editor, (d) => duplicateBlock(editor.state, at, d))).toBe(
        true,
      )
      const parts = [...PARTS]
      parts.splice(i + 1, 0, PARTS[i])
      const expected = parts.join('\n\n')
      expect(markdownOf(editor), `duplicate ${i}`).toBe(expected)
      expect(reparsed(expected)).toBe(expected)
    }
  })

  it('deletes every kind of block', async () => {
    const { editor } = await mountEditor(DOC)
    for (let i = 0; i < PARTS.length; i++) {
      editor.commands.setContent(DOC)
      const at = partIndices(editor)[i]
      expect(apply(editor, (d) => deleteBlock(editor.state, at, d))).toBe(true)
      const expected = PARTS.filter((_, j) => j !== i).join('\n\n')
      expect(markdownOf(editor), `delete ${i}`).toBe(expected)
      expect(reparsed(expected)).toBe(expected)
    }
  })

  it('leaves an empty paragraph when the only block is deleted', async () => {
    const { editor } = await mountEditor('Only block.')
    apply(editor, (d) => deleteBlock(editor.state, 0, d))
    expect(markdownOf(editor)).toBe('')
    expect(editor.state.doc.childCount).toBe(1)
  })

  it('moves every block to every position', async () => {
    const { editor } = await mountEditor(DOC)
    for (let from = 0; from < PARTS.length; from++) {
      for (let to = 0; to < PARTS.length; to++) {
        if (from === to) continue
        editor.commands.setContent(DOC)
        const indices = partIndices(editor)
        expect(
          apply(editor, (d) =>
            moveBlock(editor.state, indices[from], indices[to], d),
          ),
        ).toBe(true)
        const parts = [...PARTS]
        const [moved] = parts.splice(from, 1)
        parts.splice(to, 0, moved)
        const expected = parts.join('\n\n')
        const out = markdownOf(editor)
        // A table written last carries a trailing newline of its own. That is
        // the table serializer, and it is the same before any move.
        expect(out.trimEnd(), `move ${from} -> ${to}`).toBe(expected)
        expect(reparsed(out), `move ${from} -> ${to} is stable`).toBe(out)
      }
    }
  })

  it('joins two lists that a delete leaves touching', async () => {
    const { editor } = await mountEditor('- a\n- b\n\nMiddle.\n\n- c')
    apply(editor, (d) => deleteBlock(editor.state, 1, d))
    expect(editor.state.doc.childCount).toBe(1)
    const out = markdownOf(editor)
    expect(reparsed(out)).toBe(out)
  })
})

// ---------------------------------------------------------------------------
// The gutter, mounted
// ---------------------------------------------------------------------------

const GUTTER_DOC = [
  'First paragraph of the page.',
  '> [!NOTE]\n> A callout in the middle.',
  'Last paragraph of the page.',
].join('\n\n')

async function gutterEditor(source = GUTTER_DOC) {
  const mountedEditor = await mountEditor(source, { blockTools: true })
  const { editor } = mountedEditor
  function blockEl(index: number): HTMLElement {
    return editor.view.dom.children[index] as HTMLElement
  }
  async function hover(index: number) {
    const target = blockEl(index)
    const inner = target.querySelector('p') ?? target
    inner.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await flushPromises()
  }
  function handle(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="block-gutter"] .nb-drag-handle',
    )!
  }
  function plus(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="block-gutter"] button[aria-label="Insert a block below"]',
    )!
  }
  function menuItems(): string[] {
    return Array.from(
      document.querySelectorAll('[role="menu"] [role="menuitem"]'),
    ).map((el) => el.textContent?.trim() ?? '')
  }
  function menuItem(label: string): HTMLElement | undefined {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'),
    ).find((el) => el.textContent?.trim() === label)
  }
  async function key(target: HTMLElement, k: string) {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    )
    await flushPromises()
  }
  return {
    ...mountedEditor,
    blockEl,
    hover,
    handle,
    plus,
    menuItems,
    menuItem,
    key,
  }
}

describe('the gutter', () => {
  it('appears for the hovered top-level block, and only with blockTools', async () => {
    const plain = await mountEditor(GUTTER_DOC)
    expect(
      plain.view.element.parentElement!.querySelector(
        '[data-testid="block-gutter"]',
      ),
    ).toBeNull()

    const g = await gutterEditor()
    expect(document.querySelector('[data-testid="block-gutter"]')).toBeNull()
    await g.hover(1)
    expect(g.handle()).not.toBeNull()
    expect(g.handle().getAttribute('aria-label')).toBe(
      'Block 2: A callout in the middle.',
    )
    expect(g.plus()).not.toBeNull()
  })

  it('opens the actions menu from a click or Enter, with delete marked destructive', async () => {
    const g = await gutterEditor()
    await g.hover(0)
    g.handle().click()
    await flushPromises()
    expect(g.menuItems()).toEqual([
      'Turn into',
      'Duplicate',
      'Copy link to block',
      'Delete',
    ])
    expect(g.menuItem('Delete')!.className).toMatch(/danger/)
    await g.key(document.querySelector('[role="menu"]')!, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await g.key(g.handle(), 'Enter')
    expect(g.menuItems()).toContain('Duplicate')
    // Enter opened the menu, it did not pick the block up.
    expect(g.handle().className).not.toMatch(/grabbed/)
  })

  it('turns a block into another from the menu', async () => {
    const g = await gutterEditor()
    await g.hover(0)
    g.handle().click()
    await flushPromises()
    g.menuItem('Turn into')!.click()
    await flushPromises()
    await nextTick()
    expect(g.menuItems()[0]).toBe('Back')
    expect(g.menuItems()).toContain('Task list')
    expect(g.menuItems()).not.toContain('Paragraph')
    g.menuItem('Task list')!.click()
    await flushPromises()
    expect(markdownOf(g.editor)).toBe(
      GUTTER_DOC.replace(
        'First paragraph of the page.',
        '- [ ] First paragraph of the page.',
      ),
    )
  })

  it('duplicates and deletes from the menu', async () => {
    const g = await gutterEditor()
    await g.hover(1)
    g.handle().click()
    await flushPromises()
    g.menuItem('Duplicate')!.click()
    await flushPromises()
    const callout = '> [!NOTE]\n> A callout in the middle.'
    expect(markdownOf(g.editor)).toBe(
      [
        'First paragraph of the page.',
        callout,
        callout,
        'Last paragraph of the page.',
      ].join('\n\n'),
    )
    await g.hover(0)
    g.handle().click()
    await flushPromises()
    g.menuItem('Delete')!.click()
    await flushPromises()
    expect(markdownOf(g.editor)).toBe(
      [callout, callout, 'Last paragraph of the page.'].join('\n\n'),
    )
  })

  it('reorders by keyboard, and Escape puts it back', async () => {
    const g = await gutterEditor()
    await g.hover(0)
    const handle = g.handle()
    handle.focus()
    await g.key(handle, ' ')
    expect(handle.className).toMatch(/grabbed/)
    await g.key(handle, 'ArrowDown')
    await g.key(handle, 'ArrowDown')
    await g.key(handle, ' ')
    expect(markdownOf(g.editor)).toBe(
      [
        '> [!NOTE]\n> A callout in the middle.',
        'Last paragraph of the page.',
        'First paragraph of the page.',
      ].join('\n\n'),
    )
    // Announced, since the handle cannot know where the block went.
    expect(document.body.textContent).toContain('Moved to position 3 of 3.')

    const moved = markdownOf(g.editor)
    const again = g.handle()
    again.focus()
    await g.key(again, ' ')
    await g.key(again, 'ArrowUp')
    await g.key(again, 'Escape')
    expect(markdownOf(g.editor)).toBe(moved)
    expect(document.body.textContent).toContain('Move cancelled.')
  })

  it('reorders by pointer, dropping where the pointer lets go', async () => {
    const g = await gutterEditor()
    for (let i = 0; i < 3; i++)
      g.blockEl(i).getBoundingClientRect = () => new DOMRect(0, i * 50, 400, 40)
    await g.hover(2)
    const handle = g.handle()
    const pointer = (type: string, clientY: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: 0,
          clientY,
        }),
      )
    pointer('pointerdown', 120)
    pointer('pointermove', 60)
    pointer('pointermove', 10)
    await flushPromises()
    expect(document.querySelector('[data-testid="block-drop-line"]')).not.toBe(
      null,
    )
    pointer('pointerup', 10)
    await flushPromises()
    expect(markdownOf(g.editor)).toBe(
      [
        'Last paragraph of the page.',
        'First paragraph of the page.',
        '> [!NOTE]\n> A callout in the middle.',
      ].join('\n\n'),
    )
    // A drag is not a click: the menu did not open on the way out.
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('writes nothing when the + menu is opened and closed without a choice', async () => {
    const g = await gutterEditor()
    await g.hover(0)
    g.plus().click()
    await flushPromises()
    expect(g.menuItems()).toContain('Warning callout')
    expect(markdownOf(g.editor)).toBe(GUTTER_DOC)
    await g.key(document.querySelector('[role="menu"]')!, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()

    // And closing it by clicking somewhere else.
    g.plus().click()
    await flushPromises()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[role="menu"]')).toBeNull()

    expect(markdownOf(g.editor)).toBe(GUTTER_DOC)
    expect(g.view.emitted('update:modelValue')).toBeUndefined()
  })

  it('inserts the chosen block below, and only then', async () => {
    const g = await gutterEditor()
    await g.hover(0)
    g.plus().click()
    await flushPromises()
    g.menuItem('Warning callout')!.click()
    await flushPromises()
    const out = markdownOf(g.editor)
    expect(out).toBe(
      [
        'First paragraph of the page.',
        '> [!WARNING]\n> callout text',
        '> [!NOTE]\n> A callout in the middle.',
        'Last paragraph of the page.',
      ].join('\n\n'),
    )
    expect(reparsed(out)).toBe(out)
  })
})

// ---------------------------------------------------------------------------
// Block links
// ---------------------------------------------------------------------------

const LINK_DOC = [
  '# Release plan',
  '',
  'We ship the audio host on Friday, after the soak test passes.',
  '',
  '> [!WARNING] Licensing',
  '> The licensing service must be reachable, or activation stalls.',
  '',
  '- Run the tests before tagging.',
  '- Then run them again on staging.',
  '',
  'Closing words for the plan.',
].join('\n')

async function readerOf(source: string): Promise<HTMLElement> {
  const view = mount(MarkdownView, {
    props: { source },
    attachTo: document.body,
  })
  mounted.push(view)
  await flushPromises()
  return view.find('.md').element as HTMLElement
}

describe('block links', () => {
  it('encodes an anchor in a fragment that is not a heading slug', async () => {
    const { editor } = await mountEditor(LINK_DOC)
    const anchor = blockAnchor(
      editor.state.doc,
      editor.state.doc.child(0).nodeSize,
    )!
    const fragment = blockFragment(anchor)
    expect(fragment.startsWith('block=')).toBe(true)
    expect(fragment).toMatch(/^block=[A-Za-z0-9_-]+$/)
    expect(isBlockFragment(`#${fragment}`)).toBe(true)
    expect(isBlockFragment('#release-plan')).toBe(false)
    expect(parseBlockFragment(`#${fragment}`)).toEqual(anchor)
    expect(parseBlockFragment('#block=not-json')).toBeNull()
    expect(parseBlockFragment('#release-plan')).toBeNull()
    expect(
      blockLinkUrl(anchor, {
        origin: 'https://acta.test',
        pathname: '/w/docs/plan',
        search: '',
      } as Location),
    ).toBe(`https://acta.test/w/docs/plan#${fragment}`)
  })

  it('resolves to the right block in the reader, before and after edits around it', async () => {
    const { editor } = await mountEditor(LINK_DOC)
    const before = markdownOf(editor)
    const positions: number[] = []
    editor.state.doc.forEach((_node, offset) => positions.push(offset))
    const anchors = positions.map((pos) => blockAnchor(editor.state.doc, pos))
    // Making a link reads the document and writes nothing.
    expect(markdownOf(editor)).toBe(before)

    const expectedTags = ['H1', 'P', 'BLOCKQUOTE', 'UL', 'P']
    const root = await readerOf(LINK_DOC)
    anchors.forEach((anchor, i) => {
      const found = findLinkedBlock(
        root,
        parseBlockFragment(blockFragment(anchor!))!,
      )
      expect(found?.tagName, `block ${i}`).toBe(expectedTags[i])
    })

    // Edited around: a paragraph before, a heading renamed, the list grown.
    const edited = LINK_DOC.replace(
      '# Release plan',
      '# The release plan for June\n\nA new opening paragraph nobody had written.',
    ).replace(
      '- Then run them again on staging.',
      '- Then run them again on staging.\n- And once more in production.',
    )
    const after = await readerOf(edited)
    const callout = findLinkedBlock(after, anchors[2]!)
    expect(callout?.textContent).toContain(
      'licensing service must be reachable',
    )
    const list = findLinkedBlock(after, anchors[3]!)
    expect(list?.tagName).toBe('UL')
    const closing = findLinkedBlock(after, anchors[4]!)
    expect(closing?.textContent).toBe('Closing words for the plan.')
  })

  it('says the block is gone rather than landing somewhere else', async () => {
    const { editor } = await mountEditor(LINK_DOC)
    let pos = 0
    for (let i = 0; i < 4; i++) pos += editor.state.doc.child(i).nodeSize
    const anchor = blockAnchor(editor.state.doc, pos)!
    const root = await readerOf(
      LINK_DOC.replace(
        'Closing words for the plan.',
        'Something else entirely.',
      ),
    )
    expect(findLinkedBlock(root, anchor)).toBeNull()
  })

  it('offers no link for a block with no text to find it by', async () => {
    const { editor } = await mountEditor(PARTS.join('\n\n'))
    const kinds: Record<string, boolean> = {}
    editor.state.doc.forEach((node, offset) => {
      kinds[
        node.type.name === 'codeBlock'
          ? String(node.attrs.language)
          : node.type.name
      ] = blockAnchor(editor.state.doc, offset) !== null
    })
    expect(kinds).toEqual({
      paragraph: true,
      callout: true,
      details: true,
      table: true,
      image: false,
      mermaid: false,
      mathBlock: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Nothing that is not an edit may write
// ---------------------------------------------------------------------------

describe('round trip', () => {
  it('leaves the markdown byte-identical after hovering, the grip menu, the + menu and copying a link', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const g = await gutterEditor(DOC)
    const baseline = markdownOf(g.editor)
    expect(baseline).toBe(DOC)

    for (let i = 0; i < PARTS.length; i++) await g.hover(i)

    await g.hover(1)
    g.handle().click()
    await flushPromises()
    g.menuItem('Turn into')!.click()
    await flushPromises()
    await nextTick()
    g.menuItem('Back')!.click()
    await flushPromises()
    await nextTick()
    await g.key(document.querySelector('[role="menu"]')!, 'Escape')

    g.plus().click()
    await flushPromises()
    await g.key(document.querySelector('[role="menu"]')!, 'Escape')

    await g.hover(0)
    await g.key(g.handle(), 'Enter')
    g.menuItem('Copy link to block')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    const url = String((writeText.mock.calls[0] as unknown[])[0])
    expect(isBlockFragment(new URL(url).hash)).toBe(true)

    // A keyboard pick-up dropped where it started moves nothing.
    const handle = g.handle()
    handle.focus()
    await g.key(handle, ' ')
    await g.key(handle, ' ')

    expect(markdownOf(g.editor)).toBe(baseline)
    expect(g.view.emitted('update:modelValue')).toBeUndefined()
  })
})

/**
 * tiptap-markdown hands its one markdown-it instance to every extension's
 * parse setup on every parse, not once. A plugin that adds its rules
 * unconditionally therefore adds them again each time the editor reads
 * markdown: measured, 14 block rules became 737 after 240 parses. Ours have to
 * notice they are already there.
 */
import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { MarkdownIt } from 'markdown-it'
import { documentExtensions } from '@/lib/transfer/normalize'

const editors: Editor[] = []
afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

const DOC = ':::details Title\n\nbody\n\n:::\n\n$$\na^2\n$$\n\nInline $x$ here.'

it('adds the details and maths rules once, however many times it parses', () => {
  const editor = new Editor({
    element: document.createElement('div'),
    content: DOC,
    extensions: documentExtensions(),
  })
  editors.push(editor)
  const md = (
    editor.storage.markdown as unknown as { parser: { md: MarkdownIt } }
  ).parser.md
  const count = () => ({
    block: md.block.ruler.getRules('').length,
    inline: md.inline.ruler.getRules('').length,
  })
  const first = count()
  for (let i = 0; i < 5; i++) editor.commands.setContent(DOC)
  expect(count()).toEqual(first)
  // And the document still reads the same, so nothing a parse needs went.
  expect(editor.storage.markdown.getMarkdown()).toBe(DOC)
})

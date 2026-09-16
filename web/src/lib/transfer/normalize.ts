/**
 * Markdown in the exact form the editor writes it.
 *
 * Opening a page in the editor parses its markdown and every edit writes the
 * editor's own serialization back. An import that stored anything else would
 * be rewritten by the first person to touch the page, which reads in the
 * version history as an edit nobody made. So imported text goes through the
 * same parse and serialize before it is stored, and is stored only once it
 * has stopped changing.
 *
 * The schema is the editor's, node for node. What is left out only draws
 * (placeholder, table grips, colour swatches) or only reacts to typing
 * (the `[[`, `@` and `/` menus), and none of it has a say in the markdown.
 */
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TableRow from '@tiptap/extension-table-row'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import { Callout } from '@/components/editor/nodes/Callout'
import { Emphasis } from '@/components/editor/nodes/Emphasis'
import { Ref } from '@/components/editor/nodes/Ref'
import { Embed } from '@/components/editor/nodes/Embed'
import { Image } from '@/components/editor/nodes/Image'
import { Details } from '@/components/editor/nodes/Details'
import { Table, TableCell, TableHeader } from '@/components/editor/nodes/Table'
import { MathBlock, MathInline, MathText } from '@/components/editor/nodes/Math'
import { MermaidBlock } from '@/components/editor/nodes/MermaidBlock'
import { LinkCard } from '@/components/editor/nodes/LinkCard'

function serializeOnce(markdown: string): string {
  const editor = new Editor({
    content: markdown,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: false,
        text: false,
      }),
      MermaidBlock,
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Callout,
      ...Details,
      Emphasis,
      Ref,
      Embed,
      Image,
      MathText,
      MathBlock,
      MathInline,
      LinkCard,
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: true,
        transformPastedText: true,
      }),
    ],
  })
  try {
    return (
      editor.storage as { markdown: { getMarkdown: () => string } }
    ).markdown.getMarkdown()
  } finally {
    editor.destroy()
  }
}

/**
 * The editor's serialization of `markdown`, repeated until it stops changing.
 *
 * One pass is almost always enough. The loop is there because "almost" is
 * not a property to store somebody's document on: a construct the serializer
 * writes in a form it then reads slightly differently would otherwise be
 * rewritten on the first save after import.
 */
export function normalizeMarkdown(markdown: string): string {
  let current = serializeOnce(markdown)
  for (let pass = 0; pass < 3; pass++) {
    const next = serializeOnce(current)
    if (next === current) return current
    current = next
  }
  return current
}

/** One parse and serialize, for tests that assert stability. */
export { serializeOnce }

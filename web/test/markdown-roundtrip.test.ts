/**
 * Markdown round-trip fidelity.
 *
 * Documents are stored as markdown and edited as a rich document, so every
 * save runs the text through a parse and a serialize. Anything the pair does
 * not agree on is silent damage to somebody's file, and it is invisible in
 * the editor because the editor is showing its own model rather than the text.
 *
 * Measured before this suite existed: `> [!NOTE]` came back as
 * `> \[!NOTE\]\` on open-and-save with no edit, which put a stray line break
 * at the top of every callout in the workspace.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import { Callout } from '@/components/editor/nodes/Callout'
import { Emphasis } from '@/components/editor/nodes/Emphasis'

function roundtrip(md: string): string {
  const editor = new Editor({
    content: md,
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
      TaskList,
      TaskItem.configure({ nested: true }),
      Callout,
      Emphasis,
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: true,
        transformPastedText: true,
      }),
    ],
  })
  const out = (
    editor.storage as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown()
  editor.destroy()
  return out.trim()
}

describe('callouts survive a save', () => {
  it('writes the marker back as a marker, not as escaped prose', () => {
    const src = '> [!NOTE]\n> Body text here.'
    const out = roundtrip(src)
    // The exact shape that was breaking: escaped brackets and a trailing
    // backslash, which markdown reads as a hard break.
    expect(out).not.toContain('\\[')
    expect(out).not.toContain('\\]')
    expect(out).toContain('[!NOTE]')
    expect(out).toBe(src)
  })

  it('keeps every callout keyword it accepts', () => {
    for (const keyword of ['NOTE', 'TIP', 'WARNING', 'DANGER', 'INFO']) {
      const src = `> [!${keyword}]\n> Body.`
      expect(roundtrip(src), keyword).toBe(src)
    }
  })

  it('normalises the two aliases onto a keyword it can read back', () => {
    // IMPORTANT and CAUTION are accepted because people paste them from
    // READMEs. They have no style of their own, so they are written back as
    // the style they share. What must never happen is writing back a keyword
    // the parser would not recognise, which would silently demote the callout
    // to an ordinary quotation on the next read.
    expect(roundtrip('> [!IMPORTANT]\n> Body.')).toBe('> [!INFO]\n> Body.')
    expect(roundtrip('> [!CAUTION]\n> Body.')).toBe('> [!DANGER]\n> Body.')
    expect(roundtrip(roundtrip('> [!IMPORTANT]\n> Body.'))).toBe(
      '> [!INFO]\n> Body.',
    )
  })

  it('leaves an ordinary quotation alone', () => {
    const src = '> Just a quotation.\n>\n> With two paragraphs.'
    expect(roundtrip(src)).toContain('Just a quotation.')
    expect(roundtrip(src)).not.toContain('[!')
  })

  it('carries a title on the marker line', () => {
    const src = '> [!WARNING] Mind the gap\n> Body.'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps block content inside the callout', () => {
    const src = '> [!TIP]\n> A line.\n>\n> - one\n> - two'
    const out = roundtrip(src)
    expect(out).toContain('[!TIP]')
    expect(out).toContain('- one')
    expect(out).toContain('- two')
  })

  it('is idempotent, so saving twice changes nothing', () => {
    const src = '> [!NOTE]\n> Body text here.'
    const once = roundtrip(src)
    expect(roundtrip(once)).toBe(once)
  })
})

/**
 * The acceptance document, as a corpus.
 *
 * A real page is worth more than invented cases: it mixes a callout, headings
 * followed straight by bold text, inline code holding colours, a link with a
 * semicolon in it, and emphasis used as a subtitle. Every one of those is a
 * chance for the serializer to rewrite something nobody asked it to.
 */
describe('the Icon System page', () => {
  const source = readFileSync(
    resolve(__dirname, 'fixtures/icon-system.md'),
    'utf8',
  ).trim()

  it('keeps its callout intact', () => {
    const out = roundtrip(source)
    expect(out).toContain('> [!NOTE]')
    expect(out).not.toContain('\\[!NOTE\\]')
  })

  it('keeps every colour swatch exactly as written', () => {
    const colours = source.match(/`#[0-9a-f]{6}`/g) ?? []
    expect(colours.length).toBeGreaterThan(0)
    const out = roundtrip(source)
    for (const colour of colours) expect(out).toContain(colour)
  })

  it('keeps the link that contains a semicolon', () => {
    const out = roundtrip(source)
    expect(out).toContain(
      '[icon system artifact](https://claude.ai/artifact/D2T9CazKYEtsCgzDJ1jSof)',
    )
  })

  it('is stable: the second save is byte-identical to the first', () => {
    // The guarantee that actually matters. A model-based editor normalises on
    // the way in, so the first save of a hand-written file may reflow it, but
    // from then on an untouched document must produce an identical file.
    const once = roundtrip(source)
    expect(roundtrip(once)).toBe(once)
  })
})

/**
 * What normalisation is left, stated rather than discovered.
 *
 * A model-based editor cannot preserve every formatting choice, because the
 * document model is semantic: it knows there is a heading followed by a
 * paragraph, not how many blank lines the author left between them. So the
 * honest guarantee is not "byte-identical on first save", it is "semantically
 * lossless, and byte-identical from then on".
 *
 * This test exists to keep that list at one item. If it grows, somebody has
 * added a rewrite that will show up as noise in every document's history.
 */
describe('known normalisations', () => {
  it('adds the blank line after a heading that CommonMark allows to be omitted', () => {
    const src = '### Analytics\n**bars and trend**'
    expect(roundtrip(src)).toBe('### Analytics\n\n**bars and trend**')
  })

  it('has no others on the acceptance document', () => {
    const source = readFileSync(
      resolve(__dirname, 'fixtures/icon-system.md'),
      'utf8',
    ).trim()
    const out = roundtrip(source)

    // Compare ignoring blank lines: anything that differs beyond spacing is a
    // rewrite of somebody's content and is not acceptable.
    const strip = (t: string) =>
      t
        .split('\n')
        .filter((l) => l.trim() !== '')
        .join('\n')
    expect(strip(out)).toBe(strip(source))
  })
})

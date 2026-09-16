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
import TableRow from '@tiptap/extension-table-row'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import { Callout } from '@/components/editor/nodes/Callout'
import { Emphasis } from '@/components/editor/nodes/Emphasis'
import { Ref } from '@/components/editor/nodes/Ref'
import { Embed } from '@/components/editor/nodes/Embed'
import { Image } from '@/components/editor/nodes/Image'
import { Table, TableCell, TableHeader } from '@/components/editor/nodes/Table'
import { Details } from '@/components/editor/nodes/Details'
import { MathBlock, MathInline, MathText } from '@/components/editor/nodes/Math'
import { MermaidBlock } from '@/components/editor/nodes/MermaidBlock'

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
      Ref,
      Embed,
      Image,
      ...Details,
      MathText,
      MathBlock,
      MathInline,
      MermaidBlock,
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

/**
 * References.
 *
 * These were plain text in the editor, so the brackets were visible, the
 * caret could sit inside a card key, and a save re-serialized them as prose.
 * As a node they are one object, which is also what stops them being escaped.
 */
describe('references survive a save', () => {
  it('writes every target form back unchanged', () => {
    for (const src of [
      'See [[SU-12]] for detail.',
      'See [[doc:handbook]].',
      'See [[space:ENG]].',
      'Ask [[@jose]] about it.',
      'Read [[doc:handbook|the handbook]] first.',
      'Card [[SU-12|the login bug]] is open.',
    ]) {
      expect(roundtrip(src), src).toBe(src)
    }
  })

  it('keeps several references in one line apart', () => {
    const src = 'Both [[SU-1]] and [[SU-2]] block [[SU-3]].'
    expect(roundtrip(src)).toBe(src)
  })

  it('leaves brackets inside code alone', () => {
    // `[[x]]` in a code span is a literal somebody typed on purpose, most
    // obviously when documenting this very syntax.
    expect(roundtrip('Write `[[SU-12]]` to link a card.')).toBe(
      'Write `[[SU-12]]` to link a card.',
    )
    const fence = '```\n[[SU-12]]\n```'
    expect(roundtrip(fence)).toBe(fence)
  })

  it('leaves an embed alone, which is a different construct', () => {
    // `![[query:...]]` is an embed, not a reference. The leading `!` is the
    // whole difference, so the pattern has to refuse to match it.
    const src = '![[query:space=ENG state=open]]'
    expect(roundtrip(src)).toContain('![[query:space=ENG state=open]]')
  })

  it('keeps text either side of a reference', () => {
    const src = 'Before [[SU-12]] after.'
    expect(roundtrip(src)).toBe(src)
  })

  it('is idempotent', () => {
    const src = 'See [[SU-12]] and [[@jose]].'
    expect(roundtrip(roundtrip(src))).toBe(roundtrip(src))
  })
})

/**
 * Toggles (`:::details`).
 *
 * This block used to be the one enhanced construct with no node at all. It
 * survived a save only because nothing claimed it, which is a bad kind of
 * safety: the text came back because it was never understood, and the first
 * thing to touch it would have destroyed it exactly as the callout marker was
 * destroyed. It now has a node, and the assertion it was pinned by (the same
 * source, back byte-identical) is kept and tightened.
 */
describe('toggles survive a save', () => {
  it('round-trips a details block unchanged', () => {
    const src = ':::details How it works\n\nSome body text.\n\n:::'
    const out = roundtrip(src)
    expect(out).toContain(':::details How it works')
    expect(out).toContain('Some body text.')
    expect(out).toContain(':::')
    // Nothing escaped, which is what went wrong with callouts.
    expect(out).not.toContain('\\:')
    expect(out).toBe(src)
  })

  it('keeps a toggle with no title', () => {
    const src = ':::details\n\nBody.\n\n:::'
    expect(roundtrip(src)).toBe(src)
  })

  /**
   * The tight form is what the insert menu used to write and what anybody
   * typing one would produce. `breaks: true` turns it into a SINGLE paragraph
   * holding two hard breaks, measured, not assumed, so it has to be claimed
   * before inline parsing or it is not recoverable at all.
   */
  it('normalises the tight form and is then stable', () => {
    const once = roundtrip(':::details Title\ncontent\n:::')
    expect(once).toBe(':::details Title\n\ncontent\n\n:::')
    expect(roundtrip(once)).toBe(once)
  })

  it('keeps lists, a code block and a callout inside a toggle', () => {
    const src = [
      ':::details Everything at once',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '> [!TIP]',
      '> Nested advice.',
      '',
      ':::',
    ].join('\n')
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps a table inside a toggle', () => {
    const src = [
      ':::details Numbers',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| Spec | 2 |',
      '',
      ':::',
    ].join('\n')
    const out = roundtrip(src)
    expect(out).toContain('| Spec | 2 |')
    expect(roundtrip(out)).toBe(out)
  })

  it('nests', () => {
    const src = [
      ':::details Outer',
      '',
      'Before.',
      '',
      ':::details Inner',
      '',
      'Deep body.',
      '',
      ':::',
      '',
      ':::',
    ].join('\n')
    const out = roundtrip(src)
    expect(out).toBe(src)
    expect(roundtrip(out)).toBe(out)
  })

  it('leaves a lone closing fence as the text it is', () => {
    // An unterminated opener is not a toggle. It stays prose rather than
    // swallowing the rest of the document into a block nobody closed.
    const src = ':::details Unclosed\n\nBody.'
    const out = roundtrip(src)
    expect(out).toContain(':::details Unclosed')
    expect(out).not.toContain('\\:')
  })

  it('does not treat a fence inside a code block as the end of the toggle', () => {
    const src = [
      ':::details How to close one',
      '',
      '```md',
      ':::',
      '```',
      '',
      ':::',
    ].join('\n')
    expect(roundtrip(src)).toBe(src)
  })

  it('is idempotent, so saving twice changes nothing', () => {
    const src = ':::details How it works\n\nSome body text.\n\n:::'
    expect(roundtrip(roundtrip(src))).toBe(roundtrip(src))
  })
})

/**
 * The two callout tables are easy to confuse and have very different jobs.
 *
 * One maps a style to the keyword written back into markdown, the other maps
 * it to path data for the icon. Swapping them is not a visual glitch: the
 * serializer starts writing an SVG path where `NOTE` belongs, and every
 * callout in the workspace is destroyed on its next save. That happened once,
 * while replacing the icon, and only a round-trip test caught it.
 */
describe('callout tables are not interchangeable', () => {
  it('writes keywords, never artwork', async () => {
    const { CALLOUT_KEYWORD, CALLOUT_ICON_PATHS } =
      await import('@/lib/callouts')
    for (const [kind, keyword] of Object.entries(CALLOUT_KEYWORD)) {
      expect(keyword, kind).toMatch(/^[A-Z]+$/)
    }
    for (const [kind, d] of Object.entries(CALLOUT_ICON_PATHS)) {
      expect(d, kind).toMatch(/^M[\d.,-]/)
    }
  })

  it('has an icon for every keyword it can write', async () => {
    const { CALLOUT_KEYWORD, CALLOUT_ICON_PATHS } =
      await import('@/lib/callouts')
    for (const kind of Object.keys(CALLOUT_KEYWORD))
      expect(CALLOUT_ICON_PATHS[kind], kind).toBeTruthy()
  })
})

describe('images survive a save', () => {
  /*
   * Measured before the image node existed: this exact line came back empty.
   * StarterKit ships no image node, so `![...](...)` parsed to nothing and
   * serialized to nothing, and a document opened and saved with no edit lost
   * every picture in it. The Icon System page had fourteen.
   */
  it('keeps an attachment embed rather than deleting it', () => {
    const src = '![Stagewright icon](attachment:att_01m2n3gben9smtrepqbmrbax14)'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps the attachment id, not the URL it was displayed with', () => {
    const src = '![Icon](attachment:att_abc123)'
    // The served path is a display detail. Writing it into the document would
    // hard-code this instance's host into somebody's file.
    expect(roundtrip(src)).not.toContain('/api/v1/attachments/')
    expect(roundtrip(src)).toContain('attachment:att_abc123')
  })

  it('keeps an ordinary image URL', () => {
    const src = '![A picture](https://example.test/a.png)'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps an image sitting between prose', () => {
    const src =
      '### Stagewright\n\n![Stagewright icon](attachment:att_x)\n\n**the patch, as shipped**'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps an empty alt', () => {
    expect(roundtrip('![](attachment:att_x)')).toBe('![](attachment:att_x)')
  })

  it('is stable on a second save', () => {
    const src = '![Icon](attachment:att_x)'
    expect(roundtrip(roundtrip(src))).toBe(src)
  })
})

/**
 * The attribute block after an image: `![alt](src){align=center width=640}`.
 *
 * Alignment and width have to live in the markdown, because markdown is the
 * storage format and the reader renders from it. The risk this suite exists
 * for is the same one that deleted every image an hour ago, in a quieter
 * form: an attribute the pair does not agree on is a save that silently
 * rewrites somebody's file.
 */
describe('image attributes survive a save', () => {
  it('writes no braces at all when there are no attributes', () => {
    // The most likely regression here: an image with nothing on it picking
    // up an empty `{}` that every later read then has to parse around.
    const src = '![Icon](attachment:att_x)'
    const out = roundtrip(src)
    expect(out).not.toContain('{')
    expect(out).toBe(src)
  })

  it('keeps align on its own', () => {
    const src = '![Icon](attachment:att_x){align=center}'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps every alignment it accepts', () => {
    for (const align of ['left', 'center', 'right']) {
      const src = `![Icon](attachment:att_x){align=${align}}`
      expect(roundtrip(src), align).toBe(src)
    }
  })

  it('keeps width on its own', () => {
    const src = '![Icon](attachment:att_x){width=640}'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps align and width together', () => {
    const src = '![Stagewright icon](attachment:att_x){align=center width=640}'
    expect(roundtrip(src)).toBe(src)
  })

  it('preserves an attribute it does not know', () => {
    // Another tool may add one. Dropping it on save destroys data we were
    // only asked to store.
    const src = '![Icon](attachment:att_x){align=right caption="a b" loop}'
    expect(roundtrip(src)).toBe(src)
  })

  it('preserves an unknown value on a key it does know', () => {
    // `align=top` is not an alignment this renders, so it is carried
    // verbatim rather than silently corrected or dropped.
    const src = '![Icon](attachment:att_x){align=top}'
    expect(roundtrip(src)).toBe(src)
  })

  it('is stable on a second save', () => {
    const src = '![Icon](attachment:att_x){align=left width=320 theme=dark}'
    expect(roundtrip(src)).toBe(src)
    expect(roundtrip(roundtrip(src))).toBe(src)
  })

  it('normalises to a form it can read back, and then holds still', () => {
    // Order is fixed and quotes come off a value that never needed them.
    // What matters is that the second save is a no-op.
    const once = roundtrip(
      '![Icon](attachment:att_x){width="640" align=center}',
    )
    expect(once).toBe('![Icon](attachment:att_x){align=center width=640}')
    expect(roundtrip(once)).toBe(once)
  })

  it('drops an empty attribute block rather than carrying it forever', () => {
    expect(roundtrip('![Icon](attachment:att_x){}')).toBe(
      '![Icon](attachment:att_x)',
    )
  })

  it('leaves a brace block that is not attached to an image alone', () => {
    const src = 'Some prose {align=center} in the middle.'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps the attributes on an image sitting between prose', () => {
    const src =
      '### Stagewright\n\n![Stagewright icon](attachment:att_x){align=center width=640}\n\n**the patch, as shipped**'
    expect(roundtrip(src)).toBe(src)
  })
})

/**
 * GFM tables.
 *
 * The storage decision is portability: GFM tables only, cells holding inline
 * content only, so an Acta document stays readable and editable in GitHub,
 * Obsidian, VS Code and pandoc. That makes the serializer the whole feature.
 * Two faults were measured before it existed:
 *
 * - `| :--- | :---: | ---: |` came back as `| --- | --- | --- |`, so the one
 *   piece of table formatting markdown genuinely supports was destroyed by
 *   every save.
 * - a cell containing `x \| y` came back as `| x | y |`, which is not damage
 *   to a character, it is an extra column: the table silently widened and the
 *   header stopped matching the body.
 */
describe('GFM tables survive a save', () => {
  const header = '| Name | Value |\n| --- | --- |'

  it('keeps an alignment marker in all three positions', () => {
    const src = '| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps each alignment on its own, and leaves unset columns unset', () => {
    for (const marker of [':---', ':---:', '---:', '---']) {
      const src = `| a | b |\n| ${marker} | --- |\n| 1 | 2 |`
      expect(roundtrip(src), marker).toBe(src)
    }
  })

  it('is idempotent on an aligned table', () => {
    const src = '| a | b |\n| ---: | :---: |\n| 1 | 2 |'
    expect(roundtrip(roundtrip(src))).toBe(src)
  })

  it('keeps inline code and a link inside a cell', () => {
    const src = `${header}\n| \`npm run build\` | [the docs](https://example.test/a) |`
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps an empty cell as an empty cell', () => {
    const src = `${header}\n|  | filled |`
    expect(roundtrip(src)).toBe(src)
  })

  it('escapes a literal pipe rather than growing a column', () => {
    // The classic GFM trap. `\|` is one cell containing a pipe, and writing it
    // back unescaped turns it into two cells on the next read.
    const src = `${header}\n| a \\| b | c |`
    const out = roundtrip(src)
    expect(out).toBe(src)
    // Stated as a count as well, because the failure mode is arithmetic: the
    // row must still hold two cells, so three unescaped pipes.
    const row = out.split('\n')[2]
    expect(row.replace(/\\\|/g, '').match(/\|/g)?.length).toBe(3)
  })

  it('escapes a pipe inside a code span, which GFM also requires', () => {
    const src = `${header}\n| \`a \\| b\` | c |`
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps bold and italic in a cell', () => {
    const src = `${header}\n| **bold** | *italic* |`
    expect(roundtrip(src)).toBe(src)
  })
})

/**
 * Editing a table, measured on the file rather than on the model.
 *
 * The grips and the keyboard shortcuts both end at these commands, and the
 * controls are only worth having if what they write is still a table somebody
 * else's tool can read.
 */
function tableEditor(md: string): Editor {
  return new Editor({
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
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: true,
        transformPastedText: true,
      }),
    ],
  })
}

/** The position of the table node, and its two structural landmarks. */
function tablePos(editor: Editor): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false
    if (node.type.name === 'table') at = pos
    return at < 0
  })
  return at
}

/** Inside the first cell of the first body row, where a caret would sit. */
function firstBodyCell(editor: Editor): number {
  const at = tablePos(editor)
  const table = editor.state.doc.nodeAt(at)
  if (!table) return 0
  // Table start, past the header row, past the cell and paragraph openings,
  // then to the end of what is in the cell: the caret sits after the text, the
  // way it does when somebody clicks into a cell and keeps typing.
  const paragraph = table.child(1).child(0).child(0)
  return at + 1 + table.child(0).nodeSize + 3 + paragraph.content.size
}

/** The positions of the header row's cells, for a cell selection. */
function headerCells(editor: Editor): number[] {
  const at = tablePos(editor)
  const table = editor.state.doc.nodeAt(at)
  if (!table) return []
  const positions: number[] = []
  let offset = at + 2
  table.child(0).forEach((cell) => {
    positions.push(offset)
    offset += cell.nodeSize
  })
  return positions
}

/** Run `apply` on a table parsed from `md`, and give back the markdown. */
function edit(md: string, apply: (editor: Editor) => void): string {
  const editor = tableEditor(md)
  editor.commands.setTextSelection(firstBodyCell(editor))
  apply(editor)
  const out = (
    editor.storage as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown()
  editor.destroy()
  return out.trim()
}

describe('table editing writes valid GFM', () => {
  const src = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

  it('inserts a row before and after', () => {
    expect(edit(src, (e) => e.commands.addRowBefore())).toBe(
      '| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |\n| 3 | 4 |',
    )
    expect(edit(src, (e) => e.commands.addRowAfter())).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |',
    )
  })

  it('deletes a row', () => {
    expect(edit(src, (e) => e.commands.deleteRow())).toBe(
      '| a | b |\n| --- | --- |\n| 3 | 4 |',
    )
  })

  it('inserts a column before and after, delimiter row included', () => {
    expect(edit(src, (e) => e.commands.addColumnBefore())).toBe(
      '|  | a | b |\n| --- | --- | --- |\n|  | 1 | 2 |\n|  | 3 | 4 |',
    )
    expect(edit(src, (e) => e.commands.addColumnAfter())).toBe(
      '| a |  | b |\n| --- | --- | --- |\n| 1 |  | 2 |\n| 3 |  | 4 |',
    )
  })

  it('deletes a column', () => {
    expect(edit(src, (e) => e.commands.deleteColumn())).toBe(
      '| b |\n| --- |\n| 2 |\n| 4 |',
    )
  })

  it('writes alignment into the delimiter row, for the whole column', () => {
    expect(edit(src, (e) => e.commands.setColumnAlignment('center'))).toBe(
      '| a | b |\n| :---: | --- |\n| 1 | 2 |\n| 3 | 4 |',
    )
    expect(edit(src, (e) => e.commands.setColumnAlignment('right'))).toBe(
      '| a | b |\n| ---: | --- |\n| 1 | 2 |\n| 3 | 4 |',
    )
    expect(edit(src, (e) => e.commands.setColumnAlignment('left'))).toBe(
      '| a | b |\n| :--- | --- |\n| 1 | 2 |\n| 3 | 4 |',
    )
  })

  it('clears alignment back to the plain marker', () => {
    const aligned = '| a | b |\n| :---: | --- |\n| 1 | 2 |'
    expect(edit(aligned, (e) => e.commands.setColumnAlignment(null))).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    )
  })

  it('selects a whole row and a whole column from a grip index', () => {
    const editor = tableEditor(src)
    editor.commands.setTextSelection(firstBodyCell(editor))
    expect(editor.commands.selectTableRow({ index: 1 })).toBe(true)
    expect(editor.commands.selectTableColumn({ index: 1 })).toBe(true)
    // Out of range is declined rather than throwing, because a grip index can
    // outlive the row it named when two edits race.
    expect(editor.commands.selectTableRow({ index: 9 })).toBe(false)
    expect(editor.commands.selectTableColumn({ index: 9 })).toBe(false)
    editor.destroy()
  })

  it('reorders a row', () => {
    expect(
      edit(src, (e) => e.commands.moveTableRowTo({ from: 1, to: 2 })),
    ).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |\n| 1 | 2 |')
  })

  it('reorders a column, taking its alignment with it', () => {
    const aligned = '| a | b |\n| ---: | --- |\n| 1 | 2 |'
    expect(
      edit(aligned, (e) => e.commands.moveTableColumnTo({ from: 0, to: 1 })),
    ).toBe('| b | a |\n| --- | ---: |\n| 2 | 1 |')
  })
})

/**
 * Tables GFM cannot represent, flattened rather than escaped into HTML.
 *
 * `tiptap-markdown` writes an HTML `<table>` the moment a table has a merged
 * cell or a cell holding more than one block, and an HTML block in the file is
 * exactly what the storage decision rules out: it stops being a table in
 * GitHub, Obsidian or pandoc and becomes a blob. The editor can still reach
 * both states, so the serializer flattens, and these say what "sensibly"
 * means in each case.
 */
describe('a table GFM cannot represent is flattened, never written as HTML', () => {
  const src = '| a | b |\n| --- | --- |\n| 1 | 2 |'

  function merged(md: string): string {
    return edit(md, (editor) => {
      const cells = headerCells(editor)
      editor.commands.setCellSelection({
        anchorCell: cells[0],
        headCell: cells[1],
      })
      editor.commands.mergeCells()
    })
  }

  it('expands a merged cell into the columns it covered', () => {
    const out = merged(src)
    expect(out).not.toContain('<table')
    expect(out).toBe('| a b |  |\n| --- | --- |\n| 1 | 2 |')
  })

  it('flattens a list in a cell onto the one line GFM allows', () => {
    const out = edit(src, (editor) => {
      editor.commands.toggleBulletList()
      editor.commands.splitListItem('listItem')
      editor.commands.insertContent('two')
    })
    expect(out).not.toContain('<table')
    expect(out).not.toContain('\n- ')
    expect(out).toBe('| a | b |\n| --- | --- |\n| 1 two | 2 |')
  })

  it('flattens two paragraphs in a cell rather than ending the row', () => {
    const out = edit(src, (editor) => {
      editor.commands.splitBlock()
      editor.commands.insertContent('second')
    })
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toBe('| a | b |\n| --- | --- |\n| 1 second | 2 |')
  })

  it('what it writes is a table it can read back', () => {
    const once = merged(src)
    expect(roundtrip(once)).toBe(once)
  })
})

/**
 * Maths.
 *
 * The reader renders `$$ ... $$` and `$...$`. These exist because the reader
 * rendering a construct the editor's schema does not know is exactly how
 * tables and then images were deleted from documents here: parse produces
 * nothing, serialize writes nothing, and the formula is gone from the file
 * after an open and a save that changed nothing.
 */
describe('maths survives a save', () => {
  it('keeps a display block byte-identical', () => {
    const src = '$$\nE = mc^2\n$$'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps a multi-line block, backslashes and all', () => {
    const src =
      '$$\n\\begin{aligned}\na &= b + c \\\\\nd &= e\n\\end{aligned}\n$$'
    const out = roundtrip(src)
    // The failure that would be invisible on screen: doubling every escape,
    // so the second save writes `\\begin` and the formula stops parsing.
    expect(out).not.toContain('\\\\begin')
    expect(out).toBe(src)
  })

  it('keeps inline maths and the prose around it', () => {
    const src = 'The identity $e^{i\\pi} + 1 = 0$ is the pretty one.'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps a block sitting between prose', () => {
    const src = '## Energy\n\n$$\nE = mc^2\n$$\n\nAnd so on.'
    expect(roundtrip(src)).toBe(src)
  })

  it('is stable on a second save', () => {
    const src = 'Given $x$:\n\n$$\n\\int_0^1 x^2 dx\n$$'
    const once = roundtrip(src)
    expect(roundtrip(once)).toBe(once)
  })

  /*
   * The false positives. Each of these is ordinary prose that a loose
   * detector turns into a formula, which would both look wrong and rewrite
   * the author's line in the file.
   */
  it('leaves prices alone', () => {
    for (const src of [
      'It costs $5 and $10.',
      'Between $5-$10 depending on the day.',
      'They charge $100 and I charge $200.',
      'Refund of $5.',
    ]) {
      expect(roundtrip(src), src).toBe(src)
    }
  })

  it('leaves shell variables alone', () => {
    for (const src of [
      'Add it to $PATH first.',
      'Export $PATH and $HOME before running it.',
      'Use $1 for the first argument.',
    ]) {
      expect(roundtrip(src), src).toBe(src)
    }
  })

  it('leaves a dollar in code alone', () => {
    expect(roundtrip('Run `echo $PATH` to check.')).toBe(
      'Run `echo $PATH` to check.',
    )
    const fence = '```sh\nexport PATH=$PATH:/usr/local/bin\necho "$5"\n```'
    expect(roundtrip(fence)).toBe(fence)
  })

  it('leaves an escaped dollar alone', () => {
    const src = 'A literal \\$x\\$ pair.'
    expect(roundtrip(src)).toContain('\\$')
    expect(roundtrip(roundtrip(src))).toBe(roundtrip(src))
  })

  it('leaves an unclosed block as the prose it reads as', () => {
    // Swallowing the rest of a document because somebody typed two dollars
    // is a far worse failure than leaving the line alone.
    const out = roundtrip('$$\nE = mc^2\n\nStill writing.')
    expect(out).toContain('Still writing.')
  })
})

/**
 * Diagrams.
 *
 * A mermaid fence is a code block, and always was. These pin that down so the
 * node view added to draw it can never quietly become a node change.
 */
describe('mermaid diagrams survive a save', () => {
  it('keeps the fence and its language byte-identical', () => {
    const src = '```mermaid\ngraph TD;\n  A-->B;\n```'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps a diagram between prose', () => {
    const src =
      'Before.\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\nAfter.'
    expect(roundtrip(src)).toBe(src)
  })

  it('keeps an ordinary fence working as it always did', () => {
    const src = '```ts\nconst x = 1\n```'
    expect(roundtrip(src)).toBe(src)
  })

  it('is stable on a second save', () => {
    const src = '```mermaid\ngraph LR;\n  A-->B;\n```'
    expect(roundtrip(roundtrip(src))).toBe(src)
  })
})

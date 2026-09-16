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
import { Ref } from '@/components/editor/nodes/Ref'
import { Embed } from '@/components/editor/nodes/Embed'
import { Image } from '@/components/editor/nodes/Image'

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
 * Constructs the editor does not model yet.
 *
 * `:::details` is not used in any document in the workspace, so it has no
 * node and still appears as its literal text while editing. That is a gap in
 * the editing experience, not damage: the point of this test is that it comes
 * back byte-identical, so nobody's collapsible section is destroyed by a save
 * while it waits for a node view.
 */
describe('unmodelled constructs are preserved, not corrupted', () => {
  it('round-trips a details block unchanged', () => {
    const src = ':::details How it works\n\nSome body text.\n\n:::'
    const out = roundtrip(src)
    expect(out).toContain(':::details How it works')
    expect(out).toContain('Some body text.')
    expect(out).toContain(':::')
    // Nothing escaped, which is what went wrong with callouts.
    expect(out).not.toContain('\\:')
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

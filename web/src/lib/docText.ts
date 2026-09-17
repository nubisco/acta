/**
 * What a reader actually reads in a document, and how it is organised.
 *
 * Two questions the document chrome asks of the markdown: how long is this
 * (word count, character count, reading time) and what are its sections (the
 * table of contents). Both are presentation. Nothing here writes to the
 * markdown or keeps a copy of it.
 *
 * ## What the counts include, and what they leave out
 *
 * The text is taken from markdown-it's token stream, with the same `$$` maths
 * and `:::details` rules the reader renders with, rather than by stripping
 * characters out of the source with regular expressions. The parser already
 * knows that `**` is emphasis and that a `#` inside a fence is code, and a
 * second opinion here would disagree with it on exactly the documents where
 * the count matters.
 *
 * Counted: prose in paragraphs, headings, list items, quotes, callouts, table
 * cells and toggle titles. Link text is counted (the words a reader sees),
 * inline code is counted (it sits in a sentence and is read as part of it),
 * and a `[[ref]]` counts as its label.
 *
 * Excluded:
 * - Markdown syntax: heading `#`s, emphasis markers, list bullets and
 *   numbers, `>` quote markers, table pipes, link URLs, callout markers such
 *   as `[!NOTE]`, task boxes such as `[ ]`, `:::details` fences, and image
 *   attribute blocks such as `{align=center}`.
 * - Code blocks, fenced or indented, including Mermaid diagram source.
 * - Maths source, both `$$` blocks and inline `$...$`.
 * - Images, including their alt text, and `![[query:...]]` embeds.
 *
 * A word is a whitespace-separated run containing at least one letter or
 * digit, so a lone `-` or `|` is not a word. Chinese and Japanese are written
 * without spaces, so each Han, Hiragana or Katakana character counts as a word
 * of its own, which is how word processors count them.
 *
 * Characters are the counted text with runs of whitespace collapsed to one
 * space inside a block, counted as code points. The breaks between blocks are
 * not characters anybody reads, so they are not counted.
 *
 * Reading time uses 238 words a minute, the average silent reading rate for
 * non-fiction measured across 190 studies (Brysbaert, 2019), rounded up to
 * the next whole minute.
 */
import MarkdownIt, { type Token } from 'markdown-it'
import { sectionMap } from '@nubisco/acta-shared'
import { detailsPlugin } from '@/lib/details'
import { mathPlugin } from '@/lib/math'

/** Silent reading rate for non-fiction, words per minute (Brysbaert, 2019). */
export const WORDS_PER_MINUTE = 238

/**
 * Below either of these the table of contents is not shown.
 *
 * Three headings: with one or two, the outline is the title plus a line or
 * two, which the reader can already see without a panel to repeat it.
 *
 * 350 words or 60 source lines: a 52rem column at body size sets about 11
 * words a line and a laptop screen shows about 30 lines, so under roughly 350
 * words the whole page is on screen at once and there is nowhere to navigate
 * to. Code, maths and tables are not words but they do take room, which is
 * what the line count stands in for: a runbook of three headings and long
 * code blocks is worth an outline even with little prose.
 */
export const TOC_MIN_HEADINGS = 3
export const TOC_MIN_WORDS = 350
export const TOC_MIN_LINES = 60

export interface IDocStats {
  words: number
  characters: number
  /** Whole minutes, rounded up. Zero only for a document with no words. */
  readingMinutes: number
}

export interface IOutlineEntry {
  /** The same slug the reader puts on the heading and the API addresses. */
  slug: string
  /** The heading as a reader sees it, markdown syntax removed. */
  text: string
  /** The markdown level, 1 to 6. */
  level: number
  /**
   * Nesting depth in the outline, from 0. Relative, not the level: an h4
   * straight under an h2 is one step in, not two, so a skipped level does not
   * open an empty indent.
   */
  depth: number
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  .use(detailsPlugin)
  .use(mathPlugin)

const REF_RE = /(!?)\[\[([^\][<>]+)\]\]/g
const CALLOUT_RE = /^\[!(?:INFO|NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER)\]\s*/
const TASK_RE = /^\[[ xX]\]\s?/
const IMAGE_ATTRS_RE = /^\{[^{}]*\}/
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu
const WORDLIKE_RE = /[\p{L}\p{N}]/u

/** A `[[ref]]` reads as its label, and an embed reads as nothing. */
function readRefs(text: string): string {
  return text.replace(REF_RE, (_raw, bang: string, inner: string) => {
    if (bang === '!') return ' '
    const [target, alias] = inner.split('|').map((part) => part.trim())
    if (alias) return alias
    return target.replace(/^(doc:|space:|@)/, '')
  })
}

function inlineText(children: Token[] | null): string {
  if (!children) return ''
  let out = ''
  let afterImage = false
  for (const child of children) {
    switch (child.type) {
      case 'text': {
        // markdown-it leaves `{align=center}` as text after the picture.
        const content = afterImage
          ? child.content.replace(IMAGE_ATTRS_RE, '')
          : child.content
        out += content
        break
      }
      case 'code_inline':
        out += child.content
        break
      case 'softbreak':
      case 'hardbreak':
        out += ' '
        break
      // image (alt text included) and math_inline are not read.
      default:
        break
    }
    afterImage = child.type === 'image'
  }
  return out
}

/** Each block of readable text in the document, in order. */
export function readableBlocks(markdown: string): string[] {
  const blocks: string[] = []
  for (const token of md.parse(markdown, {})) {
    let text: string | null = null
    if (token.type === 'inline') text = inlineText(token.children)
    else if (token.type === 'details_summary') text = token.content
    // fence, code_block and math_block carry source nobody reads as prose.
    if (text === null) continue
    const cleaned = readRefs(text.replace(CALLOUT_RE, '').replace(TASK_RE, ''))
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned) blocks.push(cleaned)
  }
  return blocks
}

export function countWords(text: string): number {
  let words = 0
  for (const run of text.split(/\s+/)) {
    if (!run) continue
    const cjk = run.match(CJK_RE)?.length ?? 0
    words += cjk
    const rest = cjk ? run.replace(CJK_RE, '') : run
    if (WORDLIKE_RE.test(rest)) words += 1
  }
  return words
}

export function documentStats(markdown: string): IDocStats {
  let words = 0
  let characters = 0
  for (const block of readableBlocks(markdown)) {
    words += countWords(block)
    characters += Array.from(block).length
  }
  return {
    words,
    characters,
    readingMinutes: words === 0 ? 0 : Math.ceil(words / WORDS_PER_MINUTE),
  }
}

/** A heading's text without its inline markdown: `**Setup**` reads Setup. */
function plainHeading(raw: string): string {
  const tokens = md.parseInline(raw, {})
  const text = readRefs(inlineText(tokens[0]?.children ?? null))
    .replace(/\s+/g, ' ')
    .trim()
  return text || raw
}

/**
 * The document's headings, with the slugs `sectionMap` gives them.
 *
 * `sectionMap` is the one the reader anchors headings with and the one
 * `doc_write patch_section` addresses, so a table of contents built on it
 * links to the same `#slug` a copied heading link does.
 */
export function documentOutline(markdown: string): IOutlineEntry[] {
  const stack: number[] = []
  return sectionMap(markdown).map((section) => {
    while (stack.length > 0 && stack[stack.length - 1] >= section.level)
      stack.pop()
    const depth = stack.length
    stack.push(section.level)
    return {
      slug: section.slug,
      text: plainHeading(section.heading),
      level: section.level,
      depth,
    }
  })
}

/** Whether a table of contents earns its place. See the thresholds above. */
export function tocWorthShowing(
  outline: IOutlineEntry[],
  words: number,
  markdown: string,
): boolean {
  if (outline.length < TOC_MIN_HEADINGS) return false
  if (words >= TOC_MIN_WORDS) return true
  return markdown.split('\n').length >= TOC_MIN_LINES
}

/**
 * LaTeX in markdown: `$$ ... $$` as a block, `$...$` inline.
 *
 * One markdown-it plugin, used by both surfaces. The reader adds it to its own
 * MarkdownIt instance, and the editor hands it to tiptap-markdown through
 * `markdown.parse.setup`, so the two cannot disagree about what is a formula.
 * Two detectors would be two answers to the same question, and the one that is
 * wrong deletes somebody's text on the next save.
 *
 * ## The inline rule, and why it is this strict
 *
 * A lone `$` is ordinary prose. It is a price, it is `$PATH`, it is `$0` in a
 * shell script. Anything that treats "a dollar somewhere and another dollar
 * later" as a formula turns "costs $5 and $10" into maths, which is both wrong
 * on screen and a rewrite of the author's line in the file.
 *
 * So a run of text is inline maths only when ALL of these hold:
 *
 * 1. The opening `$` is not escaped (`\$` is a literal dollar).
 * 2. It is not `$$`, which is the block delimiter, never an inline one.
 * 3. The character straight after the opening `$` is not whitespace.
 * 4. There is a closing `$` on the SAME line, itself not escaped, and the
 *    character straight before it is not whitespace.
 * 5. The character straight after the closing `$` is not a digit.
 * 6. What sits between them is not empty or only whitespace.
 *
 * Rules 3 and 4 are Pandoc's, and between them they reject every price pair:
 * in `$5 and $10` the second `$` has a space in front of it, so it cannot
 * close, and there is no other `$` to try. Rule 5 catches the hyphenated form
 * `$5-$10`, where the `$` before `10` has a `-` in front of it and so passes
 * rule 4, but is followed by a digit.
 *
 * `$PATH` needs no rule at all: there is no second `$`, so nothing opens.
 *
 * Code needs no rule either, and that is structural rather than lucky. A
 * fenced block never reaches the inline parser, and a code span is consumed
 * whole by markdown-it's backtick rule before any inline rule looks inside it.
 * So `` `$5` `` and a fence full of `$PATH` are safe by construction.
 */
import type {
  MarkdownIt,
  RendererRule,
  StateBlock,
  StateInline,
} from 'markdown-it'

const DOLLAR = 0x24

/** The one place the rule above is written as code. */
function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char)
}

/**
 * Where the inline formula starting at `from` ends, or -1.
 *
 * Exported so the detection can be tested on its own, without a document
 * around it. `from` is the index of the opening `$`.
 */
export function inlineMathEnd(src: string, from: number, max: number): number {
  if (src.charCodeAt(from) !== DOLLAR) return -1
  if (src.charCodeAt(from + 1) === DOLLAR) return -1
  if (isSpace(src[from + 1])) return -1

  let i = from + 1
  while (i < max) {
    const char = src[i]
    // An escaped delimiter is a dollar the author wanted to keep, so it can
    // neither close the formula nor be read as the start of the next one.
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '\n') return -1
    if (char === '$') {
      const before = src[i - 1]
      const after = src[i + 1]
      if (
        !isSpace(before) &&
        !(after !== undefined && after >= '0' && after <= '9')
      )
        return i
    }
    i++
  }
  return -1
}

/** Every inline formula in a line, as `[start, end]` pairs. For tests. */
export function findInlineMath(src: string): [number, number][] {
  const found: [number, number][] = []
  let i = 0
  while (i < src.length) {
    if (src.charCodeAt(i) === DOLLAR) {
      const end = inlineMathEnd(src, i, src.length)
      if (end !== -1 && src.slice(i + 1, end).trim()) {
        found.push([i, end])
        i = end + 1
        continue
      }
    }
    i++
  }
  return found
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const end = inlineMathEnd(state.src, state.pos, state.posMax)
  if (end === -1) return false
  const latex = state.src.slice(state.pos + 1, end)
  if (!latex.trim()) return false
  if (!silent) {
    const token = state.push('math_inline', 'span', 0)
    token.markup = '$'
    token.content = latex
  }
  state.pos = end + 1
  return true
}

/**
 * `$$` on a line of its own, the body, then `$$`.
 *
 * `$$ x $$` on one line is accepted too, because people write it, and it is
 * written back as the three-line form. That is the one normalisation this
 * construct has, and it is recorded as such in the round-trip suite.
 *
 * An unclosed `$$` is NOT maths. Swallowing the rest of the document because
 * somebody typed two dollars is a far worse failure than leaving the line as
 * the prose it currently reads as.
 */
function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const begin = state.bMarks[startLine] + state.tShift[startLine]
  const firstMax = state.eMarks[startLine]
  if (begin + 2 > firstMax) return false
  if (state.src.slice(begin, begin + 2) !== '$$') return false

  const rest = state.src.slice(begin + 2, firstMax)
  // The one-line form, `$$ x $$`, closed on the line it opened.
  if (rest.trimEnd().endsWith('$$')) {
    const latex = rest.trimEnd().slice(0, -2).trim()
    if (!latex) return false
    if (!silent) emitBlock(state, startLine, startLine + 1, latex)
    state.line = startLine + 1
    return true
  }
  if (rest.trim()) return false

  let line = startLine + 1
  for (; line < endLine; line++) {
    const from = state.bMarks[line] + state.tShift[line]
    const to = state.eMarks[line]
    if (state.src.slice(from, to).trim() === '$$') break
  }
  if (line >= endLine) return false

  const body: string[] = []
  for (let i = startLine + 1; i < line; i++)
    body.push(
      state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]),
    )
  const latex = body.join('\n').trim()
  if (!latex) return false
  if (!silent) emitBlock(state, startLine, line + 1, latex)
  state.line = line + 1
  return true
}

function emitBlock(
  state: StateBlock,
  startLine: number,
  nextLine: number,
  latex: string,
): void {
  const token = state.push('math_block', 'div', 0)
  token.block = true
  token.markup = '$$'
  token.content = latex
  token.map = [startLine, nextLine]
}

/**
 * The element both surfaces agree on.
 *
 * The LaTeX travels in `data-math`, which is what the editor's node reads and
 * what the reader hands to KaTeX. It is ALSO the element's text, so a document
 * whose KaTeX never arrives shows the formula as the author typed it rather
 * than a gap where something used to be.
 */
export function mathHtml(
  escapeHtml: (text: string) => string,
  latex: string,
  display: boolean,
): string {
  const attr = escapeHtml(latex)
  const tag = display ? 'div' : 'span'
  const cls = display ? 'md__math' : 'md__math-inline'
  const flag = display ? 'data-math-block="1"' : 'data-math-inline="1"'
  return `<${tag} class="${cls}" ${flag} data-math="${attr}">${attr}</${tag}>`
}

/**
 * Puts the backslashes back on dollars that would otherwise become a formula.
 *
 * markdown-it unescapes `\$` while parsing, so by the time a dollar reaches
 * the document model it is an ordinary character and the serializer writes it
 * out bare. That was harmless while `$` meant nothing, and it stops being
 * harmless the moment `$...$` is maths: a literal the author escaped on
 * purpose would come back as prose and then be read as a formula on the next
 * open, which is the author's line rewritten by a save they did not make.
 *
 * Only the delimiters of something this file would read back as maths are
 * escaped. A price, a `$PATH`, a lone dollar: none of them match, so none of
 * them grow a backslash.
 *
 * Runs on text that is already markdown-escaped, which is safe because a
 * backslash there is a backslash here: the scan skips an escaped character
 * rather than reading it as a delimiter.
 */
export function guardMathDelimiters(text: string): string {
  const spans = findInlineMath(text)
  const blocks = /^\$\$/gm
  if (spans.length === 0 && !blocks.test(text)) return text
  const at = new Set<number>()
  for (const [start, end] of spans) {
    at.add(start)
    at.add(end)
  }
  // `$$` opening a line is the block delimiter, and it has to survive as text
  // for the same reason.
  for (const match of text.matchAll(/^\$\$/gm)) {
    at.add(match.index)
    at.add(match.index + 1)
  }
  let out = ''
  for (let i = 0; i < text.length; i++)
    out += at.has(i) ? `\\${text[i]}` : text[i]
  return out
}

/** Adds `$$ ... $$` and `$...$` to a markdown-it instance. */
export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', mathInline)
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  const inline: RendererRule = (tokens, idx) =>
    mathHtml(md.utils.escapeHtml, tokens[idx].content, false)
  const block: RendererRule = (tokens, idx) =>
    mathHtml(md.utils.escapeHtml, tokens[idx].content, true)
  md.renderer.rules.math_inline = inline
  md.renderer.rules.math_block = block
}

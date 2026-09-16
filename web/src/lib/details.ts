/**
 * Toggles (`:::details Title` ... `:::`), as one parser shared by the reader
 * and the editor.
 *
 * Both surfaces run markdown-it, so the block is claimed once, as a markdown-it
 * block rule, and both get the same HTML: `<details>` with a `<summary>` and a
 * body the ordinary block parser has already rendered. The reader shows that
 * HTML directly, and the editor hands it to ProseMirror, which builds the
 * matching nodes from it.
 *
 * It has to be a BLOCK rule rather than a pass over the rendered HTML, and the
 * reason is measured rather than assumed. Every surface here runs markdown-it
 * with `breaks: true`, so the tight form
 *
 *     :::details Title
 *     content
 *     :::
 *
 * renders as `<p>:::details Title<br>\ncontent<br>\n:::</p>`: one paragraph
 * holding two hard breaks, with the markers as inline prose. A rewrite of that
 * has to reassemble a block out of inline fragments, which is the same shape of
 * problem that made the callout marker so easy to get wrong. A block rule sees
 * the lines before the inline parser ever does, so the tight and the loose form
 * are the same thing to it.
 *
 * The house dialect is `:::name` fenced directives, which callouts and the
 * insert menu already speak, so the storage syntax is unchanged from what the
 * reader and the slash menu already wrote. Nothing in the workspace needs
 * migrating.
 */
import type { MarkdownIt, StateBlock } from 'markdown-it'

/** The opening line, with the optional title it carries. */
export const DETAILS_OPEN = /^:::details(?:\s+(.*))?$/

/** The closing line, which is the bare fence. */
export const DETAILS_CLOSE = ':::'

/** The fence that opens a code block, so a `:::` inside one is left alone. */
const CODE_FENCE = /^(```+|~~~+)/

/**
 * The title, as it is written on the opening line.
 *
 * Plain text, deliberately. A title is one line of a fence, and anything the
 * inline parser would claim there (emphasis, a link, a reference) would have to
 * survive being written back onto that line and read off it again. That is a
 * round-trip hazard for something nobody has asked for, so a title is text and
 * the body is where markdown goes.
 */
export function detailsTitle(line: string): string | null {
  const open = DETAILS_OPEN.exec(line.trim())
  return open ? (open[1] ?? '').trim() : null
}

/** The line that closes the block opened at `startLine`, or -1 if none does. */
function findClose(
  state: StateBlock,
  startLine: number,
  endLine: number,
): number {
  let depth = 1
  let fence: string | null = null
  for (let line = startLine + 1; line < endLine; line++) {
    const text = state.src
      .slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
      .trim()
    // Inside a code block the markers are the subject, not the syntax: a page
    // documenting this very feature contains a `:::` in a fence, and treating
    // it as the end of the toggle closed the block three lines early.
    if (fence !== null) {
      if (text.startsWith(fence)) fence = null
      continue
    }
    const opening = CODE_FENCE.exec(text)
    if (opening) {
      fence = opening[1].slice(0, 3)
      continue
    }
    if (DETAILS_OPEN.test(text)) {
      depth += 1
      continue
    }
    if (text === DETAILS_CLOSE) {
      depth -= 1
      if (depth === 0) return line
    }
  }
  return -1
}

/**
 * The markdown-it plugin. Applied to every instance that renders documents,
 * which is the reader's and the one tiptap-markdown parses with.
 */
export function detailsPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'fence',
    'details',
    (
      state: StateBlock,
      startLine: number,
      endLine: number,
      silent: boolean,
    ) => {
      // An indented line is code, not a fence.
      if (state.sCount[startLine] - state.blkIndent >= 4) return false

      const line = state.src.slice(
        state.bMarks[startLine] + state.tShift[startLine],
        state.eMarks[startLine],
      )
      const title = detailsTitle(line)
      if (title === null) return false
      if (silent) return true

      // An opener nobody closed is not a toggle. Returning false leaves it as
      // the paragraph it looks like, rather than swallowing the rest of the
      // document into a block that never ends.
      const closeLine = findClose(state, startLine, endLine)
      if (closeLine === -1) return false

      const oldParent = state.parentType
      const oldLineMax = state.lineMax
      state.parentType = 'details' as typeof state.parentType
      state.lineMax = closeLine

      const open = state.push('details_open', 'details', 1)
      open.markup = ':::details'
      open.info = title
      open.map = [startLine, closeLine]
      open.block = true

      const summary = state.push('details_summary', 'summary', 0)
      summary.content = title
      summary.block = true

      state.push('details_body_open', 'div', 1).block = true
      state.md.block.tokenize(state, startLine + 1, closeLine)
      state.push('details_body_close', 'div', -1).block = true

      state.push('details_close', 'details', -1).block = true

      state.parentType = oldParent
      state.lineMax = oldLineMax
      state.line = closeLine + 1
      return true
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  )

  md.renderer.rules.details_open = () => '<details class="md__details">'
  md.renderer.rules.details_summary = (tokens, idx: number) =>
    `<summary class="md__details-summary">${md.utils.escapeHtml(tokens[idx].content)}</summary>`
  md.renderer.rules.details_body_open = () =>
    '<div class="md__details-body" data-details-content>'
  md.renderer.rules.details_body_close = () => '</div>'
  md.renderer.rules.details_close = () => '</details>'
}

/**
 * Anchors in the browser: the shared anchoring rules, plus the two adapters
 * that turn a rendered surface into text and offsets back into that surface.
 *
 * The rules (what an anchor is, how it is found again after an edit, when it
 * is detached) live in @nubisco/acta-shared, so the server reports the same
 * status the page shows. This file only knows how to read text out of:
 *
 * - the reader, a DOM tree (`domTextIndex`), and
 * - the editor, a ProseMirror document (`docTextIndex`),
 *
 * and how to map a character offset in that text back to a DOM `Range` or a
 * ProseMirror position. Neither adapter writes anything: an anchor never
 * becomes part of the document.
 *
 * The same pair is what any other feature that needs to point at a place in a
 * document should use. Inline comments address a selection. A link to a block
 * addresses that block's text:
 *
 *     const index = domTextIndex(root)
 *     const { start, end } = index.offsetsOf(blockElement)
 *     const anchor = createAnchor(index.text, start, end)
 *     // ...later, after the document has changed:
 *     const range = resolveInDom(domTextIndex(root), anchor)
 */
import { createAnchor, resolveAnchor, type IAnchor } from '@nubisco/acta-shared'
import type { Node as PMNode } from '@tiptap/pm/model'

export {
  anchorFromQuote,
  createAnchor,
  resolveAnchor,
  type IAnchor,
  type TAnchorResolution,
  type TAnchorStatus,
} from '@nubisco/acta-shared'

/** Offsets into a surface's text, half-open. */
export interface ITextSpan {
  start: number
  end: number
}

// ---------------------------------------------------------------------------
// Reader: DOM
// ---------------------------------------------------------------------------

/**
 * Elements whose text is not the document's: controls the reader adds (copy
 * buttons, toggles), decorative glyphs, and anything marked hidden from
 * assistive technology, which is also hidden from what a person would quote.
 */
const SKIP = 'button, svg, style, script, [aria-hidden="true"], .katex-mathml'

/** Block-level tags. Text in different blocks is separated by a newline. */
const BLOCKS = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'PRE',
  'BLOCKQUOTE',
  'TD',
  'TH',
  'DIV',
  'DETAILS',
  'SUMMARY',
  'DT',
  'DD',
  'FIGCAPTION',
  'SECTION',
  'ARTICLE',
])

interface IDomSegment {
  node: Text
  start: number
}

export interface IDomTextIndex {
  root: HTMLElement
  /** What a person reading the page would quote, blocks on separate lines. */
  text: string
  /** The text offset of a DOM boundary point, as a selection reports one. */
  offsetAt(node: Node, offset: number): number
  /** The offsets a node's text occupies, or null when it has no text. */
  offsetsOf(node: Node): ITextSpan | null
  /** A DOM Range over some text, or null when the span has none. */
  rangeOf(start: number, end: number): Range | null
}

function blockOf(node: Node, root: HTMLElement): Element | null {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (BLOCKS.has(el.tagName)) return el
  }
  return null
}

export function domTextIndex(root: HTMLElement): IDomTextIndex {
  const segments: IDomSegment[] = []
  let text = ''
  let lastBlock: Element | null | undefined
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(SKIP)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  )
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).tagName === 'BR') text += '\n'
      continue
    }
    const value = node.nodeValue ?? ''
    if (!value) continue
    const block = blockOf(node, root)
    if (lastBlock !== undefined && block !== lastBlock && text) text += '\n'
    lastBlock = block
    segments.push({ node: node as Text, start: text.length })
    text += value
  }

  /** First segment at or after a node, in document order. */
  function segmentFrom(node: Node): IDomSegment | undefined {
    return segments.find(
      (s) =>
        s.node === node ||
        node.contains(s.node) ||
        !!(
          node.compareDocumentPosition(s.node) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    )
  }

  return {
    root,
    text,
    offsetAt(node, offset) {
      if (node.nodeType === Node.TEXT_NODE) {
        const hit = segments.find((s) => s.node === node)
        if (hit) return hit.start + offset
        return segmentFrom(node)?.start ?? text.length
      }
      const child = node.childNodes[offset]
      if (child) return segmentFrom(child)?.start ?? text.length
      // Past the last child: the end of this node's text.
      const inside = segments.filter((s) => node.contains(s.node)).pop()
      if (inside) return inside.start + (inside.node.nodeValue ?? '').length
      return segmentFrom(node)?.start ?? text.length
    },
    offsetsOf(node) {
      const inside = segments.filter(
        (s) => s.node === node || node.contains(s.node),
      )
      if (inside.length === 0) return null
      const last = inside[inside.length - 1]
      return {
        start: inside[0].start,
        end: last.start + (last.node.nodeValue ?? '').length,
      }
    },
    rangeOf(start, end) {
      if (end <= start) return null
      const first = segments.find(
        (s) => s.start + (s.node.nodeValue ?? '').length > start,
      )
      const last = [...segments].reverse().find((s) => s.start < end)
      if (!first || !last || last.start < first.start) return null
      const range = root.ownerDocument.createRange()
      range.setStart(first.node, Math.max(0, start - first.start))
      range.setEnd(
        last.node,
        Math.min((last.node.nodeValue ?? '').length, end - last.start),
      )
      return range
    },
  }
}

/** An anchor for what a DOM Range covers, or null for an empty one. */
export function anchorFromDomRange(
  index: IDomTextIndex,
  range: Range,
): IAnchor | null {
  const start = index.offsetAt(range.startContainer, range.startOffset)
  const end = index.offsetAt(range.endContainer, range.endOffset)
  try {
    return createAnchor(index.text, start, end)
  } catch {
    return null
  }
}

/** Where an anchor is in the reader now, or null when it is detached. */
export function resolveInDom(
  index: IDomTextIndex,
  anchor: IAnchor,
): Range | null {
  const found = resolveAnchor(index.text, anchor)
  if (found.status !== 'anchored') return null
  return index.rangeOf(found.start, found.end)
}

// ---------------------------------------------------------------------------
// Editor: ProseMirror
// ---------------------------------------------------------------------------

interface IDocSegment {
  pos: number
  start: number
  length: number
}

export interface IDocTextIndex {
  /** The document's text, textblocks on separate lines. */
  text: string
  /** The text offset of a document position. */
  offsetAt(pos: number): number
  /** The document position of a text offset. */
  posAt(offset: number): number
  /** A text span as document positions, for a decoration or a selection. */
  rangeOf(start: number, end: number): { from: number; to: number } | null
}

export function docTextIndex(doc: PMNode): IDocTextIndex {
  const segments: IDocSegment[] = []
  let text = ''
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (text) text += '\n'
      return true
    }
    if (node.isText) {
      segments.push({ pos, start: text.length, length: node.text!.length })
      text += node.text
      return false
    }
    if (node.type.name === 'hardBreak') text += '\n'
    return true
  })

  return {
    text,
    offsetAt(pos) {
      for (const s of segments) {
        if (pos <= s.pos) return s.start
        if (pos <= s.pos + s.length) return s.start + (pos - s.pos)
      }
      return text.length
    },
    posAt(offset) {
      for (const s of segments) {
        if (offset <= s.start + s.length)
          return s.pos + Math.max(0, offset - s.start)
      }
      const last = segments[segments.length - 1]
      return last ? last.pos + last.length : 0
    },
    rangeOf(start, end) {
      if (end <= start || segments.length === 0) return null
      // Start moves forward and end moves back, so a span that begins or ends
      // on a block separator still lands inside text.
      const first = segments.find((s) => s.start + s.length > start)
      const last = [...segments].reverse().find((s) => s.start < end)
      if (!first || !last) return null
      const from = first.pos + Math.max(0, start - first.start)
      const to = last.pos + Math.min(last.length, end - last.start)
      return to > from ? { from, to } : null
    },
  }
}

/** An anchor for a ProseMirror selection, or null for an empty one. */
export function anchorFromDocRange(
  index: IDocTextIndex,
  from: number,
  to: number,
): IAnchor | null {
  try {
    return createAnchor(index.text, index.offsetAt(from), index.offsetAt(to))
  } catch {
    return null
  }
}

/** Where an anchor is in the editor now, or null when it is detached. */
export function resolveInDoc(
  index: IDocTextIndex,
  anchor: IAnchor,
): { from: number; to: number } | null {
  const found = resolveAnchor(index.text, anchor)
  if (found.status !== 'anchored') return null
  return index.rangeOf(found.start, found.end)
}

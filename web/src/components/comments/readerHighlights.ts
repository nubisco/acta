import { domTextIndex, resolveInDom } from '@/lib/anchors'
import type { ICommentHighlight } from './commentHighlights'

/**
 * Inline comment highlights in the reader.
 *
 * Painted with the CSS Custom Highlight API rather than by wrapping the text
 * in elements. The reader's HTML is rebuilt from markdown and then hydrated
 * by several passes (refs, link cards, code, maths) that rewrite parts of it,
 * and a `<mark>` inserted among them would be erased by the next pass or,
 * worse, picked up as content. A registered highlight is not in the DOM at
 * all: it is the reader's equivalent of an editor decoration.
 *
 * Where the API is missing the comments are still listed, and simply not
 * painted on the page.
 */

export const HIGHLIGHT = 'acta-comment'
export const HIGHLIGHT_ACTIVE = 'acta-comment-active'

export interface IPaintedHighlight {
  id: string
  range: Range
}

interface IHighlightRegistry {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

function registry(): {
  highlights: IHighlightRegistry
  Highlight: new (...ranges: Range[]) => unknown
} | null {
  const css = (globalThis as { CSS?: { highlights?: IHighlightRegistry } }).CSS
  const Highlight = (
    globalThis as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight
  if (!css?.highlights || !Highlight) return null
  return { highlights: css.highlights, Highlight }
}

/**
 * Where each highlight is in the reader right now. Detached anchors are left
 * out, and so resolve to nothing on the page.
 */
export function locateHighlights(
  root: HTMLElement,
  highlights: ICommentHighlight[],
): IPaintedHighlight[] {
  if (highlights.length === 0) return []
  const index = domTextIndex(root)
  const out: IPaintedHighlight[] = []
  for (const { id, anchor } of highlights) {
    const range = resolveInDom(index, anchor)
    if (range) out.push({ id, range })
  }
  return out
}

/** Paint the located highlights, replacing whatever was painted before. */
export function paintHighlights(
  painted: IPaintedHighlight[],
  active: string | null,
): void {
  const api = registry()
  if (!api) return
  const idle = painted.filter((p) => p.id !== active).map((p) => p.range)
  const focused = painted.filter((p) => p.id === active).map((p) => p.range)
  api.highlights.set(HIGHLIGHT, new api.Highlight(...idle))
  api.highlights.set(HIGHLIGHT_ACTIVE, new api.Highlight(...focused))
}

export function clearHighlights(): void {
  const api = registry()
  if (!api) return
  api.highlights.delete(HIGHLIGHT)
  api.highlights.delete(HIGHLIGHT_ACTIVE)
}

/**
 * The comment under a point, if any.
 *
 * A registered highlight is not an element and receives no events, so a
 * click is matched against the rectangles each range covers. Later comments
 * win, so the one most recently added on overlapping text is the one opened.
 */
export function highlightAt(
  painted: IPaintedHighlight[],
  x: number,
  y: number,
): string | null {
  for (let i = painted.length - 1; i >= 0; i--) {
    const range = painted[i].range
    if (typeof range.getClientRects !== 'function') continue
    for (const rect of Array.from(range.getClientRects())) {
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      )
        return painted[i].id
    }
  }
  return null
}

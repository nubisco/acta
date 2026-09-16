/**
 * Anchors: addressing a stretch of a document's text without touching it.
 *
 * Modelled on the two W3C Web Annotation selectors that have survived real
 * editing in the wild (Hypothesis, Readium, the Annotator lineage):
 *
 * - a TextQuoteSelector, the exact text plus a little context either side,
 *   which is what actually finds the range again after the document changes,
 * - a TextPositionSelector, character offsets that are only ever a hint, used
 *   to pick between candidates and to narrow a fuzzy search.
 *
 * Flattened into one object because it is stored as one JSON column and typed
 * by agents over MCP, and a nested selector list is ceremony nobody benefits
 * from there.
 *
 * The anchor lives beside the document, never in it. A comment must not alter
 * the file it annotates, so nothing here reads or writes markdown syntax
 * except `anchorTextFromMarkdown`, which only projects it to plain text.
 *
 * Every function here works on plain text, which is what lets the reader (a
 * DOM), the editor (a ProseMirror document) and the server (markdown) share
 * one set of rules. Each surface projects itself to text and maps offsets
 * back. See web/src/lib/anchors.ts.
 */

/** How much context either side of the quote is recorded. */
export const ANCHOR_CONTEXT_LENGTH = 32

/** Longest quote accepted. A block is addressable, a whole document is not. */
export const ANCHOR_MAX_LENGTH = 5000

export interface IAnchor {
  /** TextQuoteSelector.exact: the anchored text as it was. */
  exact: string
  /** TextQuoteSelector.prefix: text immediately before, possibly empty. */
  prefix: string
  /** TextQuoteSelector.suffix: text immediately after, possibly empty. */
  suffix: string
  /** TextPositionSelector.start: a hint, never trusted on its own. */
  start: number
  /** TextPositionSelector.end: a hint, never trusted on its own. */
  end: number
}

export type TAnchorMethod = 'exact' | 'context' | 'fuzzy'

export type TAnchorResolution =
  | {
      status: 'anchored'
      start: number
      end: number
      /** How it was found, from most to least certain. */
      method: TAnchorMethod
      /** 0 to 1. Exact matches with matching context score highest. */
      score: number
    }
  | { status: 'detached' }

export type TAnchorStatus = 'anchored' | 'detached'

/** Quotes shorter than this are too common to trust without context. */
const SHORT_QUOTE = 20
/**
 * Context a short quote needs to keep its anchor. Measured: 32 characters of
 * unrelated English score 0.13 to 0.36 against each other, and context that
 * survived an insertion on one side averages above 0.5.
 */
const SHORT_QUOTE_MIN_CONTEXT = 0.5
/** Below this length a fuzzy match is noise. */
const FUZZY_MIN_LENGTH = 8
/** Fraction of the quote that may differ for a fuzzy match. */
const FUZZY_MAX_ERROR = 0.3
/** Longer quotes are matched by their ends, this many characters each. */
const FUZZY_PIECE = 64
/** Work budget for a fuzzy search over the whole text (text x quote). */
const FUZZY_WHOLE_TEXT_BUDGET = 4_000_000

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Whitespace collapsed to single spaces, with a map back to the original.
 *
 * The three surfaces disagree about whitespace and about nothing else that
 * matters: the reader has newlines between block elements, the editor joins
 * blocks with whatever separator it is given, and markdown has blank lines.
 * Matching on collapsed whitespace makes those differences invisible.
 *
 * `map[i]` is the original offset of normalised character `i`, and
 * `map[text.length]` is the original length, so a half-open range maps back
 * without a special case.
 */
export interface INormalized {
  text: string
  map: number[]
}

export function normalizeText(input: string): INormalized {
  let text = ''
  const map: number[] = []
  let inSpace = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (/\s/.test(ch)) {
      if (inSpace) continue
      inSpace = true
      text += ' '
      map.push(i)
      continue
    }
    inSpace = false
    text += ch
    map.push(i)
  }
  map.push(input.length)
  return { text, map }
}

/** The normalised index at or after an original offset. */
function toNormalized(norm: INormalized, offset: number): number {
  let lo = 0
  let hi = norm.map.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (norm.map[mid] < offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A normalised half-open range as original offsets. */
function toOriginal(
  norm: INormalized,
  start: number,
  end: number,
): { start: number; end: number } {
  return {
    start: norm.map[start],
    end: end > start ? norm.map[end - 1] + 1 : norm.map[start],
  }
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance, giving up once it exceeds `max`.
 *
 * Banded to `max` either side of the diagonal, so comparing two long strings
 * that are nearly the same costs O(n * max) rather than O(n * m).
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const band = Math.min(Math.max(a.length, b.length), max)
  const big = max + 1
  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j <= band ? j : big
  for (let i = 1; i <= a.length; i++) {
    const from = Math.max(1, i - band)
    const to = Math.min(b.length, i + band)
    cur.fill(big)
    cur[0] = i <= band ? i : big
    let rowMin = cur[0]
    for (let j = from; j <= to; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1)
      cur[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    ;[prev, cur] = [cur, prev]
  }
  return Math.min(prev[b.length], big)
}

/**
 * 1 for identical, 0 for nothing in common. Below `floor` the exact value
 * does not matter to any caller, so the distance stops being computed there.
 */
function similarity(actual: string, expected: string, floor = 0): number {
  const length = Math.max(actual.length, expected.length)
  if (length === 0) return 1
  const max = Math.ceil(length * (1 - floor))
  return Math.max(0, 1 - editDistance(actual, expected, max) / length)
}

/**
 * Best approximate occurrence of `pattern` ending anywhere in `text`
 * (Sellers' algorithm: edit distance with a free start). Returns the end
 * offset with the lowest distance, preferring the one closest to `near`.
 */
function approximateEnd(
  text: string,
  pattern: string,
  near: number,
): { end: number; distance: number } | null {
  const m = pattern.length
  let prev = new Array<number>(m + 1)
  let cur = new Array<number>(m + 1)
  for (let i = 0; i <= m; i++) prev[i] = i
  let best: { end: number; distance: number } | null = null
  for (let j = 1; j <= text.length; j++) {
    cur[0] = 0
    const ch = text[j - 1]
    for (let i = 1; i <= m; i++) {
      const cost = pattern[i - 1] === ch ? 0 : 1
      cur[i] = Math.min(prev[i - 1] + cost, prev[i] + 1, cur[i - 1] + 1)
    }
    const distance = cur[m]
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        Math.abs(j - near) < Math.abs(best.end - near))
    ) {
      best = { end: j, distance }
    }
    ;[prev, cur] = [cur, prev]
  }
  return best
}

/**
 * The closest approximate occurrence of `pattern` in `text`, near `hint`.
 *
 * Searched whole when that fits the work budget, and in a window around the
 * hint otherwise. The end is found first, then the same search run backwards
 * from that end finds where it starts.
 */
function approximateMatch(
  text: string,
  pattern: string,
  hint: number,
): { start: number; end: number; distance: number } | null {
  let windowStart = 0
  let windowEnd = text.length
  if (text.length * pattern.length > FUZZY_WHOLE_TEXT_BUDGET) {
    const reach = pattern.length * 4 + 2000
    windowStart = Math.max(0, hint - reach)
    windowEnd = Math.min(text.length, hint + pattern.length + reach)
  }
  const window = text.slice(windowStart, windowEnd)
  const tail = approximateEnd(
    window,
    pattern,
    hint - windowStart + pattern.length,
  )
  if (!tail) return null
  const maxErrors = Math.floor(pattern.length * FUZZY_MAX_ERROR)
  const from = Math.max(0, tail.end - pattern.length - maxErrors)
  const reversed = (value: string) => value.split('').reverse().join('')
  const head = approximateEnd(
    reversed(window.slice(from, tail.end)),
    reversed(pattern),
    pattern.length,
  )
  if (!head) return null
  let start = windowStart + tail.end - head.end
  let end = windowStart + tail.end
  while (start < end && text[start] === ' ') start++
  while (end > start && text[end - 1] === ' ') end--
  if (end === start) return null
  return { start, end, distance: tail.distance }
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * An anchor for `text.slice(start, end)`.
 *
 * Leading and trailing whitespace is trimmed off the range first, because a
 * selection dragged to the end of a line picks up the newline, and a quote
 * that ends in a newline stops matching the moment a paragraph is reflowed.
 */
export function createAnchor(
  text: string,
  start: number,
  end: number,
): IAnchor {
  let from = Math.max(0, Math.min(start, end))
  let to = Math.min(text.length, Math.max(start, end))
  while (from < to && /\s/.test(text[from])) from++
  while (to > from && /\s/.test(text[to - 1])) to--
  if (from === to) throw new RangeError('an anchor needs some text')
  if (to - from > ANCHOR_MAX_LENGTH)
    throw new RangeError(`an anchor is at most ${ANCHOR_MAX_LENGTH} characters`)
  return {
    exact: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - ANCHOR_CONTEXT_LENGTH), from),
    suffix: text.slice(to, to + ANCHOR_CONTEXT_LENGTH),
    start: from,
    end: to,
  }
}

export interface IQuote {
  exact: string
  prefix?: string
  suffix?: string
}

export type TQuoteLookup =
  | { ok: true; anchor: IAnchor }
  | { ok: false; reason: 'not_found' | 'ambiguous'; count: number }

/**
 * An anchor from a quote alone, the way an agent asks for one.
 *
 * Stricter than `resolveAnchor`, because this is the moment of creation and a
 * guess made now becomes the record. The quote must be present exactly
 * (whitespace aside), and if it appears more than once the prefix or suffix
 * must narrow it to one. Fuzzy matching is for text that changed after the
 * comment was made, not for a quote that was never there.
 */
export function anchorFromQuote(text: string, quote: IQuote): TQuoteLookup {
  const norm = normalizeText(text)
  const clean = (value: string | undefined) =>
    normalizeText(value ?? '').text.trim()
  let exact = clean(quote.exact)
  if (!exact) return { ok: false, reason: 'not_found', count: 0 }
  // A quote copied from the markdown rather than the page still carries its
  // `**` and backticks. Tried as typed first, then without the syntax.
  if (!norm.text.includes(exact)) exact = clean(stripInline(quote.exact))
  if (!exact) return { ok: false, reason: 'not_found', count: 0 }
  const prefix = clean(stripInline(quote.prefix ?? ''))
  const suffix = clean(stripInline(quote.suffix ?? ''))
  const narrowed = occurrences(norm.text, exact).filter(
    (at) =>
      (!prefix || norm.text.slice(0, at).trimEnd().endsWith(prefix)) &&
      (!suffix ||
        norm.text
          .slice(at + exact.length)
          .trimStart()
          .startsWith(suffix)),
  )
  if (narrowed.length === 0) return { ok: false, reason: 'not_found', count: 0 }
  if (narrowed.length > 1)
    return { ok: false, reason: 'ambiguous', count: narrowed.length }
  const range = toOriginal(norm, narrowed[0], narrowed[0] + exact.length)
  return { ok: true, anchor: createAnchor(text, range.start, range.end) }
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/** Every start offset of `needle` in `haystack`, capped. */
function occurrences(haystack: string, needle: string, cap = 1000): number[] {
  const found: number[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1 && found.length < cap) {
    found.push(at)
    at = haystack.indexOf(needle, at + 1)
  }
  return found
}

/**
 * How well the text around a candidate matches the recorded context.
 * Null when no context was recorded, which is neither a match nor a miss.
 */
function contextScore(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string,
): number | null {
  const scores: number[] = []
  if (prefix.trim()) {
    const before = text.slice(Math.max(0, start - prefix.length), start)
    scores.push(similarity(before.trim(), prefix.trim()))
  }
  if (suffix.trim()) {
    const after = text.slice(end, end + suffix.length)
    scores.push(similarity(after.trim(), suffix.trim()))
  }
  if (scores.length === 0) return null
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/**
 * Where `anchor` is in `text` now, or that it is not there any more.
 *
 * In order, stopping at the first that succeeds:
 *
 * 1. Exact. Every occurrence of the quote is scored by how well its
 *    surroundings match the recorded prefix and suffix, then by distance from
 *    the position hint. A repeated phrase lands on the right repeat. A short
 *    quote whose context no longer matches at all is refused rather than
 *    moved onto some other occurrence of the same common word.
 * 2. Context. The prefix and suffix are both still there with a short, similar
 *    stretch between them: the quote itself was edited in place.
 * 3. Fuzzy. The closest approximate occurrence of the quote, allowing
 *    `FUZZY_MAX_ERROR` of it to differ, searched near the position hint when
 *    the document is too large to search whole.
 *
 * Detached otherwise. Detached is a status, not a deletion: the caller keeps
 * the anchor, and it can match again if the text comes back.
 */
export function resolveAnchor(
  text: string,
  anchor: IAnchor,
): TAnchorResolution {
  const norm = normalizeText(text)
  const exact = normalizeText(anchor.exact).text.trim()
  if (!exact) return { status: 'detached' }
  const prefix = normalizeText(anchor.prefix).text
  const suffix = normalizeText(anchor.suffix).text
  const hint = Math.min(toNormalized(norm, anchor.start), norm.text.length)
  const found = (
    start: number,
    end: number,
    method: TAnchorMethod,
    score: number,
  ): TAnchorResolution => ({
    status: 'anchored',
    ...toOriginal(norm, start, end),
    method,
    score: Math.max(0, Math.min(1, score)),
  })

  // 1. Exact.
  const hits = occurrences(norm.text, exact)
  if (hits.length > 0) {
    let best: { at: number; context: number | null; rank: number } | null = null
    for (const at of hits) {
      const context = contextScore(
        norm.text,
        at,
        at + exact.length,
        prefix,
        suffix,
      )
      const proximity =
        1 - Math.min(1, Math.abs(at - hint) / Math.max(1, norm.text.length))
      const rank = (context ?? 0.5) * 0.8 + proximity * 0.2
      if (!best || rank > best.rank) best = { at, context, rank }
    }
    if (best) {
      const trusted =
        exact.length >= SHORT_QUOTE ||
        best.context === null ||
        best.context >= SHORT_QUOTE_MIN_CONTEXT
      if (trusted)
        return found(best.at, best.at + exact.length, 'exact', best.rank)
    }
  }

  // 2. Context: the words either side survived, the quote between them changed.
  if (prefix.trim().length >= 8 && suffix.trim().length >= 8) {
    const before = prefix.trim()
    const after = suffix.trim()
    for (const p of occurrences(norm.text, before, 50)) {
      const from = p + before.length
      const s = norm.text.indexOf(after, from)
      if (s === -1) continue
      if (s - from > exact.length * 2 + 16) continue
      let start = from
      let end = s
      while (start < end && norm.text[start] === ' ') start++
      while (end > start && norm.text[end - 1] === ' ') end--
      // Nothing left between them: the anchored text was deleted.
      if (start === end) continue
      const score = similarity(norm.text.slice(start, end), exact, 0.5)
      if (score >= 0.5) return found(start, end, 'context', score)
    }
  }

  // 3. Fuzzy.
  if (exact.length >= FUZZY_MIN_LENGTH) {
    const maxErrors = Math.floor(exact.length * FUZZY_MAX_ERROR)
    if (exact.length <= FUZZY_PIECE * 4) {
      const hit = approximateMatch(norm.text, exact, hint)
      if (hit && hit.distance <= maxErrors)
        return found(
          hit.start,
          hit.end,
          'fuzzy',
          1 - hit.distance / exact.length,
        )
    } else {
      // A long quote (a whole block) is too expensive to align in one go, so
      // its opening and closing words are found separately and the stretch
      // between them is compared with a distance bounded to the error budget.
      const head = approximateMatch(
        norm.text,
        exact.slice(0, FUZZY_PIECE),
        hint,
      )
      const tail = approximateMatch(
        norm.text,
        exact.slice(-FUZZY_PIECE),
        hint + exact.length - FUZZY_PIECE,
      )
      const pieceErrors = Math.floor(FUZZY_PIECE * FUZZY_MAX_ERROR)
      if (
        head &&
        tail &&
        head.distance <= pieceErrors &&
        tail.distance <= pieceErrors &&
        tail.end > head.start
      ) {
        const span = norm.text.slice(head.start, tail.end)
        const distance = editDistance(span, exact, maxErrors)
        if (distance <= maxErrors)
          return found(
            head.start,
            tail.end,
            'fuzzy',
            1 - distance / exact.length,
          )
      }
    }
  }

  return { status: 'detached' }
}

// ---------------------------------------------------------------------------
// Markdown as text
// ---------------------------------------------------------------------------

/**
 * A markdown document as the text a reader sees, for the server's side of
 * anchoring.
 *
 * The reader and the editor project their own rendered text. The server has
 * only the markdown, so it strips the syntax to get as close to that text as
 * a line-based pass can. It does not need to be exact: matching collapses
 * whitespace, positions are only hints, and the fuzzy pass absorbs the rest.
 * What it must do is keep the words and drop the punctuation that is syntax,
 * so a quote an agent copies from the rendered page is found.
 */
export function anchorTextFromMarkdown(markdown: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)
    if (fence) {
      if (fenceMark && fenceMark[1][0] === fence[0]) fence = null
      else out.push(raw)
      continue
    }
    if (fenceMark) {
      fence = fenceMark[1]
      continue
    }
    let line = raw
    // Math fences and details fences are markers, not text.
    if (/^\s*\$\$\s*$/.test(line) || /^\s*:::\s*$/.test(line)) continue
    line = line.replace(/^\s*:::\s*details\s*/, '')
    // Table delimiter rows are syntax, and cells become words.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue
    line = line
      .replace(/^(\s*>)+\s?/, '')
      .replace(/^\s*\[![A-Za-z]+\][+-]?\s*/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
    if (line.includes('|'))
      line = line.replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ' ')
    out.push(stripInline(line))
  }
  return out.join('\n')
}

/** Inline markdown syntax removed, the words kept. */
export function stripInline(line: string): string {
  return (
    line
      // Images draw no text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // Links keep their label.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Autolinks keep the address.
      .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
      // [[refs]] keep their target, which is the best guess at their label.
      .replace(/!?\[\[(?:[a-z]+:)?([^\]]+)\]\]/g, '$1')
      .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])([*_])(?=\S)([^*_]*?\S)\2(?!\w)/g, '$1$3')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!|$~>])/g, '$1')
  )
}

/**
 * The attribute block that follows an image: `![alt](src){align=center width=640}`.
 *
 * Markdown is the storage format, so anything an image needs to remember has
 * to survive as text. The grammar is deliberately small and strict, because
 * the parser and the serializer have to agree byte for byte: anything they
 * disagree on is a save that quietly rewrites somebody's file, which is the
 * quieter cousin of the bug that deleted every image in a document.
 *
 * ```
 * image     := "![" alt "](" src [ ' "' title '"' ] ")" [ attrblock ]
 * attrblock := "{" [ ws ] [ token { ws token } ] [ ws ] "}"
 * token     := key "=" value
 * key       := [A-Za-z_] [A-Za-z0-9_-]*
 * value     := '"' [^"]* '"' | [^ \t"}]+
 * ```
 *
 * The block binds to the image only when it sits immediately after the
 * closing parenthesis, with nothing between. A `{...}` anywhere else is
 * ordinary prose and is left exactly as written.
 *
 * Two keys are understood, `align` (left | center | right) and `width` (a
 * positive integer, in CSS pixels). **Everything else is carried through
 * verbatim**, in the order it was written, including a key we know with a
 * value we do not (`align=top`). A future attribute added by another tool is
 * not ours to delete, and a save that dropped it would be data loss in a file
 * we were only asked to store.
 */

/** Where the picture sits in the column. */
export type TImageAlign = 'left' | 'center' | 'right'

export interface IImageAttrs {
  align: TImageAlign | null
  /** CSS pixels, or null for the picture's own size. */
  width: number | null
  /** Tokens we do not understand, verbatim and in their original order. */
  extra: string
}

const ALIGNS = new Set<string>(['left', 'center', 'right'])

/**
 * Resize bounds, in CSS pixels.
 *
 * The floor is a picture still big enough to see and to grab a handle on. The
 * ceiling is a number no display exceeds, and it exists so a dropped pointer
 * or a bad number cannot write a width that makes the document unusable.
 */
export const IMAGE_MIN_WIDTH = 32
export const IMAGE_MAX_WIDTH = 4096

/** An attribute block at the very start of `text`, or null. */
export function matchImageAttrs(text: string): string | null {
  const match = /^\{([^{}]*)\}/.exec(text)
  return match ? match[0] : null
}

/**
 * Splits the inside of a block into tokens on whitespace, respecting quotes
 * so `caption="two words"` stays one token.
 */
function tokenise(body: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const char of body) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/** The value a token carries, with surrounding quotes removed. */
function unquote(raw: string): string {
  return raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1)
    : raw
}

/**
 * Reads a block. `body` may be the braces and their contents or just the
 * contents, so callers do not have to strip them first.
 *
 * Never throws and never rejects: anything unrecognised comes back in
 * `extra`, which is what keeps this lossless.
 */
export function parseImageAttrs(body: string): IImageAttrs {
  const inner = body.startsWith('{') ? (matchImageAttrs(body) ?? '{}') : body
  const text = inner.startsWith('{') ? inner.slice(1, -1) : inner

  let align: TImageAlign | null = null
  let width: number | null = null
  const extra: string[] = []

  for (const token of tokenise(text)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)=([\s\S]*)$/.exec(token)
    if (pair) {
      const key = pair[1]
      const value = unquote(pair[2])
      // First one wins. A repeated key is not something to merge, and the
      // duplicate is kept verbatim rather than thrown away.
      if (key === 'align' && align === null && ALIGNS.has(value)) {
        align = value as TImageAlign
        continue
      }
      if (key === 'width' && width === null && /^[1-9][0-9]*$/.test(value)) {
        width = Number(value)
        continue
      }
    }
    extra.push(token)
  }

  return { align, width, extra: extra.join(' ') }
}

/**
 * Writes a block, or an empty string when there is nothing to say.
 *
 * The empty string matters more than it looks: an image with no attributes
 * must serialize as a plain `![alt](src)` with no trailing `{}`, or every
 * save adds noise to a document nobody edited.
 */
export function formatImageAttrs(attrs: Partial<IImageAttrs>): string {
  const parts: string[] = []
  if (attrs.align && ALIGNS.has(attrs.align)) parts.push(`align=${attrs.align}`)
  if (typeof attrs.width === 'number' && attrs.width > 0)
    parts.push(`width=${Math.round(attrs.width)}`)
  const extra = (attrs.extra ?? '').trim()
  if (extra) parts.push(extra)
  return parts.length > 0 ? `{${parts.join(' ')}}` : ''
}

/**
 * The classes a picture carries, the same on both surfaces.
 *
 * The reader and the editor must draw an aligned image identically. Sharing
 * the class computation rather than writing it twice is what makes that true
 * by construction instead of by inspection.
 */
export function imageClass(align: TImageAlign | null | undefined): string {
  return align ? `md__img md__img--${align}` : 'md__img'
}

/** The inline style a width implies, or an empty string for a natural size. */
export function imageStyle(width: number | null | undefined): string {
  return typeof width === 'number' && width > 0
    ? `inline-size:${Math.round(width)}px`
    : ''
}

/** A width inside the bounds, rounded to a whole pixel. */
export function clampImageWidth(width: number, max?: number): number {
  const ceiling = Math.max(
    IMAGE_MIN_WIDTH,
    Math.min(IMAGE_MAX_WIDTH, max ?? IMAGE_MAX_WIDTH),
  )
  return Math.round(Math.min(ceiling, Math.max(IMAGE_MIN_WIDTH, width)))
}

/**
 * The width a drag has reached.
 *
 * Pure, so the arithmetic every resize depends on is testable without a
 * layout engine: jsdom reports every box as zero, and a drag tested through
 * the DOM would assert nothing.
 *
 * Only the width is ever stored. Height stays `auto`, which is what keeps the
 * aspect ratio exactly rather than approximately.
 */
export function resizedWidth(
  start: number,
  dx: number,
  edge: 'left' | 'right',
  max?: number,
): number {
  return clampImageWidth(edge === 'left' ? start - dx : start + dx, max)
}

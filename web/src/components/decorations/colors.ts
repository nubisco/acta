/**
 * Recognising a colour written as inline code.
 *
 * `#69bb63` in a document is a value somebody needs to see, not read. A chip
 * showing the actual colour turns a page of hex into something you can scan,
 * which is the whole point of the Icon System page.
 *
 * Deliberately strict. This runs on every code span in every document, and a
 * false positive puts a meaningless coloured dot next to something that was
 * never a colour. `#include` and `#1` must not match.
 */

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * `rgb()` / `rgba()` / `hsl()` / `hsla()`, in both the legacy comma form and
 * the modern space form.
 *
 * The components are matched as numbers with optional CSS units rather than
 * as "anything that could appear between the brackets". A looser pattern that
 * allowed letters, so that `deg` and `turn` would pass, also let `hsl(foo)`
 * through, which is not a colour and would have been painted as one.
 *
 * Values are not range-checked. A browser decides whether `rgb(300 0 0)`
 * means anything, and it clamps rather than failing.
 */
const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|grad|rad|turn|%)?`
const FUNCTIONAL = new RegExp(
  `^(?:rgb|hsl)a?\\(\\s*${NUMBER}(?:\\s*[, ]\\s*${NUMBER}){2}` +
    `(?:\\s*[,/]\\s*${NUMBER})?\\s*\\)$`,
  'i',
)

/**
 * Whether a code span holds a colour, and the value to paint with.
 *
 * Returns the trimmed source rather than a parsed colour, because the browser
 * parses CSS colours better than we can and the chip only needs to hand the
 * string to a style.
 */
export function parseColor(source: string): string | null {
  const value = source.trim()
  if (!value || value.length > 64) return null
  if (HEX.test(value)) return value
  if (FUNCTIONAL.test(value)) return value
  return null
}

/**
 * Whether a colour is dark, so a chip can pick a contrasting border.
 *
 * Only hex is measured. A functional colour would need a full CSS parser to
 * answer, and getting it wrong is invisible: the border falls back to the
 * ordinary one, which is legible on both.
 */
export function isDarkColor(value: string): boolean | null {
  const hex = value.trim()
  if (!HEX.test(hex)) return null
  let body = hex.slice(1)
  if (body.length === 3 || body.length === 4)
    body = body
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('')
  if (body.length === 8) body = body.slice(0, 6)
  if (body.length !== 6) return null
  const r = parseInt(body.slice(0, 2), 16)
  const g = parseInt(body.slice(2, 4), 16)
  const b = parseInt(body.slice(4, 6), 16)
  // Rec. 601 luma, which is the cheap standard answer and good enough to
  // decide whether a swatch needs a lighter outline.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

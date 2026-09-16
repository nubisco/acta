import {
  anchorFromQuote,
  anchorTextFromMarkdown,
  resolveAnchor,
  type IAnchor,
  type TAnchorInput,
  type TAnchorStatus,
} from '@nubisco/acta-shared'
import { ApiError } from '../core/ctx'

/**
 * The server's side of inline comment anchors.
 *
 * The rules live in shared/src/anchors.ts so the reader, the editor and this
 * file cannot disagree about them. What is here is only what the server alone
 * has to decide: whether a requested anchor is acceptable, and what status to
 * report for a stored one.
 */

/**
 * The anchor to store for a new comment.
 *
 * Two ways in, and they are held to different standards on purpose:
 *
 * - A quote alone (`exact`, optionally `prefix` and `suffix`) is how an agent
 *   asks. It must be in the document now, and unambiguous, because nothing
 *   else vouches for it. A typo would otherwise create a comment detached
 *   from the moment it was made.
 * - A full selector (with `start` and `end`) is what the app sends, having
 *   read the text it selected. It is stored as given even if the saved
 *   markdown does not contain it yet, because the app can comment on a draft
 *   that has not been saved, and refusing would lose the comment.
 */
export function anchorForComment(
  markdown: string,
  input: TAnchorInput,
): IAnchor {
  if (input.start !== undefined && input.end !== undefined) {
    return {
      exact: input.exact,
      prefix: input.prefix ?? '',
      suffix: input.suffix ?? '',
      start: input.start,
      end: input.end,
    }
  }
  const found = anchorFromQuote(anchorTextFromMarkdown(markdown), input)
  if (found.ok) return found.anchor
  if (found.reason === 'ambiguous')
    throw new ApiError(
      422,
      `quote appears ${found.count} times. Add a prefix or suffix to say which`,
    )
  throw new ApiError(422, 'quote not found in the document')
}

/** A stored anchor column, or null for a page comment or an unreadable one. */
export function parseAnchor(raw: string | null): IAnchor | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<IAnchor>
    if (typeof value.exact !== 'string' || !value.exact) return null
    return {
      exact: value.exact,
      prefix: typeof value.prefix === 'string' ? value.prefix : '',
      suffix: typeof value.suffix === 'string' ? value.suffix : '',
      start: typeof value.start === 'number' ? value.start : 0,
      end: typeof value.end === 'number' ? value.end : 0,
    }
  } catch {
    return null
  }
}

/**
 * Anchored or detached, against a body already projected to text.
 *
 * Projected once by the caller, because a document with many comments would
 * otherwise strip its markdown once per comment.
 */
export function anchorStatus(text: string, anchor: IAnchor): TAnchorStatus {
  return resolveAnchor(text, anchor).status
}

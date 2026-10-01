/**
 * Turning an activity summary into something you can click.
 *
 * Every line in the feed was plain text. "Daniela commented on ST-1" named a
 * card and gave you no way to open it, which makes the whole view a report
 * you read and then go hunting from.
 *
 * The summaries are generated server side and they name things in the open:
 * card keys inline, and the document slug inline. Some name two cards at
 * once ("ST-4 now waits on ST-9", "ST-9 is part of ST-4"), which is why this
 * splits the text rather than giving the row a single destination. One
 * target per row would be a worse answer than the sentence already gives.
 */

/** The validated card-key shape, the same one `zItemKey` accepts. */
const ITEM_KEY = /\b[A-Z][A-Z0-9]{1,4}-\d+\b/g

export type TActivitySegment =
  | { kind: 'text'; text: string }
  | { kind: 'item'; text: string }
  | { kind: 'doc'; text: string; slug: string }

/**
 * Split a summary into plain text and the things it names.
 *
 * `docSlug` comes from the server, which resolved it from the event's entity,
 * so this never has to guess whether a bare word is a document. Without one,
 * nothing is treated as a document: a slug is an ordinary word and guessing
 * would turn "replaced spec" into a link on any sentence containing "spec".
 */
export function activitySegments(
  summary: string,
  docSlug?: string,
): TActivitySegment[] {
  const out: TActivitySegment[] = []
  let rest = summary

  // The document first, because a slug can contain characters the key
  // pattern would otherwise walk straight past, and because there is at most
  // one of them: the event is about a single document.
  const at = docSlug ? summary.indexOf(docSlug) : -1
  if (docSlug && at !== -1) {
    pushKeys(out, summary.slice(0, at))
    out.push({ kind: 'doc', text: docSlug, slug: docSlug })
    rest = summary.slice(at + docSlug.length)
  }
  pushKeys(out, rest)
  return merge(out)
}

function pushKeys(out: TActivitySegment[], text: string): void {
  let last = 0
  ITEM_KEY.lastIndex = 0
  let match = ITEM_KEY.exec(text)
  while (match) {
    if (match.index > last)
      out.push({ kind: 'text', text: text.slice(last, match.index) })
    out.push({ kind: 'item', text: match[0] })
    last = match.index + match[0].length
    match = ITEM_KEY.exec(text)
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
}

/**
 * Join neighbouring text runs, so the template renders one span where the
 * splitting produced two. Cosmetic, and it keeps the tests readable.
 */
function merge(segments: TActivitySegment[]): TActivitySegment[] {
  const out: TActivitySegment[] = []
  for (const segment of segments) {
    const previous = out[out.length - 1]
    if (segment.kind === 'text' && previous?.kind === 'text') {
      previous.text += segment.text
      continue
    }
    if (segment.kind === 'text' && segment.text === '') continue
    out.push({ ...segment })
  }
  return out
}

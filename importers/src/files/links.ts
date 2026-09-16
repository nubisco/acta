/**
 * Finding and rewriting link and image targets in markdown.
 *
 * Export and import are the same operation facing opposite ways: export turns
 * `attachment:<id>` into a path beside the file, import turns a path beside
 * the file back into `attachment:<id>`. Both need to touch the targets and
 * nothing else, so this is one scanner used both ways.
 *
 * What it will not look inside is the point of it. A fenced code block, a
 * `$$` formula and an inline code span can all contain text shaped like a
 * link, and rewriting a sample inside a page about markdown would be damage to
 * the page. So those are skipped, and so is the inside of a `[[reference]]`.
 */

export interface ILinkMatch {
  /** `![...](...)` rather than `[...](...)`. */
  image: boolean
  /** The bracketed text, as written. */
  text: string
  /** The target with any angle brackets and backslash escapes removed. */
  target: string
  /** The quoted title after the target, including its quotes, or ''. */
  title: string
  /** An `{align=... width=...}` block straight after an image, or ''. */
  attrs: string
  /** The whole match, as written. */
  raw: string
}

/** Returns the replacement text, or null to leave the match as written. */
export type TLinkRewrite = (match: ILinkMatch) => string | null

const FENCE = /^(\s{0,3}(?:>\s?)*)\s{0,3}(`{3,}|~{3,})/

const LINK =
  /(!?)\[((?:[^[\]\\\n]|\\.)*)\]\(\s*(<[^<>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)(\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\s*\)(\{[^{}\n]*\})?/g

const DEFINITION = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^<>\n]*>|\S+)(.*)$/

/** A target as it is meant, without the escaping markdown needed for it. */
export function unwrapTarget(written: string): string {
  const inner =
    written.startsWith('<') && written.endsWith('>')
      ? written.slice(1, -1)
      : written
  return inner.replace(/\\([()<>\\[\] ])/g, '$1')
}

/** A target written so markdown reads it back as exactly this string. */
export function wrapTarget(target: string): string {
  if (/[\s<>]/.test(target))
    return `<${target.replace(/[<>]/g, (ch) => encodeURIComponent(ch))}>`
  return target.replace(/[()]/g, '\\$&')
}

/** Code spans on one line, as [start, end) ranges, so links inside are skipped. */
function codeSpans(line: string): [number, number][] {
  const spans: [number, number][] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] !== '`') {
      i++
      continue
    }
    let run = 0
    while (line[i + run] === '`') run++
    const fence = '`'.repeat(run)
    let close = line.indexOf(fence, i + run)
    while (close !== -1 && line[close + run] === '`')
      close = line.indexOf(fence, close + run + 1)
    if (close === -1) {
      i += run
      continue
    }
    spans.push([i, close + run])
    i = close + run
  }
  // `[[...]]` references are Acta syntax, never a link target.
  for (const match of line.matchAll(/!?\[\[[^\]\n]*\]\]/g))
    spans.push([match.index, match.index + match[0].length])
  return spans
}

function rewriteLine(line: string, rewrite: TLinkRewrite): string {
  const definition = DEFINITION.exec(line)
  if (definition) {
    const target = unwrapTarget(definition[2])
    const replaced = rewrite({
      image: false,
      text: '',
      target,
      title: definition[3].trim(),
      attrs: '',
      raw: line,
    })
    return replaced ?? line
  }
  const skip = codeSpans(line)
  return line.replace(
    LINK,
    (
      raw: string,
      bang: string,
      text: string,
      target: string,
      title: string | undefined,
      attrs: string | undefined,
      offset: number,
    ) => {
      if (skip.some(([from, to]) => offset < to && offset + raw.length > from))
        return raw
      const replaced = rewrite({
        image: bang === '!',
        text,
        target: unwrapTarget(target),
        title: title?.trim() ?? '',
        attrs: bang === '!' ? (attrs ?? '') : '',
        raw:
          bang === '!' ? raw : raw.slice(0, raw.length - (attrs ?? '').length),
      })
      if (replaced === null) return raw
      // A block after a plain link is prose, and was not part of the match.
      return bang === '!' ? replaced : `${replaced}${attrs ?? ''}`
    },
  )
}

/**
 * Every link and image target outside code, rewritten by `rewrite`.
 *
 * Returning null from the callback leaves that occurrence byte for byte as it
 * was, which is what keeps a document nobody needed to change unchanged.
 */
export function rewriteLinks(markdown: string, rewrite: TLinkRewrite): string {
  const lines = markdown.split('\n')
  let fence: string | null = null
  let maths = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const opening = FENCE.exec(line)
    if (fence !== null) {
      if (
        opening &&
        opening[2][0] === fence[0] &&
        opening[2].length >= fence.length
      )
        fence = null
      continue
    }
    if (opening) {
      fence = opening[2]
      continue
    }
    const bare = line.replace(/^(\s*>\s?)*/, '').trim()
    if (maths) {
      if (bare === '$$') maths = false
      continue
    }
    if (bare === '$$') {
      maths = true
      continue
    }
    lines[index] = rewriteLine(line, rewrite)
  }
  return lines.join('\n')
}

/** Every link and image target outside code, without changing anything. */
export function findLinks(markdown: string): ILinkMatch[] {
  const found: ILinkMatch[] = []
  rewriteLinks(markdown, (match) => {
    found.push(match)
    return null
  })
  return found
}

/** The id in an `attachment:<id>` target, or null. */
export function attachmentIdOf(target: string): string | null {
  const match = /^attachment:([A-Za-z0-9_-]+)$/.exec(target.trim())
  return match ? match[1] : null
}

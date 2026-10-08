/**
 * Card keys written as plain text, found so they can be opened.
 *
 * A [[KEY]] ref was always a link, but people (and agents) mostly write a
 * key as it is: "moved here from CM-23". Asked for by Jose on 2026-10-08:
 * wherever the inspector mentions a card, it should open it. Only keys of
 * spaces that exist count, so "UTF-8" or "ISO-9001" stay words.
 */
import type { MarkdownIt, StateCore } from 'markdown-it'

export type TKeyPart = { text: string } | { key: string }

const KEY = /(^|[^\w/-])([A-Z][A-Z0-9]{1,4})-(\d+)(?![\w-])/g

/** Text cut into runs of words and the card keys between them. */
export function splitCardKeys(
  text: string,
  spaces: ReadonlySet<string>,
): TKeyPart[] {
  // A [[ref]] is already a link, drawn later by its own pass.
  const refs = [...text.matchAll(/\[\[[^\]]*\]\]/g)].map((m) => [
    m.index,
    m.index + m[0].length,
  ])
  const out: TKeyPart[] = []
  let last = 0
  for (const match of text.matchAll(KEY)) {
    if (!spaces.has(match[2])) continue
    const start = match.index + match[1].length
    if (refs.some(([from, to]) => start >= from && start < to)) continue
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ key: `${match[2]}-${match[3]}` })
    last = start + match[2].length + 1 + match[3].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The markdown side: bare keys in prose become buttons that open the card.
 * Done on text tokens, so a key inside code, a link's text or a URL is left
 * as written, which a pass over the rendered HTML could not promise.
 */
export function cardKeysPlugin(
  md: MarkdownIt,
  spaces: () => ReadonlySet<string>,
): void {
  md.core.ruler.push('card_keys', (state: StateCore) => {
    const known = spaces()
    if (known.size === 0) return
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      const children = []
      let inLink = 0
      for (const token of block.children) {
        if (token.type === 'link_open') inLink += 1
        if (token.type === 'link_close') inLink -= 1
        if (token.type !== 'text' || inLink > 0) {
          children.push(token)
          continue
        }
        const parts = splitCardKeys(token.content, known)
        if (parts.length === 1 && 'text' in parts[0]) {
          children.push(token)
          continue
        }
        for (const part of parts) {
          if ('text' in part) {
            const text = new state.Token('text', '', 0)
            text.content = part.text
            children.push(text)
          } else {
            const button = new state.Token('html_inline', '', 0)
            button.content = `<button type="button" class="md__ref md__ref--bare" data-ref-type="item" data-ref="${escapeHtml(part.key)}">${escapeHtml(part.key)}</button>`
            children.push(button)
          }
        }
      }
      block.children = children
    }
  })
}

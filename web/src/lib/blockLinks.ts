/**
 * Links to a block: a URL fragment that finds one block of a document again,
 * after the document has been edited around it.
 *
 * Built on the same anchors inline comments use (lib/anchors.ts), not a second
 * addressing scheme. A block is addressed by its opening words plus a little
 * context either side, and found again by `resolveAnchor`, which already
 * survives insertions, deletions and small edits to the quote itself.
 *
 * Nothing is written into the document. There is no id in the markdown, no
 * hidden attribute, no comment: the link carries everything it needs in the
 * fragment, which is why it can be copied from a document nobody is allowed
 * to edit, and why following one can never dirty the page.
 *
 * The fragment is `#block=<base64url JSON>`. Heading links are `#<slug>`, and
 * a slug is only ever `[a-z0-9~-]`, so the two cannot be mistaken for each
 * other.
 */
import type { Node as PMNode } from '@tiptap/pm/model'
import {
  createAnchor,
  docTextIndex,
  domTextIndex,
  resolveAnchor,
  type IAnchor,
} from '@/lib/anchors'

export const BLOCK_FRAGMENT_PREFIX = 'block='

/**
 * How much of a block the link quotes. The opening words are enough to find a
 * block, and a whole block would make a URL nobody can paste into a chat.
 */
export const BLOCK_LINK_QUOTE = 96
/** Context either side, shorter than a comment's for the same reason. */
export const BLOCK_LINK_CONTEXT = 24

/**
 * Blocks whose text on the page is not the text in the editor, so an anchor
 * made in one would not be found in the other: a diagram is source in the
 * editor and a picture in the reader, and the rest have no text at all.
 */
function linkable(node: PMNode): boolean {
  if (node.type.name === 'codeBlock' && node.attrs.language === 'mermaid')
    return false
  return !['image', 'mathBlock', 'linkCard', 'horizontalRule'].includes(
    node.type.name,
  )
}

/**
 * An anchor for the top-level block that starts at `pos`, or null when the
 * block has no words a link could find it by.
 */
export function blockAnchor(doc: PMNode, pos: number): IAnchor | null {
  const node = doc.nodeAt(pos)
  if (!node || !linkable(node)) return null
  const index = docTextIndex(doc)
  const start = index.offsetAt(pos)
  const end = index.offsetAt(pos + node.nodeSize)
  const text = index.text
  // Leading whitespace would be trimmed off the quote anyway, and counting it
  // against the budget would shorten the quote for nothing.
  let from = start
  while (from < end && /\s/.test(text[from])) from++
  if (from >= end) return null
  try {
    const anchor = createAnchor(
      text,
      from,
      Math.min(end, from + BLOCK_LINK_QUOTE),
    )
    return {
      ...anchor,
      prefix: anchor.prefix.slice(-BLOCK_LINK_CONTEXT),
      suffix: anchor.suffix.slice(0, BLOCK_LINK_CONTEXT),
    }
  } catch {
    return null
  }
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * The fragment for an anchor, without the `#`.
 *
 * A positional array rather than the anchor object, so the keys are not
 * repeated in every URL. `end` is not stored: it is `start` plus the quote.
 */
export function blockFragment(anchor: IAnchor): string {
  const packed = [1, anchor.exact, anchor.prefix, anchor.suffix, anchor.start]
  return `${BLOCK_FRAGMENT_PREFIX}${toBase64Url(JSON.stringify(packed))}`
}

/** Whether a fragment (with or without `#`) is a block link at all. */
export function isBlockFragment(fragment: string): boolean {
  return fragment.replace(/^#/, '').startsWith(BLOCK_FRAGMENT_PREFIX)
}

/**
 * The anchor a fragment carries, or null when it is not a block link or is
 * one that has been damaged (truncated when pasted, or edited by hand).
 */
export function parseBlockFragment(fragment: string): IAnchor | null {
  const raw = fragment.replace(/^#/, '')
  if (!raw.startsWith(BLOCK_FRAGMENT_PREFIX)) return null
  try {
    const packed: unknown = JSON.parse(
      fromBase64Url(raw.slice(BLOCK_FRAGMENT_PREFIX.length)),
    )
    if (!Array.isArray(packed) || packed[0] !== 1) return null
    const [, exact, prefix, suffix, start] = packed
    if (
      typeof exact !== 'string' ||
      !exact.trim() ||
      typeof prefix !== 'string' ||
      typeof suffix !== 'string' ||
      typeof start !== 'number' ||
      !Number.isFinite(start)
    )
      return null
    return { exact, prefix, suffix, start, end: start + exact.length }
  } catch {
    return null
  }
}

/** The whole URL for a block link on the page currently open. */
export function blockLinkUrl(
  anchor: IAnchor,
  location = window.location,
): string {
  return `${location.origin}${location.pathname}${location.search}#${blockFragment(anchor)}`
}

/**
 * The top-level element of `root` that an anchor lands in, or null when the
 * block is not there any more.
 *
 * Top-level because that is what a block link is made from (the grip is on
 * top-level blocks), and because a hit that falls inside a list item or a
 * table cell should still bring the whole block into view.
 */
export function findLinkedBlock(
  root: HTMLElement,
  anchor: IAnchor,
): HTMLElement | null {
  const index = domTextIndex(root)
  const found = resolveAnchor(index.text, anchor)
  if (found.status !== 'anchored') return null
  const range = index.rangeOf(found.start, found.end)
  if (!range) return null
  let node: Node | null = range.startContainer
  while (node && node.parentNode !== root) node = node.parentNode
  return node instanceof HTMLElement ? node : null
}

/**
 * What a `[[reference]]` points at, and how its chip is built.
 *
 * One definition, called by both surfaces. The reader patches this markup
 * into rendered HTML and the editor renders the same shape as a node view,
 * so a change to how a card chip looks cannot land in one and miss the other.
 */
import type { IRefCard } from '@/stores/refs'

export type TRefKind = 'item' | 'doc' | 'space' | 'actor' | 'query'

export interface IRefTarget {
  kind: TRefKind
  /** The bare value: a card key, a slug, a space key, a handle. */
  value: string
}

const ITEM_KEY = /^[A-Z][A-Z0-9]{1,4}-\d+$/

/**
 * Reads the inside of the brackets.
 *
 * Unrecognised targets fall back to `item`, which is what the reader already
 * did: the chip then resolves to nothing and says the card is gone, which is
 * a truthful answer to `[[nonsense]]`.
 */
export function classifyRef(target: string): IRefTarget {
  const value = target.trim()
  if (value.startsWith('@')) return { kind: 'actor', value: value.slice(1) }
  if (value.startsWith('doc:')) return { kind: 'doc', value: value.slice(4) }
  if (value.startsWith('space:'))
    return { kind: 'space', value: value.slice(6) }
  if (value.startsWith('query:'))
    return { kind: 'query', value: value.slice(6) }
  return { kind: 'item', value }
}

/** Whether a target looks like a card key, for callers that only want those. */
export function isItemKey(value: string): boolean {
  return ITEM_KEY.test(value)
}

export interface IChipView {
  /** Classes to add alongside `md__ref`. */
  classes: string[]
  /** The tooltip: where the card lives, or why it is not there. */
  title: string
  key: string
  label: string
  /** True once the card is known to be missing, so the chip can say so. */
  gone: boolean
}

/**
 * The chip for a card reference.
 *
 * `undefined` means "not looked up yet" and `null` means "asked, and there is
 * no such card". They must not look the same: the first is a chip mid-flight
 * and the second is a broken link somebody should fix.
 */
export function itemChip(
  key: string,
  card: IRefCard | null | undefined,
  alias?: string | null,
): IChipView | null {
  if (card === undefined) return null
  if (card === null)
    return {
      classes: ['md__ref--chip', 'md__ref--gone'],
      title: 'This card no longer exists',
      key,
      label: '',
      gone: true,
    }
  return {
    classes: [
      'md__ref--chip',
      ...(card.done ? ['md__ref--done'] : []),
      ...(card.archived ? ['md__ref--archived'] : []),
    ],
    title: card.archived ? `${card.list} · archived` : card.list,
    key: card.key,
    label: alias?.trim() || card.title,
    gone: false,
  }
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The chip's innards as HTML, for the reader, which patches rendered markup. */
export function itemChipHtml(view: IChipView): string {
  if (view.gone) return esc(view.key)
  return (
    `<span class="md__chip-dot" aria-hidden="true"></span>` +
    `<span class="md__chip-key">${esc(view.key)}</span>` +
    `<span class="md__chip-title">${esc(view.label)}</span>`
  )
}

/**
 * The glyph for a reference that is a link rather than a live card.
 *
 * Doc and space references had none in the reader while the editor drew one,
 * so the same `[[doc:x]]` looked like a plain underlined word on one surface
 * and a chip on the other. Path data from `@nubisco/ui`'s icon set.
 */
export const REF_ICON_PATHS: Record<string, string> = {
  doc: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z',
  space:
    'M216,48H40a8,8,0,0,0-8,8V208a16,16,0,0,0,16,16H88a16,16,0,0,0,16-16V160h48v16a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V56A8,8,0,0,0,216,48ZM88,208H48V128H88Zm0-96H48V64H88Zm64,32H104V64h48Zm56,32H168V128h40Zm0-64H168V64h40Z',
}

/** The glyph as an inline SVG string, for the reader. */
export function refIconSvg(kind: string): string {
  const d = REF_ICON_PATHS[kind]
  if (!d) return ''
  return `<svg class="md__ref-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`
}

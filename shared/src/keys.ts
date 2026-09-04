/**
 * Human keys (design-spec §1): boards have 2-5 uppercase-letter keys (SW),
 * items have per-board sequential keys (SW-142), docs have path slugs.
 */

export const BOARD_KEY_RE = /^[A-Z][A-Z0-9]{1,4}$/
export const ITEM_KEY_RE = /^([A-Z][A-Z0-9]{1,4})-(\d+)$/
export const DOC_SLUG_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/

export function isBoardKey(value: string): boolean {
  return BOARD_KEY_RE.test(value)
}

export function isItemKey(value: string): boolean {
  return ITEM_KEY_RE.test(value)
}

export function parseItemKey(
  value: string,
): { board: string; seq: number } | null {
  const m = ITEM_KEY_RE.exec(value)
  if (!m) return null
  return { board: m[1], seq: Number(m[2]) }
}

export function itemKey(board: string, seq: number): string {
  return `${board}-${seq}`
}

export function isDocSlug(value: string): boolean {
  return DOC_SLUG_RE.test(value)
}

/** Slugify a title or heading the same way everywhere (docs, section anchors). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

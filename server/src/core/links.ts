/**
 * Where cards, goals and documents open in the web app, as templates, for
 * anything outside the app that wants to link what it names. The shapes are
 * the routes in web/src/routes.ts: a card opens over its space's board, a goal
 * and a document have pages.
 *
 * Templates rather than an address on every row: the addresses follow from the
 * key, so saying how once costs a few dozen tokens where a url per row costs a
 * third of a compact read.
 *
 * No base URL, or one that is not http(s), means no templates rather than
 * relative ones: a reader outside the app cannot resolve a path, and a wrong
 * host is worse than none.
 */

export interface IUrlTemplates {
  /** {space} is the part of the card key before the dash: CM for CM-35. */
  item: string
  goal: string
  doc: string
}

export function urlTemplates(
  baseUrl: string | undefined,
  workspaceSlug: string | null | undefined,
): IUrlTemplates | null {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]/i.test(base) || !workspaceSlug) return null
  const root = `${base}/${encodeURIComponent(workspaceSlug)}`
  return {
    item: `${root}/s/{space}?item={key}`,
    goal: `${root}/goals/{number}`,
    doc: `${root}/docs/{slug}`,
  }
}

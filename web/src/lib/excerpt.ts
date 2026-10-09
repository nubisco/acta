/**
 * A piece of markdown as a reader would say it, for the places that show a
 * line of it rather than render it: a board card's summary, a search match,
 * a notification.
 *
 * Those showed the source: "@daniela", "[[WEB-19]]", "## Steps", backticks.
 * The rule written on ActorChip is that a handle is the storage format and
 * never the visible one, and a summary is no exception (UX audit,
 * 2026-10-09). Card keys are kept as keys, so RefText can still make them
 * openable.
 */
export function plainExcerpt(
  text: string,
  nameOf: (handle: string) => string | undefined = () => undefined,
): string {
  const person = (handle: string) => nameOf(handle) ?? handle
  return (
    text
      // [[@handle]] and [[KEY]] / [[doc:slug|Alias]] / [[goal:3]]
      .replace(/\[\[@([a-z0-9-]+)\]\]/gi, (_m, h: string) => person(h))
      .replace(
        /\[\[(?:doc:|goal:)?([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_m, ref: string, alias?: string) => alias ?? ref,
      )
      // A bare @handle, not part of an email address.
      .replace(
        /(^|[^\w.])@([a-z0-9-]+)/gi,
        (_m, pre: string, h: string) => `${pre}${person(h)}`,
      )
      // Links and images: keep the words.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Line starts: headings, quotes, list markers, task boxes.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
      // Emphasis and code marks, leaving their text.
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      // Escapes the editor writes, such as \[ and \_.
      .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

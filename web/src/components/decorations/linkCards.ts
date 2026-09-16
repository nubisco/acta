/**
 * A bare URL on a line of its own, shown as a preview card.
 *
 * One definition, called by both surfaces: the reader patches this markup
 * into its rendered HTML and the editor renders the same string inside a node
 * view, so the card cannot look like one thing while editing and another
 * while reading.
 *
 * What makes this feature cheap is what it does NOT do. There is no new
 * syntax: the markdown stays exactly `https://example.com/page`, the card is
 * a decoration over it, and a document written before this existed already
 * contains everything the card needs. Nothing here can damage a file, because
 * nothing here is in the file.
 *
 * The rule for when a card appears is the whole design, and it is narrow on
 * purpose: the URL must be the entire paragraph. A URL inside a sentence stays
 * an ordinary link, because a card is a block and a block cannot live inside a
 * sentence in either surface. Widening the rule to "its own line inside a
 * paragraph" would mean the editor had to split that paragraph in three to
 * hold the card, and a save would then write back blank lines the author never
 * typed.
 */
import { safeUrl } from '@/lib/safeUrl'
import { parseDriveUrl } from '@/lib/drive'

export interface ILinkPreview {
  url: string
  /** 'none' means the server found nothing: the plain link stays. */
  status: 'ok' | 'none'
  title?: string
  description?: string
  site_name?: string
  image_url?: string
  favicon_url?: string
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The URL an anchor shows, if the anchor is a bare URL and nothing else.
 *
 * "Bare" means the author typed the URL and let it link itself, rather than
 * writing `[label](url)`. The test is that the visible text IS the target,
 * character for character.
 *
 * Character for character, and not "the same URL once you account for
 * percent-encoding", which is what this did first. A test caught it:
 * markdown-it decodes the link TEXT while leaving the href encoded, so
 * `https://example.com/wiki/Caf%C3%A9` renders with the text
 * `https://example.com/wiki/Café`. Storing the text then wrote that back into
 * the document, silently re-spelling somebody's URL. Neither side is
 * recoverable as "what was typed", because the same pair of values comes out
 * whichever of the two forms was written.
 *
 * So a URL whose text and href disagree gets no card, and stays the ordinary
 * link it already was. In practice that is URLs with a non-ASCII or escaped
 * path, and the trade is the right way round: a missing card is a feature
 * that did not fire, and a rewritten URL is damage to a file.
 */
export function bareUrlOf(anchor: HTMLAnchorElement): string | null {
  const text = (anchor.textContent ?? '').trim()
  const href = anchor.getAttribute('href')?.trim() ?? ''
  if (!text || !href) return null
  if (!/^https?:\/\//i.test(text)) return null
  if (text !== href) return null
  // Only what is safe to navigate to. The same allowlist the rest of the
  // reader uses, never a second check written from memory.
  return safeUrl(text) ? text : null
}

/**
 * The URL of a paragraph that is nothing but a bare URL, or null.
 *
 * Whitespace-only text around the link is tolerated, because markdown-it
 * leaves a newline inside the paragraph. Anything else in the paragraph,
 * including a second link, means the URL is part of a sentence.
 */
export function bareUrlParagraph(el: Element): string | null {
  const anchors = el.querySelectorAll('a')
  if (anchors.length !== 1) return null
  const anchor = anchors[0]
  // The anchor must BE the paragraph, not sit inside other markup in it.
  if (anchor.parentElement !== el) return null
  if ((el.textContent ?? '').trim() !== (anchor.textContent ?? '').trim())
    return null
  const url = bareUrlOf(anchor)
  if (!url) return null
  // A Drive link is already a pill in the reader, built from the URL alone
  // with no account and no API call. A card would be a worse version of it:
  // Drive answers an anonymous fetch with a sign-in page, so the preview
  // would come back empty and the pill would be lost.
  if (parseDriveUrl(url)) return null
  return url
}

/** The hostname, without the www, for a card whose site did not name itself. */
export function siteLabel(url: string, given?: string): string {
  if (given) return given
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The card, or the plain link.
 *
 * Three states, one of which is not a card at all:
 *
 *  - no preview yet: the plain link, exactly as it rendered before. The card
 *    is never a spinner or an empty outline, because a document opens before
 *    the metadata lands and a page of grey boxes reads as a broken document.
 *  - status 'none': the plain link, permanently. A site with no metadata, an
 *    intranet address the server refuses to fetch, and a page that is simply
 *    down all end here, which is right: a card must never become a broken box.
 *  - status 'ok': the card.
 */
export function linkCardHtml(
  url: string,
  preview: ILinkPreview | null | undefined,
): string {
  const href = safeUrl(url)
  if (!href) return esc(url)
  const open = `href="${esc(href)}" target="_blank" rel="noopener noreferrer"`

  if (!preview || preview.status !== 'ok')
    return `<a class="md__card-plain" ${open}>${esc(url)}</a>`

  const favicon = safeUrl(preview.favicon_url)
  const image = safeUrl(preview.image_url)
  const site = siteLabel(url, preview.site_name)

  return (
    `<a class="md__card" ${open} title="${esc(preview.title ?? url)}">` +
    (image
      ? `<span class="md__card-shot"><img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
      : '') +
    `<span class="md__card-body">` +
    `<span class="md__card-site">` +
    (favicon
      ? `<img class="md__card-icon" src="${esc(favicon)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : '') +
    `<span class="md__card-host">${esc(site)}</span>` +
    `</span>` +
    `<span class="md__card-title">${esc(preview.title ?? '')}</span>` +
    (preview.description
      ? `<span class="md__card-desc">${esc(preview.description)}</span>`
      : '') +
    `</span>` +
    `</a>`
  )
}

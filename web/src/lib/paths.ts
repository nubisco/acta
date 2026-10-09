/**
 * Paths inside the current workspace.
 *
 * Every route now lives under a workspace segment, so a bare `/b/SU` is no
 * longer a valid destination. Reading the slug from the API client rather than
 * from the route means one source of truth: the navigation guard sets it
 * before anything renders, and it is the same value the requests are scoped
 * to, so a link can never point somewhere the data does not come from.
 */

import { getWorkspaceSlug } from '@/api/client'

export function wpath(path: string): string {
  const slug = getWorkspaceSlug()
  if (!slug) return path
  return `/${slug}${path.startsWith('/') ? path : `/${path}`}`
}

/** Where a card lives: its space, with the card open. */
export function cardPath(key: string): string {
  const space = key.split('-')[0]
  return wpath(
    `/s/${encodeURIComponent(space)}?item=${encodeURIComponent(key)}`,
  )
}

/**
 * Whether a click asks for a new tab or window. Every card has an address, so
 * a modified click on a card mention gets one instead of the in-app panel.
 */
export function wantsNewTab(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1
}

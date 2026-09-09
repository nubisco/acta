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

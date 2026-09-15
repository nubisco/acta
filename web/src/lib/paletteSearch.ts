/**
 * Workspace content as command palette results.
 *
 * Acta had two overlays that both took typing: the palette for actions and
 * the topbar box for content. Which one you wanted depended on knowing, in
 * advance, whether the thing in your head was a command or a card. Nobody
 * thinks that way, so the palette now answers both and cmd+k is the one
 * thing to learn.
 */
import type { ICommand } from '@nubisco/ui'
import type { Router } from 'vue-router'
import { api } from '@/api/client'
import type { ISearchResult } from '@/types/api'
import { wpath } from '@/lib/paths'

function iconFor(type: string): string {
  if (type === 'doc') return 'file-text'
  if (type === 'comment') return 'chat-circle'
  return 'kanban'
}

/** What each hit is, in the words the rest of the interface uses. */
function namespaceFor(type: string): string {
  if (type === 'doc') return 'Documents'
  if (type === 'comment') return 'Comments'
  return 'Cards'
}

export interface IPaletteSearchDeps {
  router: Router
  openItem: (key: string) => void
}

export function createPaletteSuggester({
  router,
  openItem,
}: IPaletteSearchDeps) {
  return async function suggest(query: string): Promise<ICommand[]> {
    const { results } = await api.search(query)
    const commands: ICommand[] = results.slice(0, 7).map((hit) => ({
      // Namespaced so a card id can never collide with a registered
      // command's id and silently replace it in the palette's map.
      id: `search:${hit.type}:${hit.ref}`,
      label: hit.title,
      namespace: namespaceFor(hit.type),
      icon: iconFor(hit.type) as ICommand['icon'],
      handler: () => openHit(hit, router, openItem),
    }))

    // A way through to the full results, kept because seven hits is a
    // preview and the search page is where filters and the rest live.
    if (results.length > 0) {
      commands.push({
        id: 'search:all',
        label: `All results for "${query}"`,
        namespace: namespaceFor('item'),
        icon: 'magnifying-glass' as ICommand['icon'],
        handler: () =>
          void router.push({ path: wpath('/search'), query: { q: query } }),
      })
    }
    return commands
  }
}

export function openHit(
  hit: ISearchResult,
  router: Router,
  openItem: (key: string) => void,
): void {
  if (hit.type === 'doc') void router.push(wpath(`/docs/${hit.ref}`))
  else if (hit.type === 'item') openItem(hit.ref)
  // Comment hits carry the owning item key as their title.
  else openItem(hit.title)
}

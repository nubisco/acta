/**
 * Workspace store: the overview cache, the current user, the SSE feed that
 * invalidates views, connection health, and a small notification ring.
 * Plain composable state, no store library.
 */

import { computed, ref } from 'vue'
import { api, auth, subscribeEvents } from '@/api/client'
import type { ILiveEvent, IOverview } from '@/types/api'

export interface IMe {
  id: string
  handle: string
  kind: string
  role: string
  scopes: string[]
  email?: string
  name?: string
}

export interface IAppNotification {
  id: string
  title: string
  description?: string
  timestamp: string
  read: boolean
}

const overview = ref<IOverview | null>(null)
const me = ref<IMe | null>(null)
const connectionDown = ref(false)
const notifications = ref<IAppNotification[]>([])
const listeners = new Set<(event: ILiveEvent) => void>()
let unsubscribe: (() => void) | null = null

const NOTIFY_VERBS = new Set([
  'comment.created',
  'item.assigned',
  'member.provisioned',
])

export function useWorkspace() {
  async function loadMe(): Promise<boolean> {
    try {
      me.value = (await auth.me()) as IMe
      return true
    } catch {
      me.value = null
      return false
    }
  }

  async function refresh(): Promise<void> {
    overview.value = await api.overview()
  }

  function connect(): void {
    if (unsubscribe) return
    unsubscribe = subscribeEvents(
      (event) => {
        connectionDown.value = false
        if (event.entity === 'board' || event.entity === 'list') void refresh()
        if (NOTIFY_VERBS.has(event.verb) && event.actor_kind !== 'human') {
          notifications.value = [
            {
              id: event.id,
              title: describe(event),
              timestamp: new Date().toISOString(),
              read: false,
            },
            ...notifications.value,
          ].slice(0, 30)
        }
        for (const listener of listeners) listener(event)
      },
      (down) => (connectionDown.value = down),
    )
  }

  function onLive(listener: (event: ILiveEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function markAllRead(): void {
    notifications.value = notifications.value.map((n) => ({
      ...n,
      read: true,
    }))
  }

  async function logout(): Promise<void> {
    await auth.logout()
    me.value = null
    overview.value = null
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    overview: computed(() => overview.value),
    me: computed(() => me.value),
    isAdmin: computed(() => me.value?.role === 'admin'),
    connectionDown: computed(() => connectionDown.value),
    notifications: computed(() => notifications.value),
    unreadCount: computed(
      () => notifications.value.filter((n) => !n.read).length,
    ),
    markAllRead,
    loadMe,
    refresh,
    connect,
    onLive,
    logout,
  }
}

function describe(event: ILiveEvent): string {
  switch (event.verb) {
    case 'comment.created':
      return 'An agent commented on an item'
    case 'item.assigned':
      return 'An item assignment changed'
    case 'member.provisioned':
      return 'A new member joined via single sign-on'
    default:
      return event.verb
  }
}

/** Cross-view UI state: inspector selection and dialogs. */
const inspectedItemKey = ref<string | null>(null)
const newBoardOpen = ref(false)
const itemModalKey = ref<string | null>(null)

/**
 * Dual-flavor sidebar: dense routes collapse to the icon rail, navigation-
 * heavy routes expand. The user's toggle overrides the route default until
 * the next navigation.
 */
export type TSidebarVariant = 'compact' | 'verbose'
const sidebarChoice = ref<TSidebarVariant | null>(null)

export function useInspector() {
  return {
    itemKey: inspectedItemKey,
    open: (key: string) => (inspectedItemKey.value = key),
    close: () => (inspectedItemKey.value = null),
  }
}

const DENSE_ROUTES = new Set(['board', 'docs'])

export function useUiState() {
  return { newBoardOpen, itemModalKey, sidebarChoice }
}

export function sidebarDefaultFor(routeName: unknown): TSidebarVariant {
  return DENSE_ROUTES.has(String(routeName)) ? 'compact' : 'verbose'
}

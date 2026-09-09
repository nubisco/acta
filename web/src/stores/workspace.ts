/**
 * Workspace store: the overview cache, the current user, the SSE feed that
 * invalidates views, connection health, and a small notification ring.
 * Plain composable state, no store library.
 */

import { computed, ref } from 'vue'
import { api, auth, setWorkspaceSlug, subscribeEvents } from '@/api/client'
import type { ILiveEvent, IOverview } from '@/types/api'

export interface IWorkspaceSummary {
  id: string
  name: string
  slug: string
}

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
const workspaceSlug = ref('')
const workspaces = ref<IWorkspaceSummary[]>([])
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

  /**
   * Open a workspace by its URL slug. Returns false when this session has no
   * actor there, which the server reports as a 404 so that a stranger cannot
   * learn which workspace names exist.
   */
  async function enterWorkspace(slug: string): Promise<boolean> {
    setWorkspaceSlug(slug)
    try {
      overview.value = await api.overview()
      workspaceSlug.value = slug
      return true
    } catch {
      workspaceSlug.value = ''
      return false
    }
  }

  /** Every workspace this session can open, loaded once. */
  async function listWorkspaces(): Promise<IWorkspaceSummary[]> {
    if (workspaces.value.length === 0) {
      workspaces.value = (await auth.workspaces()).workspaces
    }
    return workspaces.value
  }

  /**
   * Where an unprefixed URL should land. One workspace is the common case and
   * should never make anyone choose; more than one has no right answer, so
   * the picker decides.
   */
  async function defaultWorkspaceSlug(): Promise<string | null> {
    if (!me.value && !(await loadMe())) return null
    const all = await listWorkspaces().catch(() => [])
    return all.length === 1 ? all[0].slug : null
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
    workspaceSlug: computed(() => workspaceSlug.value),
    workspaces: computed(() => workspaces.value),
    enterWorkspace,
    listWorkspaces,
    defaultWorkspaceSlug,
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

/**
 * Cards opened from inside the inspector (a [[ref]] chip in a description)
 * form a trail, so the inspector carries its own way back in addition to
 * browser history. `navMode` tells the URL sync how to record the change:
 * forward hops push history entries, trail-backs replace.
 */
const inspectorTrail = ref<string[]>([])
const inspectorNavMode = ref<'push' | 'replace'>('push')

export function useInspector() {
  return {
    itemKey: inspectedItemKey,
    trail: inspectorTrail,
    navMode: inspectorNavMode,
    open: (key: string) => {
      if (inspectedItemKey.value && inspectedItemKey.value !== key)
        inspectorTrail.value = [...inspectorTrail.value, inspectedItemKey.value]
      inspectorNavMode.value = 'push'
      inspectedItemKey.value = key
    },
    back: () => {
      const previous = inspectorTrail.value.at(-1) ?? null
      inspectorTrail.value = inspectorTrail.value.slice(0, -1)
      inspectorNavMode.value = 'replace'
      inspectedItemKey.value = previous
    },
    /** URL-driven change (deep link, browser Back): no trail bookkeeping,
     * except that landing on the trail's tail IS a back step. */
    restore: (key: string | null) => {
      if (inspectorTrail.value.at(-1) === key)
        inspectorTrail.value = inspectorTrail.value.slice(0, -1)
      inspectedItemKey.value = key
    },
    close: () => {
      inspectorTrail.value = []
      inspectedItemKey.value = null
    },
  }
}

/** Quick-look modal for docs referenced outside the docs space. */
const previewDocSlug = ref<string | null>(null)

export function useDocPreview() {
  return {
    slug: previewDocSlug,
    open: (slug: string) => (previewDocSlug.value = slug),
    close: () => (previewDocSlug.value = null),
  }
}

const DENSE_ROUTES = new Set(['board', 'docs'])

export function useUiState() {
  return { newBoardOpen, itemModalKey, sidebarChoice }
}

export function sidebarDefaultFor(routeName: unknown): TSidebarVariant {
  return DENSE_ROUTES.has(String(routeName)) ? 'compact' : 'verbose'
}

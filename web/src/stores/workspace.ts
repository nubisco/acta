/**
 * Workspace store: the overview cache, the current user, the SSE feed that
 * invalidates views, connection health, and a small notification ring.
 * Plain composable state, no store library.
 */

import { computed, ref } from 'vue'
import {
  api,
  auth,
  getWorkspaceSlug,
  setWorkspaceSlug,
  subscribeEvents,
} from '@/api/client'
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
  /**
   * The avatar the provider published, absent when this person has none. The
   * server has already checked it is on the issuer's origin.
   */
  picture?: string
  /** The provider's own id, for matching against the browser's accounts. */
  platform_user_id?: string
  /** False until this person has been through the welcome, on any device. */
  onboarded?: boolean
}

export interface IAppNotification {
  id: string
  title: string
  /** Why this reached you: mentioned, assigned, or already taking part. */
  reason: 'mention' | 'assigned' | 'involved'
  /** The card to open, when there is one. */
  itemKey: string | null
  timestamp: string
  read: boolean
}

const overview = ref<IOverview | null>(null)
const me = ref<IMe | null>(null)
const connectionDown = ref(false)
/**
 * Delay before "Reconnecting" is shown.
 *
 * EventSource drops and re-establishes on its own routinely: a proxy idle
 * timeout, a laptop waking, a network hiccup. Each one fires onerror and is
 * fixed within a second or two without anybody doing anything. Painting a
 * warning callout across the top of the app for that made a perfectly healthy
 * self-hosted instance look broken, which is the first thing a new operator
 * sees. The banner is for a stream that is actually staying down.
 */
const RECONNECT_GRACE_MS = 6000
let downTimer: ReturnType<typeof setTimeout> | null = null
const workspaceSlug = ref('')
const workspaces = ref<IWorkspaceSummary[]>([])
const notifications = ref<IAppNotification[]>([])
const listeners = new Set<(event: ILiveEvent) => void>()
let unsubscribe: (() => void) | null = null

/**
 * Verbs that might have produced a notification for somebody. A superset of
 * the server's list on purpose: this only decides whether to re-read, and
 * the server decides who is actually told.
 */
const NOTIFY_VERBS = new Set([
  'comment.created',
  'item.assigned',
  'item.created',
  'item.updated',
  'item.archived',
  'item.restored',
  'item.completed',
  'item.reopened',
  'item.moved',
  'doc.comment_created',
])

/** Ids already shown as a desktop notification, so a re-read never repeats one. */
const announced = new Set<string>()
/**
 * Whether the inbox has been read at all yet.
 *
 * Explicit rather than inferred from the inbox being empty: someone whose
 * first load returns nothing would otherwise be treated as "still loading for
 * the first time" forever, and their first real notification would be
 * swallowed as history.
 */
let inboxLoaded = false

/**
 * How this instance signs people in. Null until read, and read once: it does
 * not change while the app is open.
 */
const authConfig = ref<{
  nubisco_platform?: boolean
  platform_url?: string
} | null>(null)

async function loadAuthConfig(): Promise<void> {
  if (authConfig.value) return
  try {
    authConfig.value = await auth.config()
  } catch {
    // Left null, which reads as "not the platform" everywhere below, so a
    // failed read hides the platform parts rather than showing broken ones.
    authConfig.value = null
  }
}

export function useWorkspace() {
  async function loadMe(): Promise<boolean> {
    try {
      me.value = (await auth.me()) as IMe
      // Cheap and cached for the session. The account menu needs it before it
      // can decide whether to offer account actions at all.
      void loadAuthConfig()
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
        if (downTimer) {
          clearTimeout(downTimer)
          downTimer = null
        }
        connectionDown.value = false
        if (event.entity === 'space' || event.entity === 'list') void refresh()
        // Anything might have produced a notification for this person, and
        // the server is the one that knows. Re-reading is cheap and means
        // the bell shows the same thing in every tab.
        if (NOTIFY_VERBS.has(event.verb)) void loadNotifications()
        for (const listener of listeners) listener(event)
      },
      (down) => {
        if (downTimer) {
          clearTimeout(downTimer)
          downTimer = null
        }
        if (!down) {
          connectionDown.value = false
          return
        }
        downTimer = setTimeout(() => {
          connectionDown.value = true
          downTimer = null
        }, RECONNECT_GRACE_MS)
      },
    )
  }

  function onLive(listener: (event: ILiveEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /**
   * Read the inbox from the server, and raise a desktop notification for
   * anything unread that has not been announced yet.
   *
   * The browser's own notification is the point of the exercise: a bell you
   * have to be looking at to notice is a bell for people already looking.
   */
  async function loadNotifications(): Promise<void> {
    const res = await api.notifications().catch(() => null)
    if (!res) return
    const fresh: IAppNotification[] = res.notifications.map((n) => ({
      id: n.id,
      title: n.summary,
      reason: n.reason,
      itemKey: n.item_key,
      timestamp: new Date(n.created_at).toISOString(),
      read: n.read_at !== null,
    }))
    // The first read fills the set without announcing: everything unread
    // from before you opened the tab is history, not news.
    const first = !inboxLoaded
    inboxLoaded = true
    notifications.value = fresh
    for (const n of fresh) {
      if (n.read || announced.has(n.id)) continue
      announced.add(n.id)
      if (!first) announce(n)
    }
  }

  /** The OS-level notification, when the person has allowed them. */
  function announce(n: IAppNotification): void {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const body =
      n.reason === 'mention'
        ? 'You were mentioned'
        : n.reason === 'assigned'
          ? 'On a card assigned to you'
          : 'On a card you are part of'
    const notice = new Notification(n.title, {
      body,
      // One notification per item replaces the last rather than stacking
      // five of them for one busy card.
      tag: n.itemKey ?? n.id,
      icon: '/icons/acta-192.png',
    })
    notice.onclick = () => {
      window.focus()
      if (n.itemKey) {
        const slug = getWorkspaceSlug()
        window.location.href = `/${slug}/s/${n.itemKey.split('-')[0]}?item=${n.itemKey}`
      }
      notice.close()
    }
  }

  /** Ask once, on a real click: browsers refuse the prompt otherwise. */
  async function enableDesktopNotifications(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false
    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false
    return (await Notification.requestPermission()) === 'granted'
  }

  async function markAllRead(): Promise<void> {
    notifications.value = notifications.value.map((n) => ({
      ...n,
      read: true,
    }))
    await api.notificationRead().catch(() => undefined)
  }

  async function markRead(id: string): Promise<void> {
    notifications.value = notifications.value.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    )
    await api.notificationRead(id).catch(() => undefined)
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
    /** Whether sign-in goes through Nubisco Platform. Gates the account
        menu's platform-specific parts, per AGENTS.md. */
    signsInThroughNubisco: computed(
      () => authConfig.value?.nubisco_platform === true,
    ),
    /** Nubisco Platform's address, or null when sign-in goes elsewhere. */
    platformUrl: computed(() => authConfig.value?.platform_url ?? null),
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
    markRead,
    loadNotifications,
    enableDesktopNotifications,
    loadMe,
    refresh,
    connect,
    onLive,
    logout,
  }
}

/** Cross-view UI state: inspector selection and dialogs. */
const inspectedItemKey = ref<string | null>(null)

const newSpaceOpen = ref(false)
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

const DENSE_ROUTES = new Set(['space', 'docs'])

export function useUiState() {
  return { newSpaceOpen, itemModalKey, sidebarChoice }
}

export function sidebarDefaultFor(routeName: unknown): TSidebarVariant {
  return DENSE_ROUTES.has(String(routeName)) ? 'compact' : 'verbose'
}

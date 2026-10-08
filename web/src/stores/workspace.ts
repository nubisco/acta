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
  /** What happened, so the row can carry an icon that says which. */
  verb: string
  /** The card to open, when there is one. */
  itemKey: string | null
  /** The page to open, for everything that happened on a document. */
  docSlug: string | null
  /** The goal to open, for news about a goal. */
  goalNumber: number | null
  /**
   * Who did it. A person is represented by their avatar wherever they
   * appear, and an inbox is a list of things people did, so a row without a
   * face is the one place in the app that breaks that.
   */
  actorHandle: string | null
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
/**
 * The server's unread count. The list is the newest fifty, so counting the
 * unread rows in it understated the badge for anybody with more waiting.
 */
const unreadTotal = ref(0)
const listeners = new Set<(event: ILiveEvent) => void>()
let unsubscribe: (() => void) | null = null
/** The workspace the live stream was opened for. */
let connectedSlug: string | null = null

/**
 * How often the inbox is re-read regardless of the stream.
 *
 * The stream is fed in-process, by the same server instance that handled the
 * write. On Workers that is often not the instance holding this tab's
 * stream, and the cron that raises due-date reminders never is, so without
 * this the bell and the desktop notification only caught up on a reload.
 */
const POLL_MS = 60_000
let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * Verbs that might have produced a notification for somebody. A superset of
 * the server's list on purpose: this only decides whether to re-read, and
 * the server decides who is actually told.
 */
/**
 * Coalesce the re-reads.
 *
 * The stream is workspace-wide, so a burst of writes by one person is a burst
 * of events at everybody, and one GET per event per open tab is a lot of
 * requests to answer the same question. Saving a document repeatedly is the
 * shape that makes it obvious. The window is short enough that the bell still
 * feels live.
 */
let reloadTimer: ReturnType<typeof setTimeout> | null = null

const NOTIFY_VERBS = new Set([
  'goal.created',
  'goal.updated',
  'goal.owner_changed',
  'goal.checked_in',
  'goal.check_in_updated',
  'goal.archived',
  'goal.restored',
  'comment.created',
  'comment.updated',
  'comment.resolved',
  'item.assigned',
  'item.unassigned',
  'item.created',
  'item.updated',
  'item.archived',
  'item.restored',
  'item.completed',
  'item.reopened',
  'item.moved',
  'item.blocked',
  'item.unblocked',
  'item.due_soon',
  'item.overdue',
  'doc.created',
  'doc.updated',
  'member.updated',
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

/**
 * Where a notification opens.
 *
 * A card opens as an inspector over its own space, and a card key carries
 * that space in front of the dash. A document opens as a page. Everything
 * else has nowhere to go and says so by returning null, which is what makes
 * the row inert rather than a button that does nothing.
 */
export function notificationPath(n: IAppNotification): string | null {
  const slug = getWorkspaceSlug()
  if (!slug) return null
  if (n.itemKey)
    return `/${slug}/s/${n.itemKey.split('-')[0]}?item=${n.itemKey}`
  if (n.docSlug) return `/${slug}/docs/${n.docSlug}`
  if (n.goalNumber !== null) return `/${slug}/goals/${n.goalNumber}`
  return null
}

/**
 * The line under a desktop notification, which says why it reached you.
 *
 * It said "card" whatever the notification was about, so a comment on a page
 * or a check-in on a goal you own arrived described as a card.
 */
export function announceReason(n: IAppNotification): string {
  if (n.reason === 'mention') return 'You were mentioned'
  if (n.goalNumber !== null)
    return n.reason === 'assigned'
      ? 'On a goal you own'
      : 'On a goal you follow'
  if (n.itemKey)
    return n.reason === 'assigned'
      ? 'On a card assigned to you'
      : 'On a card you are part of'
  if (n.docSlug) return 'On a page you are part of'
  return 'About your account'
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
      const switched =
        workspaceSlug.value !== '' && workspaceSlug.value !== slug
      workspaceSlug.value = slug
      // The bell stays mounted across a switch, so it would go on showing
      // the last workspace's inbox. Read this one afresh, and treat what is
      // already waiting here as history rather than a burst of popups.
      if (switched) {
        notifications.value = []
        unreadTotal.value = 0
        inboxLoaded = false
        void loadNotifications()
      }
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
    // The stream is opened for one workspace. Moving to another used to
    // keep the first one's stream, so this workspace's bell only woke up
    // when something happened in the other.
    const slug = getWorkspaceSlug()
    if (unsubscribe && connectedSlug === slug) return
    unsubscribe?.()
    connectedSlug = slug
    if (!pollTimer)
      pollTimer = setInterval(() => void loadNotifications(), POLL_MS)
    unsubscribe = subscribeEvents(
      (event) => {
        if (downTimer) {
          clearTimeout(downTimer)
          downTimer = null
        }
        connectionDown.value = false
        // Goals ride in the overview as the catalogue every chip and picker
        // reads, so a goal created or renamed elsewhere has to reach it.
        if (
          event.entity === 'space' ||
          event.entity === 'list' ||
          event.entity === 'goal'
        )
          void refresh()
        // Anything might have produced a notification for this person, and
        // the server is the one that knows. Re-reading is cheap and means
        // the bell shows the same thing in every tab.
        if (NOTIFY_VERBS.has(event.verb)) reloadNotificationsSoon()
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
  function reloadNotificationsSoon(): void {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      void loadNotifications()
    }, 300)
  }

  async function loadNotifications(): Promise<boolean> {
    // Reported rather than swallowed. An inbox that renders "nothing waiting
    // on you" because the request failed is the one wrong answer the bell can
    // give, so the caller has to be able to tell the two apart.
    const res = await api.notifications().catch(() => null)
    if (!res) return false
    const fresh: IAppNotification[] = res.notifications.map((n) => ({
      id: n.id,
      title: n.actor_name ? `${n.actor_name} ${n.summary}` : n.summary,
      reason: n.reason,
      verb: n.verb,
      itemKey: n.item_key,
      docSlug: n.doc_slug,
      goalNumber: n.goal_number ?? null,
      actorHandle: n.actor_handle,
      timestamp: new Date(n.created_at).toISOString(),
      read: n.read_at !== null,
    }))
    // The first read fills the set without announcing: everything unread
    // from before you opened the tab is history, not news.
    const first = !inboxLoaded
    inboxLoaded = true
    notifications.value = fresh
    const listed = fresh.filter((n) => !n.read).length
    unreadTotal.value =
      typeof res.unread === 'number' ? Math.max(res.unread, listed) : listed
    for (const n of fresh) {
      if (n.read || announced.has(n.id)) continue
      announced.add(n.id)
      if (!first) announce(n)
    }
    return true
  }

  /** The OS-level notification, when the person has allowed them. */
  function announce(n: IAppNotification): void {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const notice = new Notification(n.title, {
      body: announceReason(n),
      // One notification per item replaces the last rather than stacking
      // five of them for one busy card.
      tag: n.itemKey ?? n.id,
      icon: '/icons/acta-192.png',
    })
    notice.onclick = async () => {
      window.focus()
      notice.close()
      // Opening it from the desktop is reading it, exactly as opening it
      // from the bell is. Left unread, it stayed in the badge and the
      // reminder email still went out for something already seen.
      await markRead(n.id)
      const target = notificationPath(n)
      if (target) window.location.href = target
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
    unreadTotal.value = 0
    await api.notificationRead().catch(() => undefined)
  }

  async function markRead(id: string): Promise<void> {
    if (notifications.value.some((n) => n.id === id && !n.read))
      unreadTotal.value = Math.max(0, unreadTotal.value - 1)
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
    connectedSlug = null
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
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
    unreadCount: computed(() => unreadTotal.value),
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
 * The new-goal dialog: null when closed, and when open, what it starts with.
 * Global like the new-space one, because a goal is created from the Goals
 * page, from a goal ("Add sub-goal"), from Home and from the palette alike.
 */
const newGoal = ref<{ parent?: number } | null>(null)
/** Bumped when a goal is created here, so lists re-read without waiting on
 *  the live stream, which may be down. */
const goalsVersion = ref(0)

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

/**
 * A card to point at once its space is on screen: scrolled to and briefly
 * ringed. Set by "Show on its space" in the inspector, which also keeps the
 * card open, so arriving at the board never means losing the card. `at`
 * makes asking twice for the same card a change the space can see.
 */
const revealCard = ref<{ key: string; at: number } | null>(null)

export function useUiState() {
  return {
    newSpaceOpen,
    itemModalKey,
    sidebarChoice,
    newGoal,
    goalsVersion,
    revealCard,
  }
}

export function sidebarDefaultFor(routeName: unknown): TSidebarVariant {
  return DENSE_ROUTES.has(String(routeName)) ? 'compact' : 'verbose'
}

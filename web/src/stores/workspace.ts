/**
 * Workspace store: the overview cache, the current user, and the SSE feed
 * that invalidates views. Plain composable state, no store library (house
 * apps keep state small and local).
 */

import { computed, ref } from 'vue'
import {
  api,
  auth,
  subscribeEvents,
  type ILiveEvent,
  type IOverview,
} from '@/api/client'

const overview = ref<IOverview | null>(null)
const me = ref<{ id: string; handle: string; role: string } | null>(null)
const listeners = new Set<(event: ILiveEvent) => void>()
let unsubscribe: (() => void) | null = null

export function useWorkspace() {
  async function loadMe(): Promise<boolean> {
    try {
      me.value = await auth.me()
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
    unsubscribe = subscribeEvents((event) => {
      // Board/list/doc structure changes refresh the overview lazily.
      if (event.entity === 'board' || event.entity === 'list') void refresh()
      for (const listener of listeners) listener(event)
    })
  }

  function onLive(listener: (event: ILiveEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
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
    loadMe,
    refresh,
    connect,
    onLive,
    logout,
  }
}

/** Cross-view UI state: which item the shell inspector is showing. */
const inspectedItemKey = ref<string | null>(null)

export function useInspector() {
  return {
    itemKey: inspectedItemKey,
    open: (key: string) => (inspectedItemKey.value = key),
    close: () => (inspectedItemKey.value = null),
  }
}

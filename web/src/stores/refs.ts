/**
 * Shared cache of card summaries behind [[KEY]] references, so every surface
 * that renders markdown (docs, descriptions, comments) resolves the same ref
 * to the same live chip. Requests batch across surfaces; board events over
 * the live stream refresh whatever is cached, keeping chips dynamic.
 */
import { reactive, ref } from 'vue'
import { api } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'

export interface IRefCard {
  key: string
  board: string
  list: string
  title: string
  done?: boolean
  archived?: boolean
}

/** null = asked the server, no such card; absent = not fetched yet. */
const cards = reactive(new Map<string, IRefCard | null>())
/** Bumped on every cache change so DOM hydrators know to re-run. */
const version = ref(0)

const pending = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let liveWired = false

async function flush(): Promise<void> {
  flushTimer = null
  const keys = [...pending]
  pending.clear()
  if (keys.length === 0) return
  try {
    const { items } = await api.itemGet(keys)
    const found = new Set<string>()
    for (const raw of items as IRefCard[]) {
      cards.set(raw.key, {
        key: raw.key,
        board: raw.board,
        list: raw.list,
        title: raw.title,
        done: raw.done,
        archived: raw.archived,
      })
      found.add(raw.key)
    }
    for (const key of keys) if (!found.has(key)) cards.set(key, null)
    version.value++
  } catch {
    // Transient failure: leave keys unfetched so a later render retries.
  }
}

function request(key: string): void {
  if (cards.has(key) || pending.has(key)) return
  pending.add(key)
  flushTimer ??= setTimeout(() => void flush(), 50)
}

function refreshCached(): void {
  for (const key of cards.keys()) pending.add(key)
  flushTimer ??= setTimeout(() => void flush(), 200)
}

export function useRefCards() {
  if (!liveWired) {
    liveWired = true
    // Item events carry internal ids, not keys, so any item change refreshes
    // the cached set wholesale; it is small (refs on screen) and batched.
    useWorkspace().onLive((event) => {
      if (event.entity === 'item' && cards.size > 0) refreshCached()
    })
  }
  return { cards, version, request }
}

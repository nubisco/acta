/**
 * Next up's data, shared by the panel and Home's greeting line, so the two
 * say the same thing from one request. Re-read when a card or goal changes.
 */
import { computed, onScopeDispose, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { api } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import type { INextUp } from '@/types/api'

const data = ref<INextUp | null>(null)
const loading = ref(true)
let inflight: Promise<void> | null = null
let users = 0
let timer: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | null = null

export function useNextUp() {
  const ws = useWorkspace()
  const toast = useToast()

  async function load(): Promise<void> {
    inflight ??= (async () => {
      try {
        data.value = await api.myNext()
      } catch (err) {
        toast.error(humanise(err), { title: 'Could not load what is next' })
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  users += 1
  if (users === 1) {
    void load()
    unsubscribe = ws.onLive((event) => {
      if (event.entity !== 'item' && event.entity !== 'goal') return
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 500)
    })
  }
  onScopeDispose(() => {
    users -= 1
    if (users === 0) {
      clearTimeout(timer)
      unsubscribe?.()
      unsubscribe = null
    }
  })

  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`

  /** One line, worst news first, or the good news when there is none. */
  const summary = computed(() => {
    const c = data.value?.counts
    if (!c) return ''
    const parts: string[] = []
    if (c.overdue)
      parts.push(plural(c.overdue, 'card overdue', 'cards overdue'))
    if (c.due_today) parts.push(`${c.due_today} due today`)
    if (c.mentions)
      parts.push(plural(c.mentions, 'mention waiting', 'mentions waiting'))
    if (c.blocking)
      parts.push(
        plural(c.blocking, 'card holding others up', 'cards holding others up'),
      )
    const later = c.due_week - c.due_today
    if (later > 0) parts.push(`${later} more due this week`)
    if (parts.length === 0) return 'Nothing is overdue or waiting on you.'
    return `${parts.join(', ')}.`.replace(/^./, (ch) => ch.toUpperCase())
  })

  return { data, loading, summary, load }
}

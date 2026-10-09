/**
 * Load a Home panel's data, and load it again when something it shows
 * changes elsewhere. Coalesced, so a burst of writes is one re-read.
 */
import { onMounted, onScopeDispose, ref, type Ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

export function useHomePanelData<T>(
  read: () => Promise<T>,
  entities: string[],
): { data: Ref<T | null>; loading: Ref<boolean>; reload: () => Promise<void> } {
  const ws = useWorkspace()
  const toast = useToast()
  const data = ref<T | null>(null) as Ref<T | null>
  const loading = ref(true)

  async function reload(): Promise<void> {
    try {
      data.value = await read()
    } catch (err) {
      toast.error(humanise(err), { title: 'Could not load part of Home' })
    } finally {
      loading.value = false
    }
  }

  onMounted(reload)
  let timer: ReturnType<typeof setTimeout> | undefined
  onScopeDispose(
    ws.onLive((event) => {
      if (!entities.includes(event.entity)) return
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 600)
    }),
  )
  onScopeDispose(() => clearTimeout(timer))
  return { data, loading, reload }
}

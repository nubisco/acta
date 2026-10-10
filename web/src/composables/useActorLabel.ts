import { computed, type ComputedRef } from 'vue'
import { useWorkspace } from '@/stores/workspace'
import type { IOverview } from '@/types/api'

type TActor = IOverview['actors'][number]

/**
 * Who a handle is, as the hover hint says it: name, handle and kind.
 *
 * Shared by the avatar and the mention, so a person reads the same in a
 * tooltip whether they are shown as a face or named inside a sentence.
 */
export function useActorLabel(
  handle: () => string,
  name: () => string | undefined = () => undefined,
): {
  actor: ComputedRef<TActor | undefined>
  displayName: ComputedRef<string>
  handleLabel: ComputedRef<string | undefined>
  kindLabel: ComputedRef<string | undefined>
} {
  const ws = useWorkspace()

  const actor = computed(() =>
    ws.overview.value?.actors.find((a) => a.handle === handle()),
  )

  const displayName = computed(
    () => actor.value?.name ?? name() ?? `@${handle()}`,
  )

  /** Only members have a handle worth showing, a foreign author has none. */
  const handleLabel = computed(() =>
    actor.value || !name() ? `@${handle()}` : undefined,
  )

  const kindLabel = computed(() => {
    switch (actor.value?.kind) {
      case 'agent':
        return 'AI agent'
      case 'system':
        return 'System account'
      case 'human':
        return 'Member'
      default:
        return undefined
    }
  })

  return { actor, displayName, handleLabel, kindLabel }
}

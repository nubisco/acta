/**
 * The walkthroughs as running controllers, one each, shared by the whole app.
 *
 * App.vue draws them, the views that start them ask here, and Settings lists
 * and resets them. Module-level so all of those hold the same controller,
 * which is what lets "only one at a time" be a rule rather than a hope.
 */
import { computed, ref } from 'vue'
import {
  createDefaultWalkthroughStorage,
  useWalkthrough,
  type IWalkthroughController,
  type IWalkthroughRecord,
  type IWalkthroughStorage,
} from '@nubisco/ui'
import { auth } from '@/api/client'
import {
  goalsTour,
  introTour,
  notificationsTour,
  type TTourName,
} from '@/lib/tour'

/**
 * Remembered on the account, so a second browser does not replay what was
 * already seen. Read once per load. The browser's own record is the
 * fallback: it is what the intro tour used before this existed, and someone
 * who finished it there has finished it, so the first read carries it over.
 */
export function createAccountWalkthroughStorage(): IWalkthroughStorage & {
  /** Drop the cache, so the next read asks the server again. */
  forget: () => void
} {
  const local = createDefaultWalkthroughStorage()
  let loaded: Promise<Record<string, IWalkthroughRecord> | null> | null = null

  function all(): Promise<Record<string, IWalkthroughRecord> | null> {
    // Any failure, thrown or rejected, falls back to this browser's record.
    loaded ??= (async () => {
      try {
        return (await auth.walkthroughs()).walkthroughs
      } catch {
        return null
      }
    })()
    return loaded
  }

  return {
    async get(id) {
      const remote = await all()
      if (remote === null) return local.get(id)
      if (remote[id]) return remote[id]
      const carried = await local.get(id)
      if (carried) {
        remote[id] = carried
        void auth.walkthroughSet(id, carried).catch(() => undefined)
      }
      return carried
    },
    async set(id, record) {
      await local.set(id, record)
      const remote = await all()
      if (remote) remote[id] = record
      await auth.walkthroughSet(id, record).catch(() => undefined)
    },
    async remove(id) {
      await local.remove(id)
      const remote = await all()
      if (remote) delete remote[id]
      await auth.walkthroughReset(id).catch(() => undefined)
    },
    forget() {
      loaded = null
    },
  }
}

const storage = createAccountWalkthroughStorage()

/**
 * Where a walkthrough has to take the reader mid-way, such as from the bell
 * to Settings. Set by App.vue, which has the router.
 */
let navigate: ((to: string) => Promise<unknown>) | null = null

export function setTourNavigator(fn: (to: string) => Promise<unknown>): void {
  navigate = fn
}

const controllers: Record<TTourName, IWalkthroughController> = {
  intro: useWalkthrough(introTour, { storage }),
  goals: useWalkthrough(goalsTour, { storage }),
  notifications: useWalkthrough(notificationsTour, {
    storage,
    onStepChange: (step) => {
      if (step.id === 'notify-go-settings')
        void navigate?.('/settings?tab=notifications')
    },
  }),
}

/** Something else has the screen, such as the welcome. Set by App.vue. */
const held = ref(false)

const anyActive = computed(() =>
  Object.values(controllers).some((c) => c.active.value),
)

export function useTours() {
  return {
    controllers,
    storage,
    held,
    anyActive,
    /**
     * Play this walkthrough if this person has not been through it. Never
     * over another one, and never while something else holds the screen.
     */
    async maybeStart(name: TTourName): Promise<boolean> {
      if (held.value || anyActive.value) return false
      return controllers[name].maybeAutoStart()
    },
  }
}

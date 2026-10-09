/**
 * The Home layout this person keeps, shared by the page and the customizer
 * in the inspector. Saved on the account, so it is the same in every
 * browser, and saved a moment after the last change rather than on every
 * drag step.
 */
import { ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { api } from '@/api/client'
import { humanise } from '@/lib/state'
import {
  defaultLayout,
  mergeLayout,
  type IHomePanelPlace,
} from '@/lib/homePanels'

const panels = ref<IHomePanelPlace[]>(defaultLayout())
const editing = ref(false)
const loaded = ref(false)
/** True once the person has a layout of their own, rather than the default. */
const custom = ref(false)
let saveTimer: ReturnType<typeof setTimeout> | undefined

export function useHomeLayout() {
  const toast = useToast()

  async function load(): Promise<void> {
    try {
      const { layout } = await api.homeLayout()
      panels.value = mergeLayout(layout?.panels ?? null)
      custom.value = layout !== null
    } catch {
      panels.value = defaultLayout()
    } finally {
      loaded.value = true
    }
  }

  function save(): void {
    custom.value = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await api.homeLayoutSave({
          version: 1,
          panels: panels.value.map((p) => ({
            id: p.id,
            ...(p.hidden ? { hidden: true } : {}),
            ...(p.wide ? { wide: true } : {}),
          })),
        })
      } catch (err) {
        toast.error(humanise(err), { title: 'Could not save your Home layout' })
      }
    }, 400)
  }

  function setPanels(next: IHomePanelPlace[]): void {
    panels.value = next
    save()
  }

  function update(id: string, change: Partial<IHomePanelPlace>): void {
    panels.value = panels.value.map((p) =>
      p.id === id ? { ...p, ...change } : p,
    )
    save()
  }

  async function reset(): Promise<void> {
    clearTimeout(saveTimer)
    panels.value = defaultLayout()
    custom.value = false
    try {
      await api.homeLayoutReset()
    } catch (err) {
      toast.error(humanise(err), { title: 'Could not reset your Home layout' })
    }
  }

  return { panels, editing, loaded, custom, load, setPanels, update, reset }
}

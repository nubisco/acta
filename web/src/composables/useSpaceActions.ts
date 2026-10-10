/**
 * Archiving and deleting a space (Jose, 2026-10-09: an empty board had no
 * way of being removed). Like a card: archive hides it and can be undone
 * from Home, delete is for good. An empty space can be deleted here
 * directly; one with cards is archived first and deleted from Home's
 * archived spaces, where its contents are spelled out. Admins only.
 *
 * One source for the space's own menu on a desktop and the topbar's overflow
 * menu on a phone, so the two cannot drift.
 */
import { useRouter } from 'vue-router'
import { useConfirm, useToast } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { wpath } from '@/lib/paths'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

export interface ISpaceRef {
  spaceKey: string
  spaceName: string
}

export function useSpaceActions(space: () => ISpaceRef) {
  const ws = useWorkspace()
  const router = useRouter()
  const confirm = useConfirm()
  const toast = useToast()

  async function write(op: 'archive' | 'delete'): Promise<void> {
    const { results } = await api.spaceWrite([
      { op, op_id: newOpId(), key: space().spaceKey },
    ])
    if (!results[0]?.ok) throw new Error(String(results[0]?.error ?? 'failed'))
    await ws.refresh()
    await router.push(wpath('/'))
  }

  async function archive(): Promise<void> {
    const { spaceName } = space()
    await confirm({
      title: `Archive ${spaceName}?`,
      message:
        'It leaves the sidebar and Home, with everything in it kept. Bring it back any time from Archived spaces on Home.',
      confirmLabel: 'Archive space',
      cancelLabel: 'Keep it',
      tone: 'neutral',
      onConfirm: async () => {
        await write('archive')
        toast.success(`${spaceName} archived.`)
      },
      formatError: humanise,
    })
  }

  async function remove(): Promise<void> {
    const { spaceName } = space()
    await confirm({
      title: `Delete ${spaceName}?`,
      message:
        'It has no cards, so only its lists go with it. This cannot be undone.',
      subject: spaceName,
      subjectLabel: 'Space',
      confirmLabel: 'Delete space',
      cancelLabel: 'Keep it',
      onConfirm: async () => {
        await write('delete')
        toast.success(`${spaceName} deleted.`)
      },
      formatError: humanise,
    })
  }

  return { archive, remove, isAdmin: ws.isAdmin }
}

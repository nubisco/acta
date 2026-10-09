/**
 * Changing who sees a page, and asking about it after the first save.
 *
 * A page is private to its owner or shared with the workspace's members,
 * never public. A new page starts private, and the first save asks whether
 * to share it (Jose, 2026-10-09). The server enforces all of it: this only
 * asks and reports.
 */
import { useConfirm, useToast } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import type { IDocDetail } from '@/types/api'

export function useDocSharing() {
  const confirm = useConfirm()
  const toast = useToast()
  const ws = useWorkspace()

  const workspaceName = () =>
    ws.overview.value?.workspace.name ?? 'the workspace'

  async function setVisibility(
    slug: string,
    visibility: 'private' | 'workspace',
  ): Promise<boolean> {
    try {
      const { results } = await api.docWrite([
        { op: 'set_visibility', op_id: newOpId(), ref: slug, visibility },
      ])
      if (!results[0]?.ok)
        throw new Error(String(results[0]?.error ?? 'failed'))
      return true
    } catch (err) {
      toast.error(humanise(err), {
        title: 'Could not change who sees this page',
      })
      return false
    }
  }

  /** The question after the first save. Either answer stops it being asked. */
  async function askToShare(doc: IDocDetail): Promise<boolean> {
    if (!doc.ask_share) return false
    let shared = false
    const confirmed = await confirm({
      title: 'Share this page?',
      message: `Only you can see it so far. Share it with the members of ${workspaceName()}, or keep it private and share it later from the page's info row. Nobody outside the workspace can see it either way.`,
      confirmLabel: 'Share with the workspace',
      cancelLabel: 'Keep private',
      tone: 'neutral',
      onConfirm: async () => {
        shared = await setVisibility(doc.slug, 'workspace')
      },
    })
    // "Keep private" is an answer too: record it, so the question is asked
    // once, not after every save.
    if (!confirmed) await setVisibility(doc.slug, 'private')
    if (shared) toast.success(`Shared with ${workspaceName()}.`)
    return shared
  }

  /** The info row's control: confirm, since it changes who can see it. */
  async function toggle(doc: IDocDetail): Promise<boolean> {
    const toShared = doc.visibility === 'private'
    let changed = false
    await confirm({
      title: toShared ? 'Share this page?' : 'Make this page private?',
      message: toShared
        ? `Every member of ${workspaceName()} will be able to find, read and comment on it, and on the pages under it.`
        : 'Only you will be able to see it, and the pages under it. Anyone who has it open loses access.',
      confirmLabel: toShared ? 'Share with the workspace' : 'Make private',
      cancelLabel: 'Keep it as it is',
      tone: 'neutral',
      onConfirm: async () => {
        changed = await setVisibility(
          doc.slug,
          toShared ? 'workspace' : 'private',
        )
      },
    })
    return changed
  }

  return { askToShare, toggle, workspaceName }
}

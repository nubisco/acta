/**
 * Item editing state shared by the inspector and the item modal: load,
 * drafts, autosave commits with optimistic-lock handling, comments, and
 * lifecycle actions. One save model: autosave on commit.
 */

import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'
import { useInlineLoading, useToast } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import type { IItemDetail, TViewState } from '@/types/api'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

export interface ILifecycleBadge {
  text: string
  variant: 'green' | 'grey' | 'orange'
  dot: boolean
}

/** The lifecycle a card moves through; `done`/`archived` map to server ops. */
export type TItemStatus = 'open' | 'done' | 'archived'

export const ITEM_STATUS_OPTIONS = [
  { label: 'Open', value: 'open' },
  { label: 'Done', value: 'done' },
  { label: 'Archived', value: 'archived' },
] as const

function statusOf(detail: IItemDetail): TItemStatus {
  if (detail.archived) return 'archived'
  if (detail.done) return 'done'
  return 'open'
}

export interface ISelectOptionView {
  label: string
  value: string
}

export function useItem(itemKey: Ref<string>) {
  const ws = useWorkspace()
  const toast = useToast()
  const save = useInlineLoading()

  const item = ref<IItemDetail | null>(null)
  const viewState = ref<TViewState>('loading')
  const loadMessage = ref('')
  const saveError = ref('')
  const commentDraft = ref('')
  const commenting = ref(false)

  const draft = reactive({
    title: '',
    list: '',
    due: null as string | null,
    assignees: [] as string[],
    labels: [] as string[],
    description: '',
    status: 'open' as TItemStatus,
  })

  const listOptions = ref<ISelectOptionView[]>([])
  const assigneeOptions = ref<ISelectOptionView[]>([])
  const labelOptions = ref<ISelectOptionView[]>([])
  const lifecycle = ref<ILifecycleBadge | null>(null)
  const linkFacts = ref<{ term: string; value: string }[]>([])

  function computeLifecycle(detail: IItemDetail): void {
    if (detail.archived)
      lifecycle.value = { text: 'Archived', variant: 'grey', dot: false }
    else if (detail.done)
      lifecycle.value = { text: 'Done', variant: 'green', dot: false }
    else if (detail.due && detail.due < Date.now())
      lifecycle.value = { text: 'Overdue', variant: 'orange', dot: true }
    else lifecycle.value = { text: 'Open', variant: 'green', dot: true }
  }

  async function load(): Promise<void> {
    viewState.value = 'loading'
    try {
      const { items } = await api.itemGet([itemKey.value])
      const detail = items[0]
      item.value = detail
      draft.title = detail.title
      draft.list = detail.list
      draft.due = detail.due
        ? new Date(detail.due).toISOString().slice(0, 10)
        : null
      draft.assignees = detail.assignees ?? []
      draft.labels = detail.labels ?? []
      draft.description = detail.description
      draft.status = statusOf(detail)
      computeLifecycle(detail)
      linkFacts.value = [
        ...(detail.links?.out ?? []).map((link) => ({
          term: `→ ${link.ref_type}`,
          value: link.target,
        })),
        ...(detail.links?.in ?? []).map((link) => ({
          term: '← referenced by',
          value: link.src_id,
        })),
      ]
      const board = ws.overview.value?.boards.find(
        (b) => b.key === detail.board,
      )
      listOptions.value = (board?.lists ?? []).map((l) => ({
        label: l.name,
        value: l.name,
      }))
      assigneeOptions.value = (ws.overview.value?.actors ?? [])
        .filter((a) => a.kind === 'human')
        .map((a) => ({ label: `@${a.handle}`, value: a.handle }))
      labelOptions.value = (ws.overview.value?.labels ?? [])
        .filter((l) => l.board_key === null || l.board_key === detail.board)
        .map((l) => ({ label: l.name, value: l.name }))
      viewState.value = 'ready'
    } catch (err) {
      loadMessage.value = humanise(err)
      viewState.value = 'error'
    }
  }

  watch(itemKey, () => void load(), { immediate: true })
  onScopeDispose(
    ws.onLive((event) => {
      if (event.entity === 'item' && event.actor_kind !== 'human') void load()
    }),
  )

  type TWriteOp = Parameters<typeof api.itemWrite>[0][number]

  async function write(op: TWriteOp): Promise<boolean> {
    saveError.value = ''
    await save.run(async () => {
      const { results } = await api.itemWrite([op])
      if (!results[0].ok) {
        throw new Error((results[0] as { error: string }).error)
      }
    })
    if (save.status.value === 'error') {
      const failure = save.error.value
      saveError.value =
        failure instanceof Error && failure.message.includes('conflict')
          ? 'Someone else changed this item; reloaded with their version'
          : humanise(failure)
      await load()
      return false
    }
    await load()
    return true
  }

  function commitTitle(): void {
    if (!item.value || draft.title.trim() === item.value.title) return
    void write({
      op: 'update',
      op_id: newOpId(),
      key: item.value.key,
      if_rev: item.value.rev,
      title: draft.title.trim(),
    })
  }

  function commitDescription(): void {
    if (!item.value || draft.description === item.value.description) return
    void write({
      op: 'update',
      op_id: newOpId(),
      key: item.value.key,
      if_rev: item.value.rev,
      description: draft.description,
    })
  }

  function commitList(): void {
    if (!item.value || draft.list === item.value.list) return
    void write({
      op: 'move',
      op_id: newOpId(),
      key: item.value.key,
      list: draft.list,
    })
  }

  function commitDue(): void {
    if (!item.value) return
    const due = draft.due ? Date.parse(draft.due) : null
    if (due === (item.value.due ?? null)) return
    void write({ op: 'update', op_id: newOpId(), key: item.value.key, due })
  }

  function commitSet(kind: 'assign' | 'label'): void {
    if (!item.value) return
    const current = kind === 'assign' ? draft.assignees : draft.labels
    const before = new Set(
      (kind === 'assign' ? item.value.assignees : item.value.labels) ?? [],
    )
    const after = new Set(current)
    const add = [...after].filter((entry) => !before.has(entry))
    const remove = [...before].filter((entry) => !after.has(entry))
    if (add.length === 0 && remove.length === 0) return
    void write({
      op: kind,
      op_id: newOpId(),
      key: item.value.key,
      add: add.length > 0 ? add : undefined,
      remove: remove.length > 0 ? remove : undefined,
    })
  }

  async function toggleCheck(
    checklist: string,
    text: string,
    done: boolean,
  ): Promise<void> {
    if (!item.value) return
    await write({
      op: 'checklist_set',
      op_id: newOpId(),
      key: item.value.key,
      checklist,
      ...(done ? { check: [text] } : { uncheck: [text] }),
    })
  }

  async function addComment(): Promise<void> {
    if (!item.value || !commentDraft.value.trim()) return
    commenting.value = true
    const ok = await write({
      op: 'comment',
      op_id: newOpId(),
      key: item.value.key,
      body: commentDraft.value.trim(),
    })
    if (ok) commentDraft.value = ''
    commenting.value = false
  }

  async function toggle(
    op: 'complete' | 'reopen' | 'archive' | 'restore',
  ): Promise<void> {
    if (!item.value) return
    const ok = await write({ op, op_id: newOpId(), key: item.value.key })
    if (ok && op === 'archive')
      toast.success('Archived. Find it under the archived filter.')
    if (ok && op === 'restore') toast.success('Restored to its list.')
  }

  /**
   * Status is the user-facing card state; the server models it as two
   * booleans, so a status change is a short op sequence, not a field write.
   */
  async function commitStatus(): Promise<void> {
    if (!item.value) return
    const current = statusOf(item.value)
    const target = draft.status
    if (target === current) return
    const ops: ('complete' | 'reopen' | 'archive' | 'restore')[] = []
    if (current === 'archived') ops.push('restore')
    if (current === 'done' && target !== 'done') ops.push('reopen')
    if (target === 'done' && !item.value.done) ops.push('complete')
    if (target === 'archived') ops.push('archive')
    for (const op of ops) {
      const ok = await write({ op, op_id: newOpId(), key: item.value.key })
      if (!ok) return
    }
    if (target === 'archived')
      toast.success('Archived. Find it under the archived filter.')
  }

  return {
    item: computed(() => item.value),
    viewState,
    loadMessage,
    saveError,
    save,
    draft,
    commentDraft,
    commenting,
    listOptions,
    assigneeOptions,
    labelOptions,
    lifecycle,
    linkFacts,
    load,
    commitTitle,
    commitDescription,
    commitList,
    commitDue,
    commitAssignees: () => commitSet('assign'),
    commitLabels: () => commitSet('label'),
    commitStatus,
    toggleCheck,
    addComment,
    toggle,
  }
}

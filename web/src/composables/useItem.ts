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
import { headingOption, labelGroups, labelsById } from '@/lib/labels'
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
  /** Group headings are inert rows, not something anybody can pick. */
  disabled?: boolean
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
    /**
     * Label IDs, not names. Two groups may hold the same value ("Affects
     * version" and "Fixes version" both list 1.12.0), so a name cannot say
     * which of them the card carries.
     */
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
      const { items } = await api.itemGet(
        [itemKey.value],
        // The defaults plus the history, which the card now shows.
        ['comments', 'checklists', 'links', 'attachments', 'activity'],
      )
      const detail = items[0]
      item.value = detail
      draft.title = detail.title
      draft.list = detail.list
      draft.due = detail.due
        ? new Date(detail.due).toISOString().slice(0, 10)
        : null
      draft.assignees = detail.assignees ?? []
      draft.labels = labelIdsOf(detail)
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
      const space = ws.overview.value?.spaces.find(
        (b) => b.key === detail.space,
      )
      listOptions.value = (space?.lists ?? []).map((l) => ({
        label: l.name,
        value: l.name,
      }))
      assigneeOptions.value = (ws.overview.value?.actors ?? [])
        .filter((a) => a.kind === 'human')
        .map((a) => ({ label: a.name, value: a.handle }))
      // Grouped, and in the catalogue's own order: the server already
      // returns labels by group and then by each group's arrangement, so
      // sorting anything here would undo ordered labels.
      labelOptions.value = labelGroups(ws.overview.value, detail.space).flatMap(
        (group) => [
          headingOption(group),
          ...group.labels.map((l) => ({ label: l.name, value: l.id })),
        ],
      )
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

  /**
   * A card's labels as ids. `label_ids` is what the server sends; the name
   * fallback is for a payload that predates it, where a bare name is the
   * best that can be done.
   */
  function labelIdsOf(detail: IItemDetail): string[] {
    if (detail.label_ids) return [...detail.label_ids]
    const byName = new Map<string, string>()
    for (const group of labelGroups(ws.overview.value, detail.space))
      for (const label of group.labels)
        if (!byName.has(label.name)) byName.set(label.name, label.id)
    return (detail.labels ?? []).map((name) => byName.get(name) ?? name)
  }

  /**
   * A group that names a single answer lets go of whatever it held when a
   * second value is picked, which is exactly what the server does on write.
   * Done here as well so the interface never shows two values from such a
   * group and then disagrees with itself after a reload.
   *
   * The survivor is the last one in the draft, because a multiple select
   * appends what was just picked: picking a second value means somebody
   * changed their mind, so the new one wins.
   */
  function pruneExclusive(ids: string[]): string[] {
    const catalogue = labelsById(ws.overview.value)
    const keep = new Map<string, string>()
    for (const id of ids) {
      const label = catalogue.get(id)
      if (!label?.exclusive) continue
      keep.set(label.groupId, id)
    }
    if (keep.size === 0) return ids
    return ids.filter((id) => {
      const label = catalogue.get(id)
      if (!label?.exclusive) return true
      return keep.get(label.groupId) === id
    })
  }

  function commitLabels(): void {
    const pruned = pruneExclusive(draft.labels)
    if (pruned.length !== draft.labels.length) draft.labels = pruned
    commitSet('label')
  }

  function commitSet(kind: 'assign' | 'label'): void {
    if (!item.value) return
    const current = kind === 'assign' ? draft.assignees : draft.labels
    const before = new Set(
      kind === 'assign' ? (item.value.assignees ?? []) : labelIdsOf(item.value),
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

  function checklistEntries(name: string): { text: string; done: boolean }[] {
    return (
      (item.value?.checklists ?? []).find(
        (cl) => cl.name.toLowerCase() === name.toLowerCase(),
      )?.items ?? []
    )
  }

  async function addChecklist(name: string): Promise<void> {
    if (!item.value || !name.trim()) return
    await write({
      op: 'checklist_set',
      op_id: newOpId(),
      key: item.value.key,
      checklist: name.trim(),
    })
  }

  async function addChecklistEntry(
    checklist: string,
    text: string,
  ): Promise<void> {
    if (!item.value || !text.trim()) return
    await write({
      op: 'checklist_set',
      op_id: newOpId(),
      key: item.value.key,
      checklist,
      items: [
        ...checklistEntries(checklist),
        { text: text.trim(), done: false },
      ],
    })
  }

  async function removeChecklistEntry(
    checklist: string,
    text: string,
  ): Promise<void> {
    if (!item.value) return
    await write({
      op: 'checklist_set',
      op_id: newOpId(),
      key: item.value.key,
      checklist,
      items: checklistEntries(checklist).filter((it) => it.text !== text),
    })
  }

  async function deleteChecklist(checklist: string): Promise<void> {
    if (!item.value) return
    await write({
      op: 'checklist_delete',
      op_id: newOpId(),
      key: item.value.key,
      checklist,
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

  /**
   * Editing and deleting a comment. Neither checks who is asking: the server
   * decides that and says so per comment (`can_edit` / `can_delete`), and it
   * refuses the op as well, so a stale flag costs a toast rather than a
   * silently applied change.
   */
  async function editComment(id: string, body: string): Promise<void> {
    if (!item.value) return
    await write({
      op: 'comment_update',
      op_id: newOpId(),
      key: item.value.key,
      comment_id: id,
      body,
    })
  }

  async function deleteComment(id: string): Promise<void> {
    if (!item.value) return
    const ok = await write({
      op: 'comment_delete',
      op_id: newOpId(),
      key: item.value.key,
      comment_id: id,
    })
    if (ok) toast.success('Comment deleted.')
  }

  /**
   * Permanent removal. The server refuses unless the item is archived, so
   * this is only ever reachable from an archived card; `deleted` lets the
   * caller close whatever was showing it.
   */
  const deleted = ref(false)

  async function remove(): Promise<boolean> {
    if (!item.value) return false
    saveError.value = ''
    // Deliberately not routed through `write`, which reloads the item after
    // every op. There is nothing left to reload, and doing so would answer a
    // successful delete with a "could not load this item" error panel.
    await save.run(async () => {
      const { results } = await api.itemWrite([
        { op: 'delete', op_id: newOpId(), key: item.value!.key },
      ])
      if (!results[0].ok)
        throw new Error((results[0] as { error: string }).error)
    })
    if (save.status.value === 'error') {
      saveError.value = humanise(save.error.value)
      return false
    }
    deleted.value = true
    toast.success('Card deleted.')
    return true
  }

  async function toggle(
    op: 'complete' | 'reopen' | 'archive' | 'restore',
  ): Promise<void> {
    if (!item.value) return
    const ok = await write({ op, op_id: newOpId(), key: item.value.key })
    if (ok && op === 'archive')
      toast.success(
        'Archived. Find it under the archived filter, where it can also be deleted.',
      )
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
    editComment,
    deleteComment,
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
    commitLabels,
    commitStatus,
    toggleCheck,
    addChecklist,
    addChecklistEntry,
    removeChecklistEntry,
    deleteChecklist,
    addComment,
    toggle,
    remove,
    deleted,
  }
}

<template>
  <div v-if="viewState === 'loading'" class="nb-inspector inspector-loading">
    <NbSkeleton variant="heading" label="Loading item" />
    <NbSkeleton variant="text" :lines="3" />
    <NbSkeleton variant="block" height="8rem" />
  </div>

  <NbEmptyState
    v-else-if="viewState === 'error'"
    size="sm"
    kind="error"
    title="Could not load this item"
    :description="loadMessage"
  >
    <template #actions>
      <NbButton size="xs" variant="secondary" @click="load">Retry</NbButton>
    </template>
  </NbEmptyState>

  <div v-else-if="item" class="nb-inspector">
    <NbShellPanel title="Details" fluid>
      <template #toolbar>
        <NbInlineLoading
          :status="save.status.value"
          label="Saving"
          finished-label="Saved"
          error-label="Not saved"
          :dwell="1200"
          reserve-space
        />
      </template>
      <div class="inspector-head">
        <span class="inspector-key">{{ item.key }}</span>
        <NbBadge
          v-if="lifecycle"
          :variant="lifecycle.variant"
          :dot="lifecycle.dot"
          size="md"
        >
          {{ lifecycle.text }}
        </NbBadge>
      </div>
      <NbBanner
        v-if="saveError"
        status="error"
        variant="inline"
        :title="saveError"
      />
      <div class="inspector-fields">
        <NbField label="Title" v-slot="{ id }">
          <NbTextInput
            :id="id"
            v-model="draft.title"
            size="sm"
            @blur="commitTitle"
          />
        </NbField>
        <NbField label="List" v-slot="{ id }">
          <NbSelect
            :id="id"
            v-model="draft.list"
            size="sm"
            :options="listOptions"
            @change="commitList"
          />
        </NbField>
        <NbField label="Due" v-slot="{ id }">
          <NbDatePicker
            :id="id"
            v-model="draft.due"
            size="sm"
            @change="commitDue"
          />
        </NbField>
        <NbField label="Assignees" v-slot="{ id }">
          <NbSelect
            :id="id"
            v-model="draft.assignees"
            size="sm"
            multiple
            :options="assigneeOptions"
            @change="commitAssignees"
          />
        </NbField>
        <NbField label="Labels" v-slot="{ id }">
          <NbSelect
            :id="id"
            v-model="draft.labels"
            size="sm"
            multiple
            :options="labelOptions"
            @change="commitLabels"
          />
        </NbField>
      </div>
    </NbShellPanel>

    <NbShellPanel title="Description" fluid>
      <NbField orientation="stack" label="Markdown" v-slot="{ id }">
        <NbTextInput
          :id="id"
          v-model="draft.description"
          multiline
          :rows="8"
          size="sm"
          @blur="commitDescription"
        />
      </NbField>
      <MarkdownView
        v-if="item.description"
        :source="item.description"
        class="inspector-preview"
      />
    </NbShellPanel>

    <NbShellPanel
      v-for="checklist in item.checklists ?? []"
      :key="checklist.name"
      :title="checklist.name"
      fluid
    >
      <template #toolbar>
        <span class="inspector-progress">
          {{ checklist.items.filter((entry) => entry.done).length }}/{{
            checklist.items.length
          }}
        </span>
      </template>
      <ul class="inspector-checklist">
        <li v-for="entry in checklist.items" :key="entry.text">
          <NbCheckbox
            :model-value="entry.done"
            :label="entry.text"
            @update:model-value="
              (done: boolean) => toggleCheck(checklist.name, entry.text, done)
            "
          />
        </li>
      </ul>
    </NbShellPanel>

    <NbShellPanel title="Comments" fill>
      <ul class="inspector-comments" aria-label="Comments">
        <li v-for="comment in item.comments ?? []" :key="comment.id">
          <div class="inspector-comment-head">
            <strong>@{{ comment.by }}</strong>
            <NbAiLabel v-if="comment.agent" />
            <time :datetime="new Date(comment.ts).toISOString()">
              {{ relativeTime(comment.ts) }}
            </time>
          </div>
          <MarkdownView :source="comment.body" />
        </li>
      </ul>
      <NbForm
        id="comment-form"
        class="inspector-composer"
        @submit.prevent="addComment"
      >
        <NbField orientation="stack" label="Add a comment" v-slot="{ id }">
          <NbTextInput
            :id="id"
            v-model="commentDraft"
            multiline
            :rows="2"
            size="sm"
            placeholder="[[@handle]] to mention"
          />
        </NbField>
        <template #footer>
          <NbButton
            type="submit"
            size="xs"
            variant="primary"
            :loading="commenting"
          >
            Comment
          </NbButton>
        </template>
      </NbForm>
    </NbShellPanel>

    <NbShellPanel v-if="linkFacts.length > 0" title="Links" fluid>
      <NbDefinitionList :items="linkFacts" layout="stacked" />
    </NbShellPanel>

    <footer class="inspector-actions">
      <NbButton
        size="xs"
        :variant="item.done ? 'secondary' : 'primary'"
        @click="toggle(item.done ? 'reopen' : 'complete')"
      >
        {{ item.done ? 'Reopen' : 'Complete' }}
      </NbButton>
      <NbButton
        size="xs"
        variant="ghost"
        outlined
        @click="toggle(item.archived ? 'restore' : 'archive')"
      >
        {{ item.archived ? 'Restore' : 'Archive' }}
      </NbButton>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onScopeDispose, reactive, ref, watch } from 'vue'
import {
  NbAiLabel,
  NbBadge,
  NbBanner,
  NbButton,
  NbCheckbox,
  NbDatePicker,
  NbDefinitionList,
  NbEmptyState,
  NbField,
  NbForm,
  NbInlineLoading,
  NbSelect,
  NbShellPanel,
  NbSkeleton,
  NbTextInput,
  useInlineLoading,
  useToast,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import type { IItemDetail, TViewState } from '@/types/api'
import { humanise, relativeTime } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import MarkdownView from '@/components/MarkdownView.vue'

const props = defineProps<{ itemKey: string }>()

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
})

const listOptions = ref<{ label: string; value: string }[]>([])
const assigneeOptions = ref<{ label: string; value: string }[]>([])
const labelOptions = ref<{ label: string; value: string }[]>([])

const lifecycle = ref<{
  text: string
  variant: 'green' | 'grey' | 'orange'
  dot: boolean
} | null>(null)

function computeLifecycle(detail: IItemDetail): void {
  if (detail.archived)
    lifecycle.value = { text: 'Archived', variant: 'grey', dot: false }
  else if (detail.done)
    lifecycle.value = { text: 'Done', variant: 'green', dot: false }
  else if (detail.due && detail.due < Date.now())
    lifecycle.value = { text: 'Overdue', variant: 'orange', dot: true }
  else lifecycle.value = { text: 'Open', variant: 'green', dot: true }
}

const linkFacts = ref<{ term: string; value: string }[]>([])

async function load(): Promise<void> {
  viewState.value = 'loading'
  try {
    const { items } = await api.itemGet([props.itemKey])
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
    const board = ws.overview.value?.boards.find((b) => b.key === detail.board)
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

watch(() => props.itemKey, load, { immediate: true })
onScopeDispose(
  ws.onLive((event) => {
    if (event.entity === 'item' && event.actor_kind !== 'human') void load()
  }),
)

type TWriteOp = Parameters<typeof api.itemWrite>[0][number]

async function write(op: TWriteOp): Promise<boolean> {
  saveError.value = ''
  const ok = await save.run(async () => {
    const { results } = await api.itemWrite([op])
    if (!results[0].ok) {
      throw new Error((results[0] as { error: string }).error)
    }
  })
  if (ok === undefined && save.status.value === 'error') {
    saveError.value =
      save.error.value instanceof Error &&
      save.error.value.message.includes('conflict')
        ? 'Someone else changed this item; reloaded with their version'
        : humanise(save.error.value)
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

function commitAssignees(): void {
  if (!item.value) return
  const before = new Set(item.value.assignees ?? [])
  const after = new Set(draft.assignees)
  const add = [...after].filter((a) => !before.has(a))
  const remove = [...before].filter((a) => !after.has(a))
  if (add.length === 0 && remove.length === 0) return
  void write({
    op: 'assign',
    op_id: newOpId(),
    key: item.value.key,
    add: add.length > 0 ? add : undefined,
    remove: remove.length > 0 ? remove : undefined,
  })
}

function commitLabels(): void {
  if (!item.value) return
  const before = new Set(item.value.labels ?? [])
  const after = new Set(draft.labels)
  const add = [...after].filter((l) => !before.has(l))
  const remove = [...before].filter((l) => !after.has(l))
  if (add.length === 0 && remove.length === 0) return
  void write({
    op: 'label',
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
</script>

<style scoped lang="scss">
.inspector-loading {
  display: grid;
  gap: var(--nb-spacing-12);
  padding: var(--nb-spacing-16);
}

.inspector-head {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  margin-block-end: var(--nb-spacing-12);
}

.inspector-key {
  font-family: var(--nb-font-family-mono);
  font-size: var(--nb-type-code-sm-size);
  color: var(--nb-c-text-subtle);
}

.inspector-fields {
  display: grid;
  gap: var(--nb-spacing-8);
}

.inspector-preview {
  margin-block-start: var(--nb-spacing-12);
}

.inspector-progress {
  font-size: var(--nb-type-label-sm-size);
  color: var(--nb-c-text-muted);
}

.inspector-checklist,
.inspector-comments {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--nb-spacing-8);
}

.inspector-comment-head {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  font-size: var(--nb-type-label-sm-size);

  time {
    color: var(--nb-c-text-subtle);
  }
}

.inspector-composer {
  margin-block-start: var(--nb-spacing-12);
}

.inspector-actions {
  display: flex;
  gap: var(--nb-spacing-8);
  padding: var(--nb-spacing-16);
  border-block-start: 1px solid var(--nb-c-border);
}
</style>

<template>
  <div class="board">
    <component :is="filterBar.Outlet">
      <div class="board__filters" role="search" aria-label="Filter items">
        <NbForm
          id="board-composer"
          aria-label="Add item"
          @submit.prevent="createItem"
        >
          <div class="board__composer">
            <NbTextInput
              id="field-new-item"
              v-model="newTitle"
              size="sm"
              placeholder="Add an item..."
              aria-label="New item title"
            />
            <NbButton
              type="submit"
              size="sm"
              variant="primary"
              icon="plus"
              :loading="creating"
            >
              Add item
            </NbButton>
          </div>
        </NbForm>
        <NbSelect
          id="field-filter-label"
          v-model="labelFilter"
          size="sm"
          :options="labelOptions"
          placeholder="Label"
        />
        <NbSelect
          id="field-filter-assignee"
          v-model="assigneeFilter"
          size="sm"
          :options="assigneeOptions"
          placeholder="Assignee"
        />
        <NbSelect
          id="field-filter-state"
          v-model="stateFilter"
          size="sm"
          :options="stateOptions"
        />
        <NbTextInput
          id="field-filter-text"
          v-model="textFilter"
          size="sm"
          placeholder="Filter text..."
        />
      </div>
    </component>

    <div v-if="load.state.value === 'loading'" class="board__skeleton">
      <NbSkeleton
        v-for="index in 4"
        :key="index"
        variant="block"
        height="14rem"
        :label="index === 1 ? 'Loading board' : undefined"
      />
    </div>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load this board"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="loadItems">Retry</NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="items.length === 0 && filtersActive"
      kind="no-results"
      title="Nothing matches these filters"
      description="Items exist on this board, but none match the current filters."
    >
      <template #actions>
        <NbButton variant="secondary" @click="clearFilters">
          Clear filters
        </NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="items.length === 0" class="board__empty">
      <NbEmptyState
        title="No items yet"
        description="Items move across this board's lists as work progresses."
      >
        <template #actions>
          <NbButton variant="primary" icon="plus" @click="focusComposer">
            Add the first item
          </NbButton>
        </template>
      </NbEmptyState>
    </div>

    <NbBoard v-else :columns="columns" :items="boardItems" @move="onMove">
      <template #card="{ item }">
        <button
          class="board__card"
          type="button"
          @click="inspector.open(String(item.key))"
        >
          <span class="board__card-title">
            <s v-if="item.done">{{ item.title }}</s>
            <template v-else>{{ item.title }}</template>
          </span>
          <span class="board__card-meta">
            <span class="board__card-key">{{ item.key }}</span>
            <NbBadge
              v-for="label in (item.labels as string[]) ?? []"
              :key="label"
              size="sm"
              variant="grey"
            >
              {{ label }}
            </NbBadge>
            <span
              v-if="item.chk"
              class="board__card-chip"
              :aria-label="`Checklist ${item.chk}`"
            >
              <NbIcon name="check-square" /> {{ item.chk }}
            </span>
            <span
              v-if="item.cmts"
              class="board__card-chip"
              :aria-label="`${item.cmts} comments`"
            >
              <NbIcon name="chat-circle" /> {{ item.cmts }}
            </span>
            <span
              v-for="assignee in (item.assignees as string[]) ?? []"
              :key="assignee"
              class="board__card-chip"
            >
              @{{ assignee }}
            </span>
          </span>
        </button>
      </template>
    </NbBoard>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import {
  NbBadge,
  NbBoard,
  NbButton,
  NbEmptyState,
  NbForm,
  NbIcon,
  NbSelect,
  NbSkeleton,
  NbTextInput,
  useShellSlot,
  useToast,
  type IBoardItem,
  type IBoardMoveEvent,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import type { IBoardItemRow } from '@/types/api'
import { humanise, useLoadState } from '@/lib/state'
import { useInspector, useWorkspace } from '@/stores/workspace'

const props = defineProps<{ boardKey?: string }>()

const ws = useWorkspace()
const inspector = useInspector()
const toast = useToast()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')

const items = ref<IBoardItemRow[]>([])
const labelFilter = ref('')
const assigneeFilter = ref('')
const stateFilter = ref('open')
const textFilter = ref('')
const newTitle = ref('')
const creating = ref(false)

const boardKey = computed(() => props.boardKey ?? '')
const boardMeta = computed(() =>
  ws.overview.value?.boards.find((b) => b.key === boardKey.value),
)
const filtersActive = computed(
  () =>
    labelFilter.value !== '' ||
    assigneeFilter.value !== '' ||
    textFilter.value !== '' ||
    stateFilter.value !== 'open',
)

const columns = computed(() =>
  (boardMeta.value?.lists ?? []).map((list) => ({
    id: list.name,
    label: list.name,
    color: roleColor(list.role),
  })),
)

function roleColor(role?: string): string | undefined {
  switch (role) {
    case 'active':
      return 'var(--nb-c-primary)'
    case 'blocked':
      return 'var(--nb-c-status-error)'
    case 'review':
      return 'var(--nb-c-status-warning)'
    case 'done':
      return 'var(--nb-c-status-valid)'
    default:
      return undefined
  }
}

const boardItems = computed<IBoardItem[]>(() =>
  items.value.map((row) => ({ id: row.key, columnId: row.list, ...row })),
)

const labelOptions = computed(() => [
  { label: 'All labels', value: '' },
  ...(ws.overview.value?.labels ?? [])
    .filter((l) => l.board_key === null || l.board_key === boardKey.value)
    .map((l) => ({ label: l.name, value: l.name })),
])

const assigneeOptions = computed(() => [
  { label: 'Anyone', value: '' },
  ...(ws.overview.value?.actors ?? [])
    .filter((a) => a.kind === 'human')
    .map((a) => ({ label: `@${a.handle}`, value: a.handle })),
])

const stateOptions = [
  { label: 'Open', value: 'open' },
  { label: 'Done', value: 'done' },
  { label: 'Archived', value: 'archived' },
  { label: 'All', value: 'all' },
]

async function loadItems(): Promise<void> {
  if (!boardKey.value) return
  const params: Record<string, string> = {
    state: stateFilter.value,
    limit: '200',
  }
  if (labelFilter.value) params.label = labelFilter.value
  if (assigneeFilter.value) params.assignee = assigneeFilter.value
  if (textFilter.value) params.text = textFilter.value
  const result = await load.run(api.boardGet(boardKey.value, params))
  if (result) items.value = result.items
}

watch([boardKey, labelFilter, assigneeFilter, stateFilter], loadItems, {
  immediate: true,
})

let textDebounce: ReturnType<typeof setTimeout> | undefined
watch(textFilter, () => {
  clearTimeout(textDebounce)
  textDebounce = setTimeout(loadItems, 250)
})

onScopeDispose(
  ws.onLive((event) => {
    if (event.entity === 'item' && event.actor_kind !== 'human')
      void loadItems()
  }),
)

function clearFilters(): void {
  labelFilter.value = ''
  assigneeFilter.value = ''
  textFilter.value = ''
  stateFilter.value = 'open'
}

function focusComposer(): void {
  document.getElementById('field-new-item')?.focus()
}

async function onMove(event: IBoardMoveEvent): Promise<void> {
  const row = items.value.find((r) => r.key === event.itemId)
  if (!row) return
  const previousList = row.list
  row.list = event.toColumnId
  try {
    const { results } = await api.itemWrite([
      { op: 'move', op_id: newOpId(), key: row.key, list: event.toColumnId },
    ])
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
  } catch (err) {
    row.list = previousList
    toast.error(humanise(err), { title: 'Move failed' })
  }
  await loadItems()
}

async function createItem(): Promise<void> {
  const title = newTitle.value.trim()
  if (!title || !boardMeta.value) return
  creating.value = true
  const backlog =
    boardMeta.value.lists.find((l) => l.role === 'backlog') ??
    boardMeta.value.lists[0]
  try {
    const { results } = await api.itemWrite(
      [{ op: 'create', op_id: newOpId(), list: backlog.name, title }],
      boardKey.value,
    )
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
    newTitle.value = ''
    await loadItems()
    await ws.refresh()
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not add the item' })
  } finally {
    creating.value = false
  }
}
</script>

<style scoped lang="scss">
.board {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  &__filters {
    display: flex;
    gap: var(--nb-spacing-8);
    flex-wrap: wrap;
    padding-block: var(--nb-spacing-8);
  }

  &__composer {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__skeleton {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--nb-spacing-16);
  }

  &__empty {
    min-height: 24rem;
    padding-block: var(--nb-spacing-24);
  }

  &__card {
    background: none;
    border: 0;
    padding: 0;
    text-align: start;
    display: grid;
    gap: var(--nb-spacing-4);
    cursor: pointer;
    width: 100%;
    color: inherit;
    font: inherit;

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
      outline-offset: 2px;
    }
  }

  &__card-title {
    font-weight: var(--nb-type-label-lg-weight, 500);
  }

  &__card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nb-spacing-4);
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-muted);
  }

  &__card-key {
    font-family: var(--nb-font-family-mono);
    color: var(--nb-c-text-subtle);
  }

  &__card-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-2);
  }
}
</style>

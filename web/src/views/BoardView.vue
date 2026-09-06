<template>
  <div class="board">
    <!-- Adding lives in the shell topbar (always present) and at the foot of
         every column (adds in place); the title is asked for in the modal, so
         the filter bar is purely filters. -->
    <component :is="topbarActions.Outlet">
      <NbButton size="sm" variant="primary" icon="plus" @click="openNewItem()">
        Add item
      </NbButton>
    </component>

    <component :is="filterBar.Outlet">
      <div class="board__filters" role="search" aria-label="Filter items">
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
          <NbButton variant="primary" icon="plus" @click="openNewItem()">
            Add the first item
          </NbButton>
        </template>
      </NbEmptyState>
    </div>

    <NbBoard v-else :columns="columns" :items="boardItems" @move="onMove">
      <template #column-footer="{ column }">
        <NbButton
          size="sm"
          variant="ghost"
          icon="plus"
          class="board__col-add"
          @click="openNewItem(String(column.id))"
        >
          Add item
        </NbButton>
      </template>
      <template #card="{ item }">
        <button
          class="board__card"
          type="button"
          @click="inspector.open(String(item.key))"
          @dblclick="openItemModal(String(item.key))"
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
              :variant="variants.get(label) ?? 'grey'"
            >
              {{ label }}
            </NbBadge>
            <NbBadge
              v-if="item.due && !item.done && Number(item.due) < Date.now()"
              size="sm"
              variant="orange"
              dot
            >
              Overdue
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
            <ActorAvatar
              v-for="assignee in (item.assignees as string[]) ?? []"
              :key="assignee"
              :handle="assignee"
            />
          </span>
        </button>
      </template>
    </NbBoard>

    <NewItemModal
      :open="newItemOpen"
      :board-key="boardKey"
      :lists="boardMeta?.lists ?? []"
      :list="newItemList"
      @close="newItemOpen = false"
      @created="onItemCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import {
  NbBadge,
  NbBoard,
  NbButton,
  NbEmptyState,
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
import { labelVariants } from '@/lib/labels'
import { roleColor } from '@/lib/colors'
import { useInspector, useUiState, useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import NewItemModal from '@/components/NewItemModal.vue'

const props = defineProps<{ boardKey?: string }>()

const ws = useWorkspace()
const inspector = useInspector()
const ui = useUiState()

/* A dblclick always fires the click handler first, which opens the
 * inspector; close it again so the modal stands alone. */
function openItemModal(key: string): void {
  inspector.close()
  ui.itemModalKey.value = key
}
const variants = computed(() => labelVariants(ws.overview.value))
const toast = useToast()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')
const topbarActions = useShellSlot('topbar-right')

const items = ref<IBoardItemRow[]>([])
const labelFilter = ref('')
const assigneeFilter = ref('')
const stateFilter = ref('open')
const textFilter = ref('')

/* The new-item modal, and which list it creates into: a column footer names
 * its own column, the topbar button leaves it to the modal's backlog default. */
const newItemOpen = ref(false)
const newItemList = ref<string | undefined>(undefined)

function openNewItem(list?: string): void {
  newItemList.value = list
  newItemOpen.value = true
}

async function onItemCreated(key: string): Promise<void> {
  newItemOpen.value = false
  await loadItems()
  await ws.refresh()
  // Carry straight on: the item exists, the inspector is where the rest of
  // it (labels, assignees, description) gets filled in.
  if (key) inspector.open(key)
}

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
</script>

<style scoped lang="scss">
.board {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  /* Trello-parity column width: fixed-ish tracks, board scrolls
   * horizontally instead of stretching a few columns across the screen. */
  --nb-board-column-track: minmax(272px, 340px);

  &__filters {
    display: flex;
    gap: var(--nb-spacing-8);
    flex-wrap: wrap;
    padding-block: var(--nb-spacing-8);
  }

  /* Full-width and quiet: present in every column without shouting in any. */
  &__col-add {
    width: 100%;
    justify-content: flex-start;
    color: var(--nb-c-text-muted);
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

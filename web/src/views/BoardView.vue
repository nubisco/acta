<template>
  <div class="board">
    <header class="board__header">
      <h1>{{ boardMeta?.name ?? props.boardKey }}</h1>
      <div class="board__filters">
        <NbSelect
          v-model="labelFilter"
          :options="labelOptions"
          placeholder="Label"
        />
        <NbSelect
          v-model="assigneeFilter"
          :options="assigneeOptions"
          placeholder="Assignee"
        />
        <NbSelect v-model="stateFilter" :options="stateOptions" />
        <NbTextInput v-model="textFilter" placeholder="Filter text..." />
      </div>
    </header>

    <NbBoard :columns="columns" :items="boardItems" @move="onMove">
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
            <NbLabel
              v-for="label in (item.labels as string[]) ?? []"
              :key="label"
              :text="label"
              compact
            />
            <span v-if="item.chk" class="board__card-chip">
              <NbIcon name="check-square" /> {{ item.chk }}
            </span>
            <span v-if="item.cmts" class="board__card-chip">
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

    <div class="board__composer">
      <NbTextInput
        v-model="newTitle"
        placeholder="Add an item to Backlog... (Enter to create)"
        @keyup.enter="createItem"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NbBoard,
  NbIcon,
  NbLabel,
  NbSelect,
  NbTextInput,
  useToast,
  type IBoardItem,
  type IBoardMoveEvent,
} from '@nubisco/ui'
import { api, newOpId, type IBoardItemRow } from '@/api/client'
import { useInspector, useWorkspace } from '@/stores/workspace'

const props = defineProps<{ boardKey?: string }>()

const ws = useWorkspace()
const inspector = useInspector()
const toast = useToast()

const items = ref<IBoardItemRow[]>([])
const labelFilter = ref('')
const assigneeFilter = ref('')
const stateFilter = ref('open')
const textFilter = ref('')
const newTitle = ref('')

const boardKey = computed(() => props.boardKey ?? '')
const boardMeta = computed(() =>
  ws.overview.value?.boards.find((b) => b.key === boardKey.value),
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
      return 'var(--nb-c-danger, #c33)'
    case 'review':
      return 'var(--nb-c-warning, #d90)'
    case 'done':
      return 'var(--nb-c-success, #2a2)'
    default:
      return undefined
  }
}

const boardItems = computed<IBoardItem[]>(() =>
  items.value.map((row) => ({
    id: row.key,
    columnId: row.list,
    ...row,
  })),
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

async function load(): Promise<void> {
  if (!boardKey.value) return
  const params: Record<string, string> = {
    state: stateFilter.value,
    limit: '200',
  }
  if (labelFilter.value) params.label = labelFilter.value
  if (assigneeFilter.value) params.assignee = assigneeFilter.value
  if (textFilter.value) params.text = textFilter.value
  const res = await api.boardGet(boardKey.value, params)
  items.value = res.items
}

watch([boardKey, labelFilter, assigneeFilter, stateFilter], load, {
  immediate: true,
})

let textDebounce: ReturnType<typeof setTimeout> | undefined
watch(textFilter, () => {
  clearTimeout(textDebounce)
  textDebounce = setTimeout(load, 250)
})

ws.onLive((event) => {
  if (event.entity === 'item' && event.actor_kind !== 'human') void load()
})

async function onMove(event: IBoardMoveEvent): Promise<void> {
  const row = items.value.find((r) => r.key === event.itemId)
  if (!row) return
  row.list = event.toColumnId // optimistic
  const { results } = await api.itemWrite([
    { op: 'move', op_id: newOpId(), key: row.key, list: event.toColumnId },
  ])
  if (!results[0].ok) {
    toast.error(String((results[0] as { error: string }).error))
  }
  await load()
}

async function createItem(): Promise<void> {
  const title = newTitle.value.trim()
  if (!title || !boardMeta.value) return
  newTitle.value = ''
  const backlog =
    boardMeta.value.lists.find((l) => l.role === 'backlog') ??
    boardMeta.value.lists[0]
  const { results } = await api.itemWrite(
    [{ op: 'create', op_id: newOpId(), list: backlog.name, title }],
    boardKey.value,
  )
  if (!results[0].ok)
    toast.error(String((results[0] as { error: string }).error))
  await load()
  await ws.refresh()
}
</script>

<style scoped lang="scss">
.board {
  display: grid;
  gap: calc(var(--nb-base-unit) * 2);
  align-content: start;
  min-height: 100%;

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(var(--nb-base-unit) * 2);
    flex-wrap: wrap;

    h1 {
      margin: 0;
    }
  }

  &__filters {
    display: flex;
    gap: var(--nb-base-unit);
    flex-wrap: wrap;
  }

  &__card {
    all: unset;
    display: grid;
    gap: calc(var(--nb-base-unit) / 2);
    cursor: pointer;
    width: 100%;
    box-sizing: border-box;
  }

  &__card-title {
    font-weight: 500;
  }

  &__card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: calc(var(--nb-base-unit) / 2);
    font-size: 0.75rem;
    opacity: 0.85;
  }

  &__card-key {
    font-family: var(--nb-font-mono, monospace);
    opacity: 0.6;
  }

  &__card-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  &__composer {
    max-width: 24rem;
  }
}
</style>

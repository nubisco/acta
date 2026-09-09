<template>
  <NbDataTable
    :columns="columns"
    :rows="rows"
    row-key="key"
    size="sm"
    aria-label="Items"
    :sort-state="sort"
    @sort="onSort"
    @row-click="(row) => emit('open', String((row as IRow).key))"
  >
    <template #cell-title="{ row }">
      <span class="tbl__title">
        <s v-if="(row as IRow).done">{{ (row as IRow).title }}</s>
        <template v-else>{{ (row as IRow).title }}</template>
      </span>
    </template>
    <template #cell-labels="{ row }">
      <span class="tbl__labels">
        <NbBadge
          v-for="label in (row as IRow).labelList"
          :key="label"
          size="sm"
          :variant="variants.get(label) ?? 'grey'"
        >
          {{ label }}
        </NbBadge>
      </span>
    </template>
    <template #cell-assignees="{ row }">
      <span class="tbl__people">
        <ActorAvatar
          v-for="handle in (row as IRow).assigneeList"
          :key="handle"
          :handle="handle"
          :size="18"
        />
      </span>
    </template>
    <template #empty>
      <NbEmptyState
        size="sm"
        title="Nothing here"
        description="No items match the current filters."
      />
    </template>
  </NbDataTable>
</template>

<script setup lang="ts">
/**
 * The board as a table. Every column sorts, which is the whole reason to
 * offer this view: a board answers "what is in flight", a table answers
 * "what is oldest, what is due first, who has the most".
 */
import { computed, ref } from 'vue'
import type { IBoardItemRow } from '@/types/api'
import { relativeTime } from '@/lib/state'
import ActorAvatar from '@/components/ActorAvatar.vue'

interface IRow extends Record<string, unknown> {
  key: string
  title: string
  list: string
  labelList: string[]
  assigneeList: string[]
  due: string
  dueAt: number
  updated: string
  updatedAt: number
  done?: boolean
}

const props = defineProps<{
  items: IBoardItemRow[]
  variants: Map<string, string>
}>()
const emit = defineEmits<{ open: [key: string] }>()

const variants = computed(
  () => props.variants as unknown as Map<string, 'grey'>,
)

const columns = [
  { key: 'key', header: 'Key', sortable: true, width: '7rem' },
  { key: 'title', header: 'Title', sortable: true },
  { key: 'list', header: 'List', sortable: true, width: '10rem' },
  { key: 'labels', header: 'Labels', width: '12rem' },
  { key: 'assignees', header: 'Assignees', width: '8rem' },
  { key: 'due', header: 'Due', sortable: true, width: '8rem' },
  { key: 'updated', header: 'Updated', sortable: true, width: '9rem' },
]

const sort = ref<{ key: string; direction: 'asc' | 'desc' } | null>(null)

/**
 * NbDataTable is controlled: it reports the click and reflects whatever state
 * it is given back, so the ascending/descending cycle lives here. Without
 * feeding `sortState` back the header never shows which column is sorted and
 * `aria-sort` stays "none".
 */
function onSort(state: unknown): void {
  const next = state as { key?: string; direction?: string } | null
  if (!next?.key || next.direction === 'none') {
    sort.value = null
    return
  }
  const direction =
    next.direction === 'asc' || next.direction === 'desc'
      ? next.direction
      : sort.value?.key === next.key && sort.value.direction === 'asc'
        ? 'desc'
        : 'asc'
  sort.value = { key: next.key, direction }
}

/**
 * Sorting happens here rather than in the table because the visible text and
 * the sortable value differ: "in 3 days" must order by timestamp, and a
 * missing due date has to sort last in both directions rather than reading as
 * the year 1970.
 */
const rows = computed<IRow[]>(() => {
  const mapped: IRow[] = props.items.map((item) => ({
    key: item.key,
    title: item.title,
    list: item.list,
    labelList: item.labels ?? [],
    assigneeList: item.assignees ?? [],
    labels: (item.labels ?? []).join(', '),
    assignees: (item.assignees ?? []).join(', '),
    due: item.due ? relativeTime(item.due) : '',
    dueAt: item.due ?? Number.POSITIVE_INFINITY,
    updated: relativeTime(item.updated),
    updatedAt: item.updated,
    done: item.done,
  }))
  const active = sort.value
  if (!active) return mapped
  const factor = active.direction === 'desc' ? -1 : 1
  const numeric: Record<string, keyof IRow> = {
    due: 'dueAt',
    updated: 'updatedAt',
  }
  const field = numeric[active.key] ?? (active.key as keyof IRow)

  // A missing due date is an absence, not a value, so it sorts last whichever
  // way the column points. Representing it as +Infinity and letting the
  // direction multiplier flip it would put "no answer" at the top of a
  // descending list, which is the least useful place for it.
  const absent = (row: IRow) =>
    row[field] === Number.POSITIVE_INFINITY || row[field] === ''
  const present = mapped.filter((row) => !absent(row))
  const missing = mapped.filter(absent)

  present.sort((a, b) => {
    const left = a[field]
    const right = b[field]
    if (typeof left === 'number' && typeof right === 'number')
      return (left - right) * factor
    return String(left).localeCompare(String(right)) * factor
  })
  return [...present, ...missing]
})
</script>

<style scoped lang="scss">
.tbl {
  &__labels,
  &__people {
    display: inline-flex;
    gap: var(--nb-spacing-4);
    flex-wrap: wrap;
    align-items: center;
  }

  &__title {
    display: block;
    min-inline-size: 0;
  }
}
</style>

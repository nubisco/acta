<template>
  <div class="activity-view">
    <h1 class="type-heading-03">Activity</h1>

    <component :is="filterBar.Outlet">
      <div class="activity-view__filters">
        <ActorFilter v-model="actorFilter" label="Filter activity by person" />
      </div>
    </component>

    <NbBanner
      v-if="pendingCount > 0"
      status="info"
      variant="inline"
      :title="`${pendingCount} new ${pendingCount === 1 ? 'event' : 'events'}`"
    >
      <template #action>
        <NbButton size="sm" variant="secondary" @click="refresh">
          Refresh
        </NbButton>
      </template>
    </NbBanner>

    <div v-if="load.state.value === 'loading'" class="activity-view__loading">
      <NbSkeleton variant="text" :lines="8" label="Loading activity" />
    </div>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load activity"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="refresh">Retry</NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="events.length === 0 && actorFilter.length > 0"
      kind="no-results"
      title="Nothing from those people"
      description="Events exist, but none from the people selected above."
    >
      <template #actions>
        <NbButton variant="secondary" @click="actorFilter = []">
          Show everyone
        </NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="events.length === 0"
      title="No activity yet"
      description="Every change made by a person, an agent, or a rule appears here."
    />

    <template v-else>
      <NbDataTable
        :columns="columns"
        :rows="rows"
        row-key="id"
        size="sm"
        aria-label="Activity"
        :sort-state="sort"
        @sort="onSort"
      >
        <template #cell-who="{ row }">
          <span class="activity-view__who">
            <ActorAvatar
              v-if="(row as IRow).handle"
              :handle="(row as IRow).handle"
              :size="22"
            />
            {{ (row as IRow).who }}
          </span>
        </template>
        <template #cell-when="{ row }">
          <time
            v-nb-tooltip="{ body: absoluteTime((row as IRow).ts) }"
            :datetime="new Date((row as IRow).ts).toISOString()"
          >
            {{ (row as IRow).when }}
          </time>
        </template>
      </NbDataTable>
      <NbButton
        v-if="cursor"
        variant="secondary"
        :loading="loadingMore"
        @click="loadMore"
      >
        Load more
      </NbButton>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useShellSlot } from '@nubisco/ui'
import { api } from '@/api/client'
import type { IEventRow } from '@/types/api'
import { absoluteTime, relativeTime, useLoadState } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import ActorFilter from '@/components/ActorFilter.vue'

const ws = useWorkspace()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')

const events = ref<IEventRow[]>([])
const cursor = ref<string | undefined>()
const actorFilter = ref<string[]>([])
const sort = ref<{ key: string; direction: 'asc' | 'desc' } | null>(null)
const pendingCount = ref(0)
const loadingMore = ref(false)

const columns = [
  { key: 'when', header: 'When', sortable: true, width: '10rem' },
  { key: 'who', header: 'Who', sortable: true, width: '14rem' },
  { key: 'what', header: 'What', sortable: true },
]

interface IRow extends Record<string, unknown> {
  id: string
  ts: number
  when: string
  who: string
  handle: string
  what: string
}

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
 * Sorting applies to everything loaded, not to the whole log: the feed is
 * paginated by cursor, so "oldest first" means the oldest of what you have
 * pulled in. Load more, and the sort covers more.
 */
const rows = computed<IRow[]>(() => {
  const mapped: IRow[] = events.value.map((event) => {
    const actor = ws.overview.value?.actors.find((a) => a.id === event.actor_id)
    return {
      id: event.id,
      ts: event.ts,
      when: relativeTime(event.ts),
      who: actor?.name ?? 'Acta',
      handle: actor?.handle ?? '',
      what: event.summary,
    }
  })
  const active = sort.value
  if (!active) return mapped
  const factor = active.direction === 'desc' ? -1 : 1
  const field = active.key === 'when' ? 'ts' : active.key
  return [...mapped].sort((a, b) => {
    const left = a[field as keyof IRow]
    const right = b[field as keyof IRow]
    if (typeof left === 'number' && typeof right === 'number')
      return (left - right) * factor
    return String(left).localeCompare(String(right)) * factor
  })
})

function params(): Record<string, string> {
  const out: Record<string, string> = { limit: '50' }
  if (actorFilter.value.length > 0) out.actor = actorFilter.value.join(',')
  return out
}

async function refresh(): Promise<void> {
  pendingCount.value = 0
  const result = await load.run(api.activity(params()))
  if (result) {
    events.value = result.events
    cursor.value = result.cursor
  }
}

async function loadMore(): Promise<void> {
  if (!cursor.value) return
  loadingMore.value = true
  try {
    const result = await api.activity({ ...params(), cursor: cursor.value })
    events.value = [...events.value, ...result.events]
    cursor.value = result.cursor
  } finally {
    loadingMore.value = false
  }
}

watch(actorFilter, () => void refresh(), { immediate: true, deep: true })

onScopeDispose(
  ws.onLive(() => {
    pendingCount.value += 1
  }),
)
</script>

<style scoped lang="scss">
.activity-view {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  h1 {
    margin: 0;
  }

  &__who {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__filters {
    padding-block: var(--nb-spacing-8);
  }

  /* The feed stretches; standalone actions (Load more) do not. */
  > .nb-button {
    justify-self: start;
  }
}
</style>

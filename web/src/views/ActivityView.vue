<template>
  <div class="activity-view">
    <h1>Activity</h1>

    <component :is="filterBar.Outlet">
      <div class="activity-view__filters">
        <NbSelect
          id="field-activity-kind"
          v-model="kindFilter"
          size="sm"
          :options="kindOptions"
        />
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
      v-else-if="events.length === 0 && kindFilter !== ''"
      kind="no-results"
      title="No activity from that group"
      description="Events exist, but none from the selected actor kind."
    >
      <template #actions>
        <NbButton variant="secondary" @click="kindFilter = ''">
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
      <ActivityList :events="events" />
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
import { onScopeDispose, ref, watch } from 'vue'
import {
  NbBanner,
  NbButton,
  NbEmptyState,
  NbSelect,
  NbSkeleton,
  useShellSlot,
} from '@nubisco/ui'
import { api } from '@/api/client'
import type { IEventRow } from '@/types/api'
import { useLoadState } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import ActivityList from '@/components/ActivityList.vue'

const ws = useWorkspace()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')

const events = ref<IEventRow[]>([])
const cursor = ref<string | undefined>()
const kindFilter = ref('')
const pendingCount = ref(0)
const loadingMore = ref(false)

const kindOptions = [
  { label: 'Everyone', value: '' },
  { label: 'Humans', value: 'human' },
  { label: 'Agents', value: 'agent' },
  { label: 'Rules', value: 'system' },
]

function params(): Record<string, string> {
  const out: Record<string, string> = { limit: '50' }
  if (kindFilter.value) out.actor_kind = kindFilter.value
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

watch(kindFilter, () => void refresh(), { immediate: true })

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
  justify-items: start;

  h1 {
    margin: 0;
  }

  &__filters {
    padding-block: var(--nb-spacing-8);
  }

  &__loading {
    justify-self: stretch;
  }
}
</style>

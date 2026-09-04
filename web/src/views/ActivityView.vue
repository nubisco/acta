<template>
  <div class="activity-view">
    <header>
      <h1>Activity</h1>
      <NbSelect v-model="kindFilter" :options="kindOptions" />
    </header>
    <ActivityList :events="events" />
    <NbButton v-if="cursor" variant="ghost" @click="loadMore"
      >Load more</NbButton
    >
    <NbEmptyState
      v-if="events.length === 0"
      title="No activity yet"
      description=""
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { NbButton, NbEmptyState, NbSelect } from '@nubisco/ui'
import { api, type IEventRow } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import ActivityList from '@/components/ActivityList.vue'

const ws = useWorkspace()
const events = ref<IEventRow[]>([])
const cursor = ref<string | undefined>()
const kindFilter = ref('')

const kindOptions = [
  { label: 'Everyone', value: '' },
  { label: 'Humans', value: 'human' },
  { label: 'Agents', value: 'agent' },
  { label: 'Rules', value: 'system' },
]

async function load(reset = true): Promise<void> {
  const params: Record<string, string> = { limit: '50' }
  if (kindFilter.value) params.actor_kind = kindFilter.value
  if (!reset && cursor.value) params.cursor = cursor.value
  const res = await api.activity(params)
  events.value = reset ? res.events : [...events.value, ...res.events]
  cursor.value = res.cursor
}

watch(kindFilter, () => void load(), { immediate: true })
ws.onLive(() => void load())

function loadMore(): void {
  void load(false)
}
</script>

<style scoped lang="scss">
.activity-view {
  display: grid;
  gap: calc(var(--nb-base-unit) * 2);
  align-content: start;

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;

    h1 {
      margin: 0;
    }
  }
}
</style>

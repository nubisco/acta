<template>
  <ul class="activity">
    <li v-for="event in events" :key="event.id">
      <NbAiLabel v-if="event.actor_kind === 'agent'" />
      <NbIcon
        v-else-if="event.actor_kind === 'system'"
        name="gear"
        class="activity__system"
      />
      <span class="activity__summary">{{ event.summary }}</span>
      <span v-if="event.caused_by" class="activity__rule">rule</span>
      <time class="activity__time">{{ relative(event.ts) }}</time>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { NbAiLabel, NbIcon } from '@nubisco/ui'
import type { IEventRow } from '@/api/client'

defineProps<{ events: IEventRow[] }>()

function relative(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return new Date(ts).toLocaleDateString()
}
</script>

<style scoped lang="scss">
.activity {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: calc(var(--nb-base-unit) / 2);

  li {
    display: flex;
    align-items: center;
    gap: var(--nb-base-unit);
    font-size: 0.85rem;
  }

  &__summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__rule {
    font-size: 0.7rem;
    opacity: 0.6;
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 4px;
  }

  &__system {
    opacity: 0.5;
  }

  &__time {
    opacity: 0.5;
    white-space: nowrap;
  }
}
</style>

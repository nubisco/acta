<template>
  <ul class="activity" aria-label="Activity">
    <li v-for="event in events" :key="event.id">
      <NbAiLabel v-if="event.actor_kind === 'agent'" />
      <NbBadge
        v-else-if="event.actor_kind === 'system'"
        size="sm"
        variant="grey"
      >
        System
      </NbBadge>
      <span
        v-nb-tooltip="{
          body: event.summary,
          overflowOnly: true,
          focusable: true,
        }"
        class="activity__summary"
      >
        {{ event.summary }}
      </span>
      <NbBadge v-if="event.caused_by" size="sm" variant="purple">Rule</NbBadge>
      <time :datetime="new Date(event.ts).toISOString()" class="activity__time">
        {{ relativeTime(event.ts) }}
      </time>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { NbAiLabel, NbBadge } from '@nubisco/ui'
import type { IEventRow } from '@/types/api'
import { relativeTime } from '@/lib/state'

defineProps<{ events: IEventRow[] }>()
</script>

<style scoped lang="scss">
.activity {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--nb-spacing-4);

  li {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    font-size: var(--nb-type-body-sm-size);
  }

  &__summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__time {
    color: var(--nb-c-text-subtle);
    white-space: nowrap;
  }
}
</style>

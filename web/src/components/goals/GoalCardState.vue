<template>
  <NbBadge v-if="card.done" size="sm" variant="green">Done</NbBadge>
  <NbBadge v-else-if="card.overdue" size="sm" variant="red" dot>Late</NbBadge>
  <NbBadge v-else-if="card.waiting" size="sm" variant="orange" dot>
    Waiting
  </NbBadge>
  <NbBadge v-else-if="card.active" size="sm" variant="blue" dot>
    Moving
  </NbBadge>
  <NbBadge v-else size="sm" variant="grey">To do</NbBadge>
</template>

<script setup lang="ts">
/**
 * Where one of a goal's cards stands, in one word. Shared by the goal's card
 * list and its tree, so the two never disagree about a card.
 */
import type { IGoalCard } from '@/types/api'

defineProps<{
  card: Pick<IGoalCard, 'done' | 'overdue' | 'waiting' | 'active'>
}>()
</script>

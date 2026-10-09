<template>
  <!-- One rendering of a card's priority, wherever a card is drawn. -->
  <NbBadge
    v-if="priority"
    v-nb-tooltip="{ body: PRIORITY_LABEL[priority] }"
    size="sm"
    :variant="PRIORITY_VARIANT[priority]"
    class="priority-badge"
    :aria-label="PRIORITY_LABEL[priority]"
  >
    {{ priority === 'urgent' ? 'Urgent' : short[priority] }}
  </NbBadge>
</template>

<script setup lang="ts">
import {
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
  type TPriority,
} from '@/lib/priority'

defineProps<{ priority?: TPriority | null }>()

const short: Record<TPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}
</script>

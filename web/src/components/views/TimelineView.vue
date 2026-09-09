<template>
  <div class="tl">
    <NbBanner
      v-if="undated > 0"
      status="info"
      variant="inline"
      :title="`${undated} ${undated === 1 ? 'item has' : 'items have'} no due date, so ${undated === 1 ? 'it is' : 'they are'} not on the timeline`"
    />
    <NbGanttChart :tasks="tasks" time-scale="week" />
  </div>
</template>

<script setup lang="ts">
/**
 * Work from when it was created to when it is due, grouped by list.
 *
 * A bar needs two ends. Using the creation date as the start is the only
 * honest one available: a card does not record when work began, and starting
 * every bar at "today" would draw a chart that changes shape each morning
 * without anything having happened.
 */
import { computed } from 'vue'
import type { IBoardItemRow } from '@/types/api'

const props = defineProps<{ items: IBoardItemRow[] }>()

const dated = computed(() => props.items.filter((i) => i.due))
const undated = computed(() => props.items.length - dated.value.length)

const tasks = computed(() =>
  dated.value.map((item) => {
    const due = item.due as number
    // A card created after its own due date would otherwise draw backwards.
    const start = Math.min(item.created ?? due, due)
    return {
      id: item.key,
      label: `${item.key} ${item.title}`,
      start: new Date(start).toISOString(),
      end: new Date(due).toISOString(),
      group: item.list,
      status: item.done
        ? ('complete' as const)
        : due < Date.now()
          ? ('at-risk' as const)
          : ('on-track' as const),
    }
  }),
)
</script>

<style scoped lang="scss">
.tl {
  display: grid;
  gap: var(--nb-spacing-12);
}
</style>

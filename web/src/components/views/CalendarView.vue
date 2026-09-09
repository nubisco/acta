<template>
  <div class="cal">
    <NbBanner
      v-if="undated > 0"
      status="info"
      variant="inline"
      :title="`${undated} ${undated === 1 ? 'item has' : 'items have'} no due date, so ${undated === 1 ? 'it is' : 'they are'} not on the calendar`"
    />
    <NbCalendar :events="events" @select="onSelect" />
  </div>
</template>

<script setup lang="ts">
/**
 * Cards on the dates they are due.
 *
 * A calendar can only show what has a date, and quietly dropping the rest
 * would make the view lie about how much work there is. The count of what is
 * missing is stated rather than hidden.
 */
import { computed } from 'vue'
import type { IBoardItemRow } from '@/types/api'
import { chartColorFor } from '@/lib/colors'

const props = defineProps<{ items: IBoardItemRow[] }>()
const emit = defineEmits<{ open: [key: string] }>()

const dated = computed(() => props.items.filter((i) => i.due))
const undated = computed(() => props.items.length - dated.value.length)

const events = computed(() =>
  dated.value.map((item) => ({
    id: item.key,
    label: `${item.key} ${item.title}`,
    start: new Date(item.due as number).toISOString(),
    // Colour by list, so a glance shows where work sits as well as when it
    // is due.
    color: chartColorFor(item.list),
  })),
)

function onSelect(event: unknown): void {
  const id = (event as { id?: string } | null)?.id
  if (id) emit('open', id)
}
</script>

<style scoped lang="scss">
.cal {
  display: grid;
  gap: var(--nb-spacing-12);
}
</style>

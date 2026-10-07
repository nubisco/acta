<template>
  <div class="goal-progress">
    <NbProgressBar
      :value="progress.percent ?? 0"
      :size="size"
      :status="finished ? 'finished' : 'active'"
      :label="label"
    />
    <p class="goal-progress__caption">
      <template v-if="progress.cards_total === 0">No cards yet</template>
      <template v-else>
        <strong>{{ progress.percent }}%</strong>
        · {{ progress.cards_done }} of {{ progress.cards_total }}
        {{ progress.cards_total === 1 ? 'card' : 'cards' }} done
        <template v-if="detailed">
          <template v-if="progress.cards_active > 0">
            · {{ progress.cards_active }} moving
          </template>
          <template v-if="progress.cards_waiting > 0">
            · {{ progress.cards_waiting }} waiting
          </template>
          <span v-if="progress.cards_overdue > 0" class="goal-progress__late">
            · {{ progress.cards_overdue }} late
          </span>
        </template>
      </template>
      <!-- Time gone beside work done, which is the comparison a reader is
           actually making when they look at a goal with a date on it. -->
      <template v-if="elapsed !== undefined">
        · {{ elapsed }}% of the time gone
      </template>
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * The measured half of a goal: how much of the work behind it is done.
 *
 * Never coloured by the goal's status, because it is not the status. A goal
 * that is ninety percent built and off track has to read as both at once,
 * and a bar painted red would say the work is behind when it is not.
 */
import { computed } from 'vue'
import type { IGoalProgress } from '@/types/api'

const props = withDefaults(
  defineProps<{
    progress: IGoalProgress
    elapsed?: number
    /** Moving, waiting and late counts beside the done count. */
    detailed?: boolean
    size?: 'sm' | 'md'
    /**
     * Shown above the track and used as the bar's accessible name. Left off
     * in dense rows, where the caption beside the bar already says it and a
     * heading over every row would be the loudest thing in the table.
     */
    label?: string
  }>(),
  {
    elapsed: undefined,
    detailed: false,
    size: 'sm',
    label: undefined,
  },
)

const finished = computed(
  () =>
    props.progress.cards_total > 0 &&
    props.progress.cards_done === props.progress.cards_total,
)
</script>

<style scoped lang="scss">
.goal-progress {
  display: grid;
  gap: var(--nb-spacing-4);
  min-inline-size: 0;

  &__caption {
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);

    strong {
      color: var(--nb-c-text);
      font-weight: var(--nb-type-label-md-weight);
    }
  }

  &__late {
    color: var(--nb-c-status-error);
  }
}
</style>

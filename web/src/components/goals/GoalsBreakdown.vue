<template>
  <div class="breakdown">
    <!-- Part to whole, as one bar: how the goals in this workspace stand.
         Every segment carries its words in a tooltip, and the legend under
         it carries them again with the count, so colour is never the only
         way to read it. -->
    <div
      v-if="summary.total > 0"
      class="breakdown__bar"
      role="img"
      :aria-label="barLabel"
    >
      <span
        v-for="seg in segments"
        :key="seg.status"
        v-nb-tooltip="{
          header: seg.label,
          body: `${seg.count} ${seg.count === 1 ? 'goal' : 'goals'}`,
        }"
        class="breakdown__seg"
        :style="{ flexGrow: seg.count, background: seg.color }"
      />
    </div>

    <ul class="breakdown__legend" aria-label="Goals by status">
      <li v-for="seg in segments" :key="seg.status">
        <component
          :is="selectable ? 'button' : 'span'"
          :type="selectable ? 'button' : undefined"
          class="breakdown__status"
          :class="{
            'breakdown__status--on': selected === seg.status,
            'breakdown__status--live': selectable,
          }"
          :aria-pressed="selectable ? selected === seg.status : undefined"
          @click="selectable && emit('select', seg.status)"
        >
          <GoalStatusBadge :status="seg.status" />
          <span class="breakdown__count">{{ seg.count }}</span>
        </component>
      </li>
    </ul>

    <NbDefinitionList :items="facts" class="breakdown__facts" />
  </div>
</template>

<script setup lang="ts">
/**
 * How the workspace's goals stand, at a glance.
 *
 * Three things, each answering a different question. The bar and legend say
 * how the goals are judged by the people steering them. The facts say what
 * needs a look: goals past their date, goals nobody has spoken about in a
 * month, and the work across every goal in flight, counted once per card.
 */
import { computed } from 'vue'
import type { IGoalSummary, TGoalStatus } from '@/types/api'
import { GOAL_STATUS, GOAL_STATUS_ORDER } from '@/lib/goals'
import GoalStatusBadge from '@/components/goals/GoalStatusBadge.vue'

const props = withDefaults(
  defineProps<{
    summary: IGoalSummary
    /** Statuses become toggles that filter whatever is under the breakdown. */
    selectable?: boolean
    selected?: TGoalStatus | null
  }>(),
  { selectable: false, selected: null },
)

const emit = defineEmits<{ select: [status: TGoalStatus] }>()

/** Only statuses that have goals, worst first. */
const segments = computed(() =>
  GOAL_STATUS_ORDER.filter((s) => props.summary.by_status[s] > 0).map(
    (status) => ({
      status,
      label: GOAL_STATUS[status].label,
      color: GOAL_STATUS[status].color,
      count: props.summary.by_status[status],
    }),
  ),
)

const barLabel = computed(() =>
  segments.value.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', '),
)

const facts = computed(() => {
  const work = props.summary.work
  return [
    { term: 'In flight', value: String(props.summary.in_flight) },
    {
      term: 'Past their date',
      value: String(props.summary.overdue),
    },
    {
      term: 'No check-in for a month',
      value: String(props.summary.stale),
    },
    {
      term: 'Work behind them',
      value:
        work.cards_total === 0
          ? 'No cards linked yet'
          : `${work.percent}% done, ${work.cards_done} of ${work.cards_total} cards` +
            (work.cards_overdue > 0 ? `, ${work.cards_overdue} late` : ''),
    },
  ]
})
</script>

<style scoped lang="scss">
.breakdown {
  display: grid;
  gap: var(--nb-spacing-12);
  min-inline-size: 0;

  /* The same segmented bar Home draws for each space's lists, so the two
     read as the same kind of picture. A 2px gap between fills. */
  &__bar {
    display: flex;
    gap: 2px;
    block-size: 10px;
  }

  &__seg {
    flex-basis: 0;
    min-inline-size: 6px;
    border-radius: 2px;
  }

  &__legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nb-spacing-8) var(--nb-spacing-16);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__status {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    padding: 2px var(--nb-spacing-4);
    border: 0;
    border-radius: var(--nb-radius-sm);
    background: none;
    font: inherit;
    color: inherit;

    &--live {
      cursor: pointer;

      &:hover {
        background: var(--nb-c-surface-hover);
      }
    }

    &--on {
      outline: 1px solid var(--nb-c-primary);
      outline-offset: 1px;
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 1px;
    }
  }

  &__count {
    font-size: var(--nb-type-label-md-size);
    font-weight: var(--nb-type-label-md-weight);
    color: var(--nb-c-text);
  }
}
</style>

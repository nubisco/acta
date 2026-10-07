<template>
  <NbPanel class="home-goals">
    <header class="home-goals__head">
      <h2 class="type-heading-02">Goals</h2>
      <NbButton
        v-if="summary && summary.total > 0"
        size="sm"
        variant="ghost"
        icon="arrow-right"
        :href="wpath('/goals')"
      >
        All goals
      </NbButton>
    </header>

    <NbSkeleton
      v-if="loading"
      variant="block"
      height="9rem"
      label="Loading goals"
    />

    <NbEmptyState
      v-else-if="failed"
      size="sm"
      kind="error"
      title="Could not load the goals"
    >
      <template #actions>
        <NbButton size="xs" variant="secondary" @click="reload">Retry</NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="!summary || summary.total === 0"
      size="sm"
      title="No goals yet"
      description="Name the outcomes the work is for, link the cards that get you there, and check in on them. This is where you will see how they stand."
    >
      <template #actions>
        <NbButton
          size="sm"
          variant="secondary"
          icon="plus"
          @click="ui.newGoal.value = {}"
        >
          Create a goal
        </NbButton>
      </template>
    </NbEmptyState>

    <div v-else class="home-goals__body">
      <GoalsBreakdown :summary="summary" />

      <div class="home-goals__list">
        <h3 class="home-goals__subhead">
          {{ attention.length > 0 ? 'Needs a look' : 'In flight' }}
        </h3>
        <p v-if="shown.length === 0" class="home-goals__none">
          Nothing in flight right now.
        </p>
        <ul v-else>
          <li v-for="goal in shown" :key="goal.number">
            <RouterLink
              :to="wpath(`/goals/${goal.number}`)"
              class="home-goals__row"
            >
              <span class="home-goals__row-head">
                <span class="home-goals__key">{{ goal.key }}</span>
                <span class="home-goals__title">{{ goal.title }}</span>
                <GoalStatusBadge :status="goal.status" />
              </span>
              <span class="home-goals__why">
                <ActorAvatar
                  v-if="goal.owner"
                  :handle="goal.owner"
                  :size="18"
                />
                <span v-if="goal.overdue" class="home-goals__flag">
                  {{ targetLabel(goal.target_date) }}
                </span>
                <span v-else-if="goal.target_date">
                  {{ targetLabel(goal.target_date) }}
                </span>
                <span v-if="goal.stale" class="home-goals__flag">
                  No check-in for a month
                </span>
              </span>
              <GoalProgress :progress="goal.progress" :elapsed="goal.elapsed" />
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>
  </NbPanel>
</template>

<script setup lang="ts">
/**
 * Goals on Home, before anything else.
 *
 * The breakdown says how the whole set stands. The list beside it says which
 * goals need somebody: off track, at risk, past their date, or gone a month
 * without a check-in, worst first. When nothing needs a look it shows the
 * top-level goals in flight instead, so the panel is never a wall of green
 * with nothing to click.
 */
import { computed, onScopeDispose, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api/client'
import type { IGoalRow, IGoalSummary } from '@/types/api'
import { GOAL_STATUS_ORDER, goalStatus, targetLabel } from '@/lib/goals'
import { wpath } from '@/lib/paths'
import { useUiState, useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import GoalProgress from '@/components/goals/GoalProgress.vue'
import GoalStatusBadge from '@/components/goals/GoalStatusBadge.vue'
import GoalsBreakdown from '@/components/goals/GoalsBreakdown.vue'

const ws = useWorkspace()
const ui = useUiState()

const goals = ref<IGoalRow[]>([])
const summary = ref<IGoalSummary | null>(null)
const loading = ref(true)
const failed = ref(false)

/** How badly a goal needs somebody, lower is worse. */
function urgency(goal: IGoalRow): number {
  const rank = GOAL_STATUS_ORDER.indexOf(goal.status)
  return (goal.overdue ? -20 : 0) + (goal.stale ? -10 : 0) + rank
}

const inFlight = computed(() =>
  goals.value.filter((g) => goalStatus(g.status).inFlight),
)

const attention = computed(() =>
  inFlight.value
    .filter(
      (g) =>
        g.status === 'off_track' ||
        g.status === 'at_risk' ||
        g.overdue ||
        g.stale,
    )
    .sort((a, b) => urgency(a) - urgency(b)),
)

const shown = computed(() =>
  (attention.value.length > 0
    ? attention.value
    : inFlight.value.filter((g) => g.parent === undefined)
  ).slice(0, 5),
)

async function reload(): Promise<void> {
  failed.value = false
  try {
    const result = await api.goals({ state: 'open' })
    goals.value = result.goals
    summary.value = result.summary
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

let pending: ReturnType<typeof setTimeout> | undefined
onScopeDispose(
  ws.onLive((event) => {
    if (event.entity !== 'goal' && event.entity !== 'item') return
    clearTimeout(pending)
    pending = setTimeout(() => void reload(), 600)
  }),
)
watch(
  () => ui.goalsVersion.value,
  () => void reload(),
)

void reload()
</script>

<style scoped lang="scss">
.home-goals {
  display: grid;
  gap: var(--nb-spacing-16);
  padding: var(--nb-spacing-16);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-16);

    h2 {
      margin: 0;
    }
  }

  /* The breakdown and the list side by side when there is room for both,
     because Home is wide and the two answer different questions. */
  &__body {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: var(--nb-spacing-24);
    align-items: start;
  }

  &__list {
    display: grid;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--nb-spacing-4);
    }
  }

  &__subhead {
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-text-subtle);
  }

  &__row {
    display: grid;
    gap: var(--nb-spacing-4);
    padding: var(--nb-spacing-8);
    border-radius: var(--nb-radius-sm);
    color: inherit;
    text-decoration: none;

    &:hover {
      background: var(--nb-c-surface-hover);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 1px;
    }
  }

  &__row-head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
  }

  &__key {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__title {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--nb-type-label-md-weight);
  }

  &__why {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--nb-spacing-8);
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__flag {
    color: var(--nb-c-status-error);
  }

  &__none {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }
}
</style>

<template>
  <div class="goals-view">
    <component :is="actions.Outlet">
      <NbButton
        size="sm"
        variant="primary"
        icon="plus"
        @click="ui.newGoal.value = {}"
      >
        Create goal
      </NbButton>
    </component>

    <header class="goals-view__head">
      <h1 class="type-heading-03">Goals</h1>
      <NbTabs
        v-model="scope"
        :items="scopeTabs"
        aria-label="Which goals"
        variant="contained"
        size="sm"
      />
    </header>

    <NbSkeleton
      v-if="load.state.value === 'loading' && !summary"
      variant="block"
      height="12rem"
      label="Loading goals"
    />

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load the goals"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="reload">Retry</NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="summary && summary.total === 0 && scope !== 'archived'"
      title="No goals yet"
      description="A goal names an outcome and groups the cards that get you there, from any space. Its status is the owner's judgement, posted in check-ins, and its progress is measured from the cards."
    >
      <template #actions>
        <NbButton variant="primary" icon="plus" @click="ui.newGoal.value = {}">
          Create the first goal
        </NbButton>
      </template>
    </NbEmptyState>

    <template v-else-if="summary">
      <NbPanel v-if="scope !== 'archived'" class="goals-view__summary">
        <GoalsBreakdown
          :summary="summary"
          selectable
          :selected="statusFilter"
          @select="toggleStatus"
        />
      </NbPanel>

      <NbDataTable
        :columns="columns"
        :rows="rows"
        row-key="number"
        size="sm"
        aria-label="Goals"
        :empty-message="emptyMessage"
        @row-click="(row) => openGoal((row as TRow).number)"
      >
        <template #cell-title="{ row }">
          <span
            class="goals-view__title"
            :style="{ paddingInlineStart: `${(row as TRow).depth * 20}px` }"
          >
            <NbIcon
              v-if="(row as TRow).depth > 0"
              name="arrow-elbow-down-right"
              :size="14"
              class="goals-view__elbow"
            />
            <span class="goals-view__key">{{ (row as TRow).key }}</span>
            <RouterLink
              class="goals-view__name"
              :to="wpath(`/goals/${(row as TRow).number}`)"
              @click.stop
            >
              {{ (row as TRow).title }}
            </RouterLink>
          </span>
        </template>
        <template #cell-status="{ row }">
          <span class="goals-view__status">
            <GoalStatusBadge :status="(row as TRow).status" />
            <NbIcon
              v-if="(row as TRow).stale"
              v-nb-tooltip="{
                body: 'Nobody has checked in for over a month',
              }"
              name="hourglass-medium"
              :size="14"
              class="goals-view__flag"
              aria-label="No check-in for over a month"
            />
          </span>
        </template>
        <template #cell-owner="{ row }">
          <ActorAvatar
            v-if="(row as TRow).owner"
            :handle="(row as TRow).owner!"
            :size="22"
          />
          <span v-else class="goals-view__muted">No owner</span>
        </template>
        <template #cell-progress="{ row }">
          <GoalProgress
            :progress="(row as TRow).progress"
            :elapsed="(row as TRow).elapsed"
          />
        </template>
        <template #cell-target="{ row }">
          <span
            v-if="(row as TRow).target_date"
            :class="{ 'goals-view__late': (row as TRow).overdue }"
            :title="goalDate((row as TRow).target_date)"
          >
            {{ targetLabel((row as TRow).target_date) }}
          </span>
          <span v-else class="goals-view__muted">No date</span>
        </template>
        <template #cell-checkin="{ row }">
          <span v-if="(row as TRow).last_check_in" class="goals-view__muted">
            {{ relativeTime((row as TRow).last_check_in!.ts) }}
          </span>
          <span v-else class="goals-view__muted">Never</span>
        </template>
      </NbDataTable>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Every goal, before any card.
 *
 * The breakdown first, because the question this page answers is "how are
 * we doing", and the table after it in tree order, so a sub-goal sits under
 * the goal it serves. A status in the breakdown filters the table.
 */
import { computed, onScopeDispose, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useShellSlot } from '@nubisco/ui'
import { api } from '@/api/client'
import type { IGoalRow, IGoalSummary, TGoalStatus } from '@/types/api'
import { relativeTime, useLoadState } from '@/lib/state'
import { goalDate, goalTree, targetLabel } from '@/lib/goals'
import { wpath } from '@/lib/paths'
import { useUiState, useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import GoalProgress from '@/components/goals/GoalProgress.vue'
import GoalStatusBadge from '@/components/goals/GoalStatusBadge.vue'
import GoalsBreakdown from '@/components/goals/GoalsBreakdown.vue'

/** Indexable, which is what NbDataTable takes, the way ActivityView's are. */
type TRow = IGoalRow & { depth: number } & Record<string, unknown>

const ws = useWorkspace()
const ui = useUiState()
const router = useRouter()
const load = useLoadState()
const actions = useShellSlot('topbar-right')

const goals = ref<IGoalRow[]>([])
const summary = ref<IGoalSummary | null>(null)
const scope = ref<'open' | 'mine' | 'following' | 'archived'>('open')
const statusFilter = ref<TGoalStatus | null>(null)

const scopeTabs = [
  { id: 'open', label: 'All goals' },
  { id: 'mine', label: 'Mine' },
  { id: 'following', label: 'Following' },
  { id: 'archived', label: 'Archived' },
]

const columns = [
  { key: 'title', header: 'Goal' },
  { key: 'status', header: 'Status', width: 150 },
  { key: 'owner', header: 'Owner', width: 90 },
  { key: 'progress', header: 'Work', width: 280 },
  { key: 'target', header: 'Target', width: 140 },
  { key: 'checkin', header: 'Last check-in', width: 130 },
]

const rows = computed<TRow[]>(() => {
  const me = ws.me.value?.handle
  const filtered = goals.value
    .filter((g) => scope.value !== 'mine' || g.owner === me)
    .filter((g) => scope.value !== 'following' || g.following)
    .filter((g) => !statusFilter.value || g.status === statusFilter.value)
  return goalTree(filtered) as TRow[]
})

const emptyMessage = computed(() => {
  if (statusFilter.value) return 'No goals with that status here.'
  return {
    open: 'No goals.',
    mine: 'You do not own any goals.',
    following: 'You are not following any goals.',
    archived: 'Nothing archived.',
  }[scope.value]
})

function toggleStatus(status: TGoalStatus): void {
  statusFilter.value = statusFilter.value === status ? null : status
}

function openGoal(number: number): void {
  void router.push(wpath(`/goals/${number}`))
}

async function reload(): Promise<void> {
  const result = await load.run(
    api.goals({ state: scope.value === 'archived' ? 'archived' : 'open' }),
  )
  if (result) {
    goals.value = result.goals
    summary.value = result.summary
  }
}

watch(scope, (next, prev) => {
  // Only the archive is a different read; the rest filter what is here.
  if (next === 'archived' || prev === 'archived') {
    statusFilter.value = null
    void reload()
  }
})

// A goal's numbers move whenever a card serving it does, so any card or goal
// event is worth a quiet re-read.
let pending: ReturnType<typeof setTimeout> | undefined
onScopeDispose(
  ws.onLive((event) => {
    if (event.entity !== 'goal' && event.entity !== 'item') return
    clearTimeout(pending)
    pending = setTimeout(() => void reload(), 400)
  }),
)
watch(
  () => ui.goalsVersion.value,
  () => void reload(),
)

void reload()
</script>

<style scoped lang="scss">
.goals-view {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-16);
    flex-wrap: wrap;

    h1 {
      margin: 0;
    }
  }

  &__summary {
    padding: var(--nb-spacing-16);
  }

  &__title {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
  }

  &__elbow {
    flex: none;
    color: var(--nb-c-text-subtle);
  }

  &__key {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__name {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--nb-c-text);
    font-weight: var(--nb-type-label-md-weight);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  &__status {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
  }

  &__flag {
    color: var(--nb-c-status-warning);
  }

  &__muted {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__late {
    color: var(--nb-c-status-error);
  }
}
</style>

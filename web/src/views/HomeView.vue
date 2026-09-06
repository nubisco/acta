<template>
  <div class="home">
    <h1 class="type-heading-03">
      {{ ws.overview.value?.workspace.name ?? 'Workspace' }}
    </h1>

    <component :is="actions.Outlet">
      <NbButton
        size="sm"
        variant="primary"
        icon="plus"
        @click="ui.newBoardOpen.value = true"
      >
        Create board
      </NbButton>
    </component>

    <NbCardGrid v-if="load.state.value === 'loading'">
      <NbSkeleton
        v-for="index in 6"
        :key="index"
        variant="block"
        height="11rem"
        :label="index === 1 ? 'Loading boards' : undefined"
      />
    </NbCardGrid>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load your boards"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="reload">Retry</NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="boards.length === 0" class="home__empty">
      <NbEmptyState
        title="No boards yet"
        description="A board holds a project's items as lists. Create the first one to start tracking work."
      >
        <template #actions>
          <NbButton
            variant="primary"
            icon="plus"
            @click="ui.newBoardOpen.value = true"
          >
            Create board
          </NbButton>
        </template>
      </NbEmptyState>
    </div>

    <NbCardGrid v-else>
      <NbCard
        v-for="board in boards"
        :key="board.key"
        :title="board.name"
        :subtitle="board.key"
        :href="`/b/${board.key}`"
      >
        <template #icon>
          <span
            class="home__mark"
            :style="{ background: chartColorFor(board.key) }"
            aria-hidden="true"
          >
            {{ board.key.slice(0, 2) }}
          </span>
        </template>
        <div class="home__distribution">
          <div
            v-if="itemCount(board) > 0"
            class="home__bar"
            role="img"
            :aria-label="`${itemCount(board)} items across ${board.lists.length} lists`"
          >
            <span
              v-for="seg in segments(board)"
              :key="seg.id"
              v-nb-tooltip="{
                header: seg.name,
                body: `${seg.items} ${seg.items === 1 ? 'item' : 'items'}`,
              }"
              class="home__seg"
              :style="{ flexGrow: seg.items, background: seg.color }"
            />
          </div>
          <p class="home__caption">
            <template v-if="itemCount(board) > 0">
              {{ board.lists.length }} lists · {{ itemCount(board) }} items
            </template>
            <template v-else>No items yet</template>
          </p>
        </div>
        <template #footer>
          <NbBadge size="sm" variant="grey">
            {{ openCount(board) }} open
          </NbBadge>
          <NbBadge v-if="doneCount(board) > 0" size="sm" variant="green">
            {{ doneCount(board) }} done
          </NbBadge>
        </template>
      </NbCard>
    </NbCardGrid>

    <NbPanel v-if="recent.length > 0" class="home__activity">
      <h2 class="type-heading-02">Recent activity</h2>
      <ActivityList :events="recent" />
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NbBadge,
  NbButton,
  NbCard,
  NbCardGrid,
  NbEmptyState,
  NbPanel,
  NbSkeleton,
  useShellSlot,
} from '@nubisco/ui'
import { api } from '@/api/client'
import type { IEventRow, TOverviewBoard } from '@/types/api'
import { chartColorFor, roleColor } from '@/lib/colors'
import { useLoadState } from '@/lib/state'
import { useUiState, useWorkspace } from '@/stores/workspace'
import ActivityList from '@/components/ActivityList.vue'

const ws = useWorkspace()
const ui = useUiState()
const load = useLoadState()
const actions = useShellSlot('topbar-right')

const boards = computed(() =>
  (ws.overview.value?.boards ?? []).filter((b) => !b.archived),
)
const recent = ref<IEventRow[]>([])

function itemCount(board: TOverviewBoard): number {
  return board.lists.reduce((sum, l) => sum + l.items, 0)
}

interface IDistributionSegment {
  id: string
  name: string
  items: number
  color: string
}

/** One segment per non-empty list, colored by the list's role. */
function segments(board: TOverviewBoard): IDistributionSegment[] {
  return board.lists
    .filter((l) => l.items > 0)
    .map((l) => ({
      id: l.id,
      name: l.name,
      items: l.items,
      color: roleColor(l.role) ?? 'var(--nb-c-text-subtle)',
    }))
}

function openCount(board: TOverviewBoard): number {
  return board.lists
    .filter((l) => l.role !== 'done')
    .reduce((sum, l) => sum + l.items, 0)
}

function doneCount(board: TOverviewBoard): number {
  return board.lists
    .filter((l) => l.role === 'done')
    .reduce((sum, l) => sum + l.items, 0)
}

async function reload(): Promise<void> {
  const result = await load.run(
    Promise.all([ws.refresh(), api.activity({ limit: '12' })]),
  )
  if (result) recent.value = result[1].events
}

void reload()
</script>

<style scoped lang="scss">
.home {
  display: grid;
  gap: var(--nb-spacing-24);
  align-content: start;

  h1 {
    margin: 0;
  }

  &__empty {
    min-height: 24rem;
    padding-block: var(--nb-spacing-24);
  }

  &__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 32px;
    block-size: 32px;
    border-radius: var(--nb-radius-sm);
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-label-md-size);
    font-weight: var(--nb-type-label-lg-weight, 600);
    color: var(--nb-c-bg);
  }

  &__distribution {
    display: grid;
    gap: var(--nb-spacing-8);
    align-content: end;
    height: 100%;
    padding-block-start: var(--nb-spacing-8);
  }

  &__bar {
    display: flex;
    gap: 2px;
    block-size: 8px;
  }

  &__seg {
    flex-basis: 0;
    min-inline-size: 4px;
    border-radius: 2px;
  }

  &__caption {
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__activity {
    display: grid;
    gap: var(--nb-spacing-12);
    border-radius: var(--nb-radius-md);

    h2 {
      margin: 0;
    }
  }
}
</style>

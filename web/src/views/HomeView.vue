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
        <ul class="home__lists">
          <li v-for="list in visibleLists(board)" :key="list.id">
            <span class="home__list-name">{{ list.name }}</span>
            <span class="home__count">{{ list.items }}</span>
          </li>
          <li v-if="board.lists.length > LIST_PREVIEW" class="home__more">
            +{{ board.lists.length - LIST_PREVIEW }} more lists
          </li>
        </ul>
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
import { useLoadState } from '@/lib/state'
import { useUiState, useWorkspace } from '@/stores/workspace'
import ActivityList from '@/components/ActivityList.vue'

const LIST_PREVIEW = 6

const ws = useWorkspace()
const ui = useUiState()
const load = useLoadState()
const actions = useShellSlot('topbar-right')

const boards = computed(() =>
  (ws.overview.value?.boards ?? []).filter((b) => !b.archived),
)
const recent = ref<IEventRow[]>([])

function visibleLists(board: TOverviewBoard): TOverviewBoard['lists'] {
  return board.lists.slice(0, LIST_PREVIEW)
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

  &__lists {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-4);

    li {
      display: flex;
      justify-content: space-between;
      gap: var(--nb-spacing-8);
      font-size: var(--nb-type-body-sm-size);
      line-height: var(--nb-type-body-sm-line-height);
    }
  }

  &__list-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__count {
    font-family: var(--nb-font-family-mono);
    font-variant-numeric: tabular-nums;
    color: var(--nb-c-text-muted);
  }

  &__more {
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

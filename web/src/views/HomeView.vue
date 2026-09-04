<template>
  <div class="home">
    <h1>{{ ws.overview.value?.workspace.name ?? 'Workspace' }}</h1>

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

    <div v-if="load.state.value === 'loading'" class="home__grid">
      <NbSkeleton
        v-for="index in 3"
        :key="index"
        variant="block"
        height="10rem"
        :label="index === 1 ? 'Loading boards' : undefined"
      />
    </div>

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
        :href="`/b/${board.key}`"
      >
        <span class="home__key">{{ board.key }}</span>
        <ul class="home__lists">
          <li v-for="list in board.lists" :key="list.id">
            <span>{{ list.name }}</span>
            <span class="home__count">{{ list.items }}</span>
          </li>
        </ul>
      </NbCard>
    </NbCardGrid>

    <section v-if="recent.length > 0" class="home__activity">
      <h2>Recent activity</h2>
      <ActivityList :events="recent" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NbButton,
  NbCard,
  NbCardGrid,
  NbEmptyState,
  NbSkeleton,
  useShellSlot,
} from '@nubisco/ui'
import { api } from '@/api/client'
import type { IEventRow } from '@/types/api'
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

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--nb-spacing-16);
  }

  &__empty {
    min-height: 24rem;
    padding-block: var(--nb-spacing-24);
  }

  &__key {
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__lists {
    list-style: none;
    margin: var(--nb-spacing-8) 0 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-4);

    li {
      display: flex;
      justify-content: space-between;
      font-size: var(--nb-type-body-sm-size);
    }
  }

  &__count {
    color: var(--nb-c-text-muted);
  }

  &__activity h2 {
    margin-block-end: var(--nb-spacing-8);
  }
}
</style>

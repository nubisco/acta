<template>
  <div class="home">
    <h1 class="type-heading-03">
      {{ ws.overview.value?.workspace.name ?? 'Workspace' }}
    </h1>

    <!-- Before the spaces. What is mine is the question people open Home
         with, and a grid of boards does not answer it. -->
    <MyWorkPanel />

    <component :is="actions.Outlet">
      <NbButton
        size="sm"
        variant="primary"
        icon="plus"
        @click="ui.newSpaceOpen.value = true"
      >
        Create space
      </NbButton>
    </component>

    <NbCardGrid v-if="load.state.value === 'loading'">
      <NbSkeleton
        v-for="index in 6"
        :key="index"
        variant="block"
        height="11rem"
        :label="index === 1 ? 'Loading spaces' : undefined"
      />
    </NbCardGrid>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load your spaces"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="reload">Retry</NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="spaces.length === 0" class="home__empty">
      <NbEmptyState
        title="No spaces yet"
        description="A space holds a project's items as lists. Create the first one to start tracking work."
      >
        <template #actions>
          <NbButton
            variant="primary"
            icon="plus"
            @click="ui.newSpaceOpen.value = true"
          >
            Create space
          </NbButton>
        </template>
      </NbEmptyState>
    </div>

    <template v-else>
      <template v-for="section in sections" :key="section.title">
        <h2 v-if="section.heading" class="type-heading-02 home__section">
          {{ section.title }}
        </h2>
        <NbCardGrid>
          <NbCard
            v-for="space in section.spaces"
            :key="space.key"
            :title="space.name"
            :href="wpath(`/s/${space.key}`)"
          >
            <template #icon>
              <span
                class="home__mark"
                :style="{ background: chartColorFor(space.key) }"
                aria-hidden="true"
              >
                {{ space.key.slice(0, 2) }}
              </span>
            </template>
            <div class="home__distribution">
              <div
                v-if="itemCount(space) > 0"
                class="home__bar"
                role="img"
                :aria-label="`${itemCount(space)} items across ${space.lists.length} lists`"
              >
                <span
                  v-for="seg in segments(space)"
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
                <template v-if="itemCount(space) > 0">
                  {{ space.lists.length }} lists · {{ itemCount(space) }} items
                </template>
                <template v-else>No items yet</template>
              </p>
            </div>
            <template #footer>
              <NbBadge size="sm" variant="grey">
                {{ openCount(space) }} open
              </NbBadge>
              <NbBadge v-if="doneCount(space) > 0" size="sm" variant="green">
                {{ doneCount(space) }} done
              </NbBadge>
              <NbButton
                v-nb-tooltip="{
                  body: space.starred
                    ? 'Remove from favourites'
                    : 'Add to favourites',
                }"
                class="home__star"
                size="xs"
                variant="ghost"
                :icon="space.starred ? starFill : starOutline"
                :aria-label="`${space.starred ? 'Unstar' : 'Star'} ${space.name}`"
                :aria-pressed="Boolean(space.starred)"
                @click.stop.prevent="toggleStar(space)"
              />
            </template>
          </NbCard>
        </NbCardGrid>
      </template>
    </template>

    <!--
      Activity used to be a twelve-row feed at the bottom of this page, which
      is a whole nav destination reprinted underneath the thing it competes
      with. Everything anyone did is rarely what a person came here for, so
      what is left is the way through to it.
    -->
    <p v-if="spaces.length > 0" class="home__activity">
      <NbButton
        size="sm"
        variant="ghost"
        icon="activity"
        :href="wpath('/activity')"
      >
        See everything happening in this workspace
      </NbButton>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useShellSlot, useToast } from '@nubisco/ui'
import { api } from '@/api/client'
import type { TOverviewSpace } from '@/types/api'
import { chartColorFor, roleColor } from '@/lib/colors'
import { humanise, useLoadState } from '@/lib/state'
import { useUiState, useWorkspace } from '@/stores/workspace'
import MyWorkPanel from '@/components/MyWorkPanel.vue'
import { wpath } from '@/lib/paths'
// A filled star is the same glyph at a different weight, not a different
// name. Icon props take the artwork as well as a name, so the two weights are
// imported directly and linked at build time.
import {
  fill as starFill,
  regular as starOutline,
} from '@nubisco/ui/icons/star'

const ws = useWorkspace()
const toast = useToast()
const ui = useUiState()
const load = useLoadState()
const actions = useShellSlot('topbar-right')

const spaces = computed(() =>
  (ws.overview.value?.spaces ?? []).filter((b) => !b.archived),
)

/**
 * Favourites first, then the rest. Only headed when there are favourites:
 * with none, "All spaces" under a heading is a section of one, which is just
 * a heading for its own sake.
 */
const sections = computed(() => {
  const starred = spaces.value.filter((b) => b.starred)
  const rest = spaces.value.filter((b) => !b.starred)
  if (starred.length === 0)
    return [{ title: 'Spaces', heading: false, spaces: rest }]
  return [
    { title: 'Favourites', heading: true, spaces: starred },
    { title: 'All spaces', heading: true, spaces: rest },
  ]
})

async function toggleStar(space: {
  key: string
  starred?: boolean
}): Promise<void> {
  const next = !space.starred
  try {
    await api.starSpace(space.key, next)
    await ws.refresh()
  } catch (err) {
    toast.error(humanise(err), {
      title: next ? 'Could not add to favourites' : 'Could not remove it',
    })
  }
}
function itemCount(space: TOverviewSpace): number {
  return space.lists.reduce((sum, l) => sum + l.items, 0)
}

interface IDistributionSegment {
  id: string
  name: string
  items: number
  color: string
}

/** One segment per non-empty list, colored by the list's role. */
function segments(space: TOverviewSpace): IDistributionSegment[] {
  return space.lists
    .filter((l) => l.items > 0)
    .map((l) => ({
      id: l.id,
      name: l.name,
      items: l.items,
      color: roleColor(l.role) ?? 'var(--nb-c-text-subtle)',
    }))
}

function openCount(space: TOverviewSpace): number {
  return space.lists
    .filter((l) => l.role !== 'done')
    .reduce((sum, l) => sum + l.items, 0)
}

function doneCount(space: TOverviewSpace): number {
  return space.lists
    .filter((l) => l.role === 'done')
    .reduce((sum, l) => sum + l.items, 0)
}

async function reload(): Promise<void> {
  await load.run(ws.refresh())
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

  &__section {
    margin-block: var(--nb-spacing-24) var(--nb-spacing-8);

    &:first-of-type {
      margin-block-start: 0;
    }
  }

  &__star {
    margin-inline-start: auto;
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
    font-weight: var(--nb-type-label-lg-weight);
    color: var(--nb-c-bg);
  }

  /* Plain flow inside the card body: any height/percentage game here makes
   * the card outgrow its grid track and eat the row gap. */
  &__distribution {
    display: grid;
    gap: var(--nb-spacing-8);
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

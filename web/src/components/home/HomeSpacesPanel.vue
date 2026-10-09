<template>
  <NbPanel class="home">
    <header class="home__head">
      <h2 class="type-heading-02">Spaces</h2>
      <NbInfoHint
        :size="16"
        label="About spaces"
        title="Spaces"
        text="Each space is a board of cards in lists. The bar shows how its cards spread across the lists, coloured by what each list means (to do, in progress, done). Star a space to keep it at the top."
      />
    </header>
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
        <h3 v-if="section.heading" class="type-label-lg home__section">
          {{ section.title }}
        </h3>
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

    <!-- Archived spaces: out of the way, kept, and where they come back
         from or go for good (Jose, 2026-10-09). -->
    <details v-if="archived.length > 0" class="home__archived">
      <summary>
        Archived spaces
        <SectionCount
          :text="String(archived.length)"
          :tip="`${archived.length} archived ${archived.length === 1 ? 'space' : 'spaces'}, kept with everything in them`"
        />
      </summary>
      <ul class="home__archived-list">
        <li
          v-for="space in archived"
          :key="space.key"
          class="home__archived-row"
        >
          <span class="home__archived-name">
            <span class="home__archived-key">{{ space.key }}</span>
            {{ space.name }}
          </span>
          <NbButton
            size="xs"
            variant="ghost"
            icon="arrow-counter-clockwise"
            @click="restore(space)"
          >
            Restore
          </NbButton>
          <NbButton
            v-if="ws.isAdmin.value"
            size="xs"
            variant="danger"
            outlined
            icon="trash"
            @click="removeForGood(space)"
          >
            Delete permanently
          </NbButton>
        </li>
      </ul>
    </details>
  </NbPanel>
</template>

<script setup lang="ts">
/** The spaces grid, as one of Home's panels: favourites first, then the rest. */
import { computed } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import SectionCount from '@/components/SectionCount.vue'
import type { TOverviewSpace } from '@/types/api'
import { chartColorFor, roleColor } from '@/lib/colors'
import { humanise, useLoadState } from '@/lib/state'
import { useUiState, useWorkspace } from '@/stores/workspace'
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
const confirm = useConfirm()
const ui = useUiState()
const load = useLoadState()

const spaces = computed(() =>
  (ws.overview.value?.spaces ?? []).filter((b) => !b.archived),
)
const archived = computed(() =>
  (ws.overview.value?.spaces ?? []).filter((b) => b.archived),
)

async function spaceOp(op: 'restore' | 'delete', key: string): Promise<void> {
  const { results } = await api.spaceWrite([{ op, op_id: newOpId(), key }])
  if (!results[0]?.ok) throw new Error(String(results[0]?.error ?? 'failed'))
  await ws.refresh()
}

async function restore(space: TOverviewSpace): Promise<void> {
  try {
    await spaceOp('restore', space.key)
    toast.success(`${space.name} is back.`)
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not restore it' })
  }
}

/** For good: the confirmation says what goes with it. */
async function removeForGood(space: TOverviewSpace): Promise<void> {
  const cards = itemCount(space)
  await confirm({
    title: `Delete ${space.name} permanently?`,
    message:
      cards > 0
        ? `Its ${cards} ${cards === 1 ? 'card' : 'cards'}, with their comments, checklists and attachments, and its ${space.lists.length} lists go with it. Pages filed under it are kept. This cannot be undone.`
        : `It has no cards, so only its ${space.lists.length} lists go with it. This cannot be undone.`,
    subject: space.name,
    subjectLabel: 'Space',
    confirmLabel: 'Delete permanently',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      await spaceOp('delete', space.key)
      toast.success(`${space.name} deleted.`)
    },
    formatError: humanise,
  })
}

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
  gap: var(--nb-spacing-12);
  align-content: start;

  &__head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);

    h2 {
      margin: 0;
    }
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

  &__archived summary {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    margin-block-start: var(--nb-spacing-8);
    color: var(--nb-c-text-muted);
    cursor: pointer;
  }

  &__archived-list {
    list-style: none;
    margin: var(--nb-spacing-8) 0 0;
    padding: 0;
  }

  &__archived-row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    padding-block: var(--nb-spacing-4);
    border-block-end: 1px solid var(--nb-c-border);
  }

  &__archived-name {
    flex: 1;
    min-inline-size: 0;
  }

  &__archived-key {
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
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

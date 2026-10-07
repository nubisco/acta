<template>
  <div class="activity-view">
    <h1 class="type-heading-03">Activity</h1>

    <component :is="filterBar.Outlet">
      <div class="activity-view__filters">
        <ActorFilter
          v-model="actorFilter"
          scope="acting"
          label="Filter activity by person"
        />
      </div>
    </component>

    <NbBanner
      v-if="pendingCount > 0"
      status="info"
      variant="inline"
      :title="`${pendingCount} new ${pendingCount === 1 ? 'event' : 'events'}`"
    >
      <template #action>
        <NbButton size="sm" variant="secondary" @click="refresh">
          Refresh
        </NbButton>
      </template>
    </NbBanner>

    <div v-if="load.state.value === 'loading'" class="activity-view__loading">
      <NbSkeleton variant="text" :lines="8" label="Loading activity" />
    </div>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Could not load activity"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="refresh">Retry</NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="events.length === 0 && actorFilter.length > 0"
      kind="no-results"
      title="Nothing from those people"
      description="Events exist, but none from the people selected above."
    >
      <template #actions>
        <NbButton variant="secondary" @click="actorFilter = []">
          Show everyone
        </NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="events.length === 0"
      title="No activity yet"
      description="Every change made by a person, an agent, or a rule appears here."
    />

    <template v-else>
      <NbDataTable
        :columns="columns"
        :rows="rows"
        row-key="id"
        size="sm"
        aria-label="Activity"
        :sort-state="sort"
        @sort="onSort"
      >
        <!-- A person in the feed is a question: what else did they do? The
             filter this sets is the one already at the top of the page. -->
        <template #cell-who="{ row }">
          <component
            :is="(row as IRow).handle ? 'button' : 'span'"
            :type="(row as IRow).handle ? 'button' : undefined"
            class="activity-view__who"
            :class="{ 'activity-view__who--live': (row as IRow).handle }"
            :title="
              (row as IRow).handle
                ? `Show only ${(row as IRow).who}`
                : undefined
            "
            @click="
              (row as IRow).handle && onlyThisPerson((row as IRow).handle)
            "
          >
            <ActorAvatar
              v-if="(row as IRow).handle"
              :handle="(row as IRow).handle"
              :size="22"
            />
            {{ (row as IRow).who }}
          </component>
        </template>
        <!-- The feed names cards and pages in the open, so what it names is
             what you click. A row has no single destination: a dependency
             summary is about two cards and both ends are worth opening. -->
        <template #cell-what="{ row }">
          <span class="activity-view__what">
            <template
              v-for="(part, i) in (row as IRow).parts"
              :key="`${(row as IRow).id}-${i}`"
            >
              <button
                v-if="part.kind === 'item'"
                type="button"
                class="activity-view__ref"
                @click="inspector.open(part.text)"
              >
                {{ part.text }}
              </button>
              <RouterLink
                v-else-if="part.kind === 'doc'"
                class="activity-view__ref"
                :to="wpath(`/docs/${part.slug}`)"
              >
                {{ part.text }}
              </RouterLink>
              <RouterLink
                v-else-if="part.kind === 'goal'"
                class="activity-view__ref"
                :to="wpath(`/goals/${part.number}`)"
              >
                {{ part.text }}
              </RouterLink>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
        </template>
        <template #cell-when="{ row }">
          <time
            v-nb-tooltip="{ body: absoluteTime((row as IRow).ts) }"
            :datetime="new Date((row as IRow).ts).toISOString()"
          >
            {{ (row as IRow).when }}
          </time>
        </template>
      </NbDataTable>
      <NbButton
        v-if="cursor"
        variant="secondary"
        :loading="loadingMore"
        @click="loadMore"
      >
        Load more
      </NbButton>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useShellSlot } from '@nubisco/ui'
import { api } from '@/api/client'
import type { IEventRow } from '@/types/api'
import { absoluteTime, relativeTime, useLoadState } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import { RouterLink } from 'vue-router'
import ActorAvatar from '@/components/ActorAvatar.vue'
import ActorFilter from '@/components/ActorFilter.vue'
import { activitySegments, type TActivitySegment } from '@/lib/activity'
import { wpath } from '@/lib/paths'
import { useInspector } from '@/stores/workspace'

const ws = useWorkspace()
const inspector = useInspector()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')

const events = ref<IEventRow[]>([])
const cursor = ref<string | undefined>()
const actorFilter = ref<string[]>([])
const sort = ref<{ key: string; direction: 'asc' | 'desc' } | null>(null)
const pendingCount = ref(0)
const loadingMore = ref(false)

const columns = [
  { key: 'when', header: 'When', sortable: true, width: '10rem' },
  { key: 'who', header: 'Who', sortable: true, width: '14rem' },
  { key: 'what', header: 'What', sortable: true },
]

interface IRow extends Record<string, unknown> {
  id: string
  ts: number
  when: string
  who: string
  handle: string
  what: string
  /** The summary, split into the things it names. See lib/activity.ts. */
  parts: TActivitySegment[]
}

/**
 * NbDataTable is controlled: it reports the click and reflects whatever state
 * it is given back, so the ascending/descending cycle lives here. Without
 * feeding `sortState` back the header never shows which column is sorted and
 * `aria-sort` stays "none".
 */
function onSort(state: unknown): void {
  const next = state as { key?: string; direction?: string } | null
  if (!next?.key || next.direction === 'none') {
    sort.value = null
    return
  }
  const direction =
    next.direction === 'asc' || next.direction === 'desc'
      ? next.direction
      : sort.value?.key === next.key && sort.value.direction === 'asc'
        ? 'desc'
        : 'asc'
  sort.value = { key: next.key, direction }
}

/**
 * Narrow the feed to one person, from their name in a row.
 *
 * Replaces the filter rather than adding to it: clicking a name in a list
 * means "just them", and the control at the top is still there for picking
 * several.
 */
function onlyThisPerson(handle: string): void {
  actorFilter.value = [handle]
}

/**
 * Sorting applies to everything loaded, not to the whole log: the feed is
 * paginated by cursor, so "oldest first" means the oldest of what you have
 * pulled in. Load more, and the sort covers more.
 */
const rows = computed<IRow[]>(() => {
  const mapped: IRow[] = events.value.map((event) => {
    const actor = ws.overview.value?.actors.find((a) => a.id === event.actor_id)
    return {
      id: event.id,
      ts: event.ts,
      when: relativeTime(event.ts),
      who: actor?.name ?? 'Acta',
      handle: actor?.handle ?? '',
      // Kept as plain text as well: it is what the column sorts on, and what
      // a screen reader gets if the cell is read as a whole.
      what: event.summary,
      parts: activitySegments(
        event.summary,
        event.doc_slug,
        event.entity === 'goal' || event.verb.startsWith('item.goal_'),
      ),
    }
  })
  const active = sort.value
  if (!active) return mapped
  const factor = active.direction === 'desc' ? -1 : 1
  const field = active.key === 'when' ? 'ts' : active.key
  return [...mapped].sort((a, b) => {
    const left = a[field as keyof IRow]
    const right = b[field as keyof IRow]
    if (typeof left === 'number' && typeof right === 'number')
      return (left - right) * factor
    return String(left).localeCompare(String(right)) * factor
  })
})

function params(): Record<string, string> {
  const out: Record<string, string> = { limit: '50' }
  if (actorFilter.value.length > 0) out.actor = actorFilter.value.join(',')
  return out
}

async function refresh(): Promise<void> {
  pendingCount.value = 0
  const result = await load.run(api.activity(params()))
  if (result) {
    events.value = result.events
    cursor.value = result.cursor
  }
}

async function loadMore(): Promise<void> {
  if (!cursor.value) return
  loadingMore.value = true
  try {
    const result = await api.activity({ ...params(), cursor: cursor.value })
    events.value = [...events.value, ...result.events]
    cursor.value = result.cursor
  } finally {
    loadingMore.value = false
  }
}

watch(actorFilter, () => void refresh(), { immediate: true, deep: true })

onScopeDispose(
  ws.onLive(() => {
    pendingCount.value += 1
  }),
)
</script>

<style scoped lang="scss">
.activity-view {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  h1 {
    margin: 0;
  }

  &__who {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    text-align: start;
  }

  /* A button only where there is a person to filter by. The system actor has
     no handle, so that row stays a plain span rather than a control that
     would narrow the feed to nobody. */
  &__who--live {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      color: var(--nb-c-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
      border-radius: var(--nb-radius-sm);
    }
  }

  &__what {
    /* The sentence wraps, and the things in it should not break mid-key. */
    overflow-wrap: anywhere;
  }

  /* The card keys and page names inside a summary. Deliberately not a chip:
     these sit inside a sentence, several to a line, and a row of pills would
     read as a toolbar rather than as a line of prose that happens to name
     things you can open. */
  &__ref {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--nb-c-primary);
    font-weight: var(--nb-type-label-lg-weight);
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;

    &:hover,
    &:focus-visible {
      text-decoration: underline;
    }

    &:focus-visible {
      outline: 2px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
      border-radius: var(--nb-radius-sm);
    }
  }

  &__filters {
    padding-block: var(--nb-spacing-8);
  }

  /* The feed stretches; standalone actions (Load more) do not. */
  > .nb-button {
    justify-self: start;
  }
}
</style>

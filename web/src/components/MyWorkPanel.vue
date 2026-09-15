<template>
  <NbPanel class="my-work">
    <header class="my-work__head">
      <h2 class="type-heading-02">{{ greeting }}</h2>
      <NbTabs
        v-if="hasAnything"
        v-model="bucket"
        :items="bucketTabs"
        aria-label="What to look at"
        variant="contained"
        size="sm"
      />
    </header>

    <NbSkeleton
      v-if="loading"
      variant="block"
      height="9rem"
      label="Loading your work"
    />

    <!--
      One empty state for the whole panel when there is genuinely nothing,
      and a per-bucket one when a bucket happens to be empty. They say
      different things: "nothing is waiting on you" is good news, and "no
      mentions" while three items sit under Assigned is not.
    -->
    <NbEmptyState
      v-else-if="!hasAnything"
      size="sm"
      title="Nothing is waiting on you"
      description="Work assigned to you, mentions and anything due soon will show up here."
    />

    <template v-else>
      <ul v-if="rows.length > 0" class="my-work__list">
        <li v-for="row in rows" :key="`${bucket}:${row.key}`">
          <button type="button" class="my-work__row" @click="open(row.key)">
            <span class="my-work__key">{{ row.key }}</span>
            <span class="my-work__title">{{ row.title }}</span>
            <span class="my-work__where">
              {{ row.space }} · {{ row.list }}
            </span>
            <NbBadge
              v-if="row.due"
              size="sm"
              :variant="row.overdue ? 'red' : 'orange'"
            >
              {{ dueLabel(row) }}
            </NbBadge>
            <span v-else-if="row.at" class="my-work__when">
              {{ relative(row.at) }}
            </span>
          </button>
        </li>
      </ul>

      <NbEmptyState
        v-else
        size="sm"
        :title="emptyTitle"
        :description="emptyDescription"
      />
    </template>
  </NbPanel>
</template>

<script setup lang="ts">
/**
 * What this person should probably look at, before anything else on Home.
 *
 * Home opened on a grid of spaces and a workspace activity feed. Neither
 * answers the question people arrive with: a grid of boards is a filing
 * cabinet, and an activity feed is everything everyone did. Four buckets,
 * one query, and the counts are on the tabs so the panel can be read without
 * clicking through it.
 */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import type { IMyWorkItem } from '@/types/api'
import { humanise } from '@/lib/state'
import { useInspector, useWorkspace } from '@/stores/workspace'
import { useToast } from '@nubisco/ui'

const inspector = useInspector()
const ws = useWorkspace()
const toast = useToast()

const loading = ref(true)
const bucket = ref<'assigned' | 'mentions' | 'due' | 'recent'>('assigned')
const work = ref<{
  assigned: IMyWorkItem[]
  due: IMyWorkItem[]
  mentions: IMyWorkItem[]
  recent: IMyWorkItem[]
}>({ assigned: [], due: [], mentions: [], recent: [] })

const greeting = computed(() => {
  const name = ws.me.value?.name?.split(/\s+/)[0]
  return name ? `Your work, ${name}` : 'Your work'
})

/** Counts on the tab, so the panel reads without being clicked through. */
const bucketTabs = computed(() => [
  {
    id: 'assigned',
    label: `Assigned ${work.value.assigned.length || ''}`.trim(),
  },
  {
    id: 'mentions',
    label: `Mentions ${work.value.mentions.length || ''}`.trim(),
  },
  { id: 'due', label: `Due soon ${work.value.due.length || ''}`.trim() },
  { id: 'recent', label: 'Recent' },
])

const rows = computed(() => work.value[bucket.value])

const hasAnything = computed(() =>
  (['assigned', 'mentions', 'due', 'recent'] as const).some(
    (k) => work.value[k].length > 0,
  ),
)

const emptyTitle = computed(
  () =>
    ({
      assigned: 'Nothing assigned to you',
      mentions: 'No mentions waiting',
      due: 'Nothing due in the next week',
      recent: 'Nothing here yet',
    })[bucket.value],
)

const emptyDescription = computed(
  () =>
    ({
      assigned: 'Cards assigned to you appear here.',
      mentions:
        'When somebody names you on a card, it waits here until you have read it.',
      due: 'Dated work appears here as its date approaches.',
      recent:
        'Cards you edit show up here so you can pick up where you left off.',
    })[bucket.value],
)

const DAY = 24 * 60 * 60 * 1000

/** Days, not dates: "in 2 days" is what the reader is actually deciding on. */
function dueLabel(row: IMyWorkItem): string {
  if (!row.due) return ''
  const days = Math.round((row.due - Date.now()) / DAY)
  if (days < -1) return `${Math.abs(days)} days late`
  if (days === -1) return 'Yesterday'
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `In ${days} days`
}

function relative(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function open(key: string): void {
  inspector.open(key)
}

onMounted(async () => {
  try {
    work.value = await api.myWork()
    // Land on a bucket that has something in it, so the panel does not open
    // on an empty tab while three mentions wait one across.
    const first = (['assigned', 'mentions', 'due', 'recent'] as const).find(
      (k) => work.value[k].length > 0,
    )
    if (first) bucket.value = first
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load your work' })
  } finally {
    loading.value = false
  }
})
</script>

<style scoped lang="scss">
.my-work {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-16);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-16);
    flex-wrap: wrap;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  &__row {
    inline-size: 100%;
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    align-items: center;
    gap: var(--nb-spacing-12);
    padding: var(--nb-spacing-8) var(--nb-spacing-4);
    background: none;
    border: 0;
    border-block-end: 1px solid var(--nb-c-border);
    font: inherit;
    text-align: start;
    cursor: pointer;

    &:hover {
      background: var(--nb-c-surface-hover);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: -1px;
    }
  }

  &__key {
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  /* The title is the only thing allowed to take the leftover width, so a long
     one truncates instead of pushing the date off the row. */
  &__title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__where,
  &__when {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
    white-space: nowrap;
  }

  @media (max-width: 40rem) {
    /* The location is the first thing worth losing on a narrow screen: the
       key and the title already identify the card. */
    &__where {
      display: none;
    }

    &__row {
      grid-template-columns: auto 1fr auto;
    }
  }
}
</style>

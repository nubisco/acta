<template>
  <section class="next-up" aria-labelledby="next-up-title">
    <!-- Good morning first, then the one line that says what is waiting:
         the question people open Home with (Jose, 2026-10-09). -->
    <header class="next-up__greeting">
      <h1 class="type-heading-03">{{ greeting }}</h1>
      <p class="next-up__summary">{{ summary }}</p>
    </header>

    <NbPanel class="next-up__panel">
      <header class="next-up__head">
        <h2 id="next-up-title" class="type-heading-02">Next up</h2>
        <NbInfoHint
          :size="16"
          label="About Next up"
          title="What to pick up next"
          text="Your open cards across every space, plus anything due within a week that nobody is on, ranked by what makes them urgent: overdue or due soon, priority, a mention waiting on you, other people's cards you are holding up, a goal in trouble, and work already in progress. Each card says why it is here. Cards waiting on another card are listed apart, under the ranking."
        />
      </header>

      <NbSkeleton
        v-if="loading"
        variant="block"
        height="9rem"
        label="Loading what is next"
      />

      <NbEmptyState
        v-else-if="items.length === 0 && waiting.length === 0"
        size="sm"
        title="Nothing is waiting on you"
        description="Cards assigned to you, mentions and anything due soon show up here, most pressing first."
      />

      <template v-else>
        <ol class="next-up__list">
          <li v-for="item in items" :key="item.key">
            <button
              type="button"
              class="next-up__row"
              :aria-current="inspector.itemKey.value === item.key || undefined"
              @click="inspector.open(item.key)"
            >
              <span class="next-up__key">{{ item.key }}</span>
              <span class="next-up__main">
                <span class="next-up__title">{{ item.title }}</span>
                <span class="next-up__where">
                  {{ item.space }} · {{ item.list }}
                </span>
              </span>
              <span class="next-up__reasons">
                <NbBadge
                  v-for="reason in item.reasons.slice(0, 2)"
                  :key="reason.code"
                  size="sm"
                  :variant="tone(reason.code)"
                >
                  {{ reason.label }}
                </NbBadge>
                <NbBadge
                  v-if="item.reasons.length > 2"
                  v-nb-tooltip="{ body: why(item) }"
                  size="sm"
                  variant="grey"
                >
                  +{{ item.reasons.length - 2 }}
                </NbBadge>
              </span>
              <NbInfoHint
                :size="14"
                :label="`Why ${item.key} is here`"
                title="Why this is here"
                :text="why(item)"
                @click.stop
              />
            </button>
          </li>
        </ol>

        <details v-if="waiting.length > 0" class="next-up__waiting">
          <summary>
            Waiting on other cards
            <SectionCount
              :text="String(waiting.length)"
              :tip="`${waiting.length} of your cards cannot move until another card is done`"
            />
          </summary>
          <ol class="next-up__list">
            <li v-for="item in waiting" :key="item.key">
              <button
                type="button"
                class="next-up__row"
                @click="inspector.open(item.key)"
              >
                <span class="next-up__key">{{ item.key }}</span>
                <span class="next-up__main">
                  <span class="next-up__title">{{ item.title }}</span>
                  <span class="next-up__where">
                    {{ item.space }} · {{ item.list }}
                  </span>
                </span>
                <span class="next-up__reasons">
                  <NbBadge size="sm" variant="grey">
                    Waiting on {{ item.waiting_on }}
                  </NbBadge>
                </span>
              </button>
            </li>
          </ol>
        </details>
      </template>
    </NbPanel>
  </section>
</template>

<script setup lang="ts">
/**
 * Home's opening: a greeting, a line on what is waiting, and the ranked list
 * of what to pick up next, each card with its reasons. Replaces "Your work",
 * whose four lists (assigned, due, mentions, recent) each had their own order
 * so nothing said which card mattered most. The ranking is the server's
 * (services/nextUp.ts); this only shows it, reasons first.
 */
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { api } from '@/api/client'
import { humanise } from '@/lib/state'
import { useInspector, useWorkspace } from '@/stores/workspace'
import { useToast } from '@nubisco/ui'
import SectionCount from '@/components/SectionCount.vue'
import type { INextItem, INextUp } from '@/types/api'

const inspector = useInspector()
const ws = useWorkspace()
const toast = useToast()

const loading = ref(true)
const data = ref<INextUp | null>(null)
const items = computed(() => data.value?.items ?? [])
const waiting = computed(() => data.value?.waiting ?? [])

const greeting = computed(() => {
  const hour = new Date().getHours()
  const part =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const name = ws.me.value?.name?.split(/\s+/)[0]
  return name ? `${part}, ${name}` : part
})

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** One line, worst news first, or the good news when there is none. */
const summary = computed(() => {
  const c = data.value?.counts
  if (!c) return ''
  const parts: string[] = []
  if (c.overdue) parts.push(plural(c.overdue, 'card overdue', 'cards overdue'))
  if (c.due_today) parts.push(`${c.due_today} due today`)
  if (c.mentions)
    parts.push(plural(c.mentions, 'mention waiting', 'mentions waiting'))
  if (c.blocking)
    parts.push(
      plural(c.blocking, 'card holding others up', 'cards holding others up'),
    )
  const later = c.due_week - c.due_today
  if (later > 0) parts.push(`${later} more due this week`)
  if (parts.length === 0) return 'Nothing is overdue or waiting on you.'
  return `${parts.join(', ')}.`.replace(/^./, (ch) => ch.toUpperCase())
})

/** Colour by consequence: red and orange only for what is late or in trouble. */
function tone(code: string): 'red' | 'orange' | 'blue' | 'purple' | 'grey' {
  if (code === 'overdue') return 'red'
  if (code === 'due' || code === 'goal' || code === 'priority') return 'orange'
  if (code === 'mention') return 'blue'
  if (code === 'blocks') return 'purple'
  return 'grey'
}

function why(item: INextItem): string {
  return item.reasons
    .map((r) => `${r.label} (${r.points > 0 ? '+' : ''}${r.points})`)
    .join(', ')
}

async function load(): Promise<void> {
  try {
    data.value = await api.myNext()
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load what is next' })
  } finally {
    loading.value = false
  }
}

onMounted(load)

// Anything about a card might move it up or down. Coalesced, so a burst of
// writes is one re-read.
let timer: ReturnType<typeof setTimeout> | undefined
onScopeDispose(
  ws.onLive((event) => {
    if (event.entity !== 'item' && event.entity !== 'goal') return
    clearTimeout(timer)
    timer = setTimeout(() => void load(), 500)
  }),
)
onScopeDispose(() => clearTimeout(timer))
</script>

<style scoped lang="scss">
.next-up {
  display: grid;
  gap: var(--nb-spacing-16);

  &__greeting {
    display: grid;
    gap: var(--nb-spacing-4);

    h1 {
      margin: 0;
    }
  }

  &__summary {
    margin: 0;
    color: var(--nb-c-text-muted);
  }

  &__panel {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-12);
  }

  &__head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);

    h2 {
      margin: 0;
    }
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__row {
    inline-size: 100%;
    display: grid;
    grid-template-columns: 4.5rem minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--nb-spacing-12);
    padding: var(--nb-spacing-8) var(--nb-spacing-4);
    background: none;
    border: 0;
    border-block-end: 1px solid var(--nb-c-border);
    font: inherit;
    color: inherit;
    text-align: start;
    cursor: pointer;

    &:hover,
    &[aria-current='true'] {
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

  &__main {
    display: grid;
    min-inline-size: 0;
  }

  &__title {
    font-size: var(--nb-type-label-lg-size);
    font-weight: var(--nb-type-label-lg-weight);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__where {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__reasons {
    display: inline-flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--nb-spacing-4);
  }

  &__waiting {
    summary {
      display: inline-flex;
      align-items: center;
      gap: var(--nb-spacing-8);
      padding-block: var(--nb-spacing-8);
      color: var(--nb-c-text-muted);
      cursor: pointer;
    }
  }

  @media (max-width: 40rem) {
    &__row {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    &__key {
      display: none;
    }

    &__reasons {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
}
</style>

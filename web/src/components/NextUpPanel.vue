<template>
  <section class="next-up" aria-labelledby="next-up-title">
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
 * The ranked list of what to pick up next, each card with its reasons. Replaces "Your work",
 * whose four lists (assigned, due, mentions, recent) each had their own order
 * so nothing said which card mattered most. The ranking is the server's
 * (services/nextUp.ts); this only shows it, reasons first.
 */
import { computed } from 'vue'
import { useInspector } from '@/stores/workspace'
import { useNextUp } from '@/composables/useNextUp'
import SectionCount from '@/components/SectionCount.vue'
import type { INextItem } from '@/types/api'

const inspector = useInspector()
const { data, loading } = useNextUp()
const items = computed(() => data.value?.items ?? [])
const waiting = computed(() => data.value?.waiting ?? [])

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
</script>

<style scoped lang="scss">
.next-up {
  display: grid;
  gap: var(--nb-spacing-16);

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

<template>
  <div class="sequence">
    <NbEmptyState
      v-if="load.state.value === 'error'"
      kind="error"
      title="Could not work out the sequence"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="reload">Retry</NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="load.state.value === 'loading'" class="sequence__loading">
      <NbSkeleton variant="block" height="7rem" label="Working out the order" />
      <NbSkeleton variant="block" height="7rem" />
    </div>

    <NbEmptyState
      v-else-if="plan && plan.nodes.length === 0"
      title="Nothing left to sequence"
      description="Every card here is done or archived."
    />

    <template v-else-if="plan">
      <!-- The headline is the only number anyone asks for: how long is the
           road. Said once, at the top, rather than implied by the layout. -->
      <header class="sequence__summary">
        <span class="sequence__stat">
          <strong>{{ plan.layers }}</strong>
          {{ plan.layers === 1 ? 'step' : 'steps' }}
        </span>
        <span class="sequence__stat">
          <strong>{{ plan.critical_size }}</strong> on the critical path
        </span>
        <span class="sequence__stat sequence__stat--muted">
          {{ plan.nodes.length }} cards
        </span>
        <NbButton
          size="xs"
          :variant="onlyCritical ? 'secondary' : 'ghost'"
          :aria-pressed="onlyCritical"
          @click="onlyCritical = !onlyCritical"
        >
          Critical path only
        </NbButton>
      </header>

      <!-- One band per step. Everything in a band can be worked at the same
           time, which is the question a plan is actually asked: not "when is
           this due" but "what can start now". -->
      <section
        v-for="step in steps"
        :key="step.layer"
        class="sequence__step"
        :class="{ 'sequence__step--now': step.layer === 0 }"
      >
        <div class="sequence__rail">
          <span class="sequence__badge">{{ step.layer + 1 }}</span>
          <span v-if="step.layer === 0" class="sequence__now"
            >Can start now</span
          >
        </div>

        <ul class="sequence__cards">
          <li v-for="node in step.nodes" :key="node.key">
            <button
              type="button"
              class="sequence__card"
              :class="{
                'sequence__card--critical': node.critical,
                'sequence__card--milestone': node.is_milestone,
              }"
              @click="emit('open', node.key)"
            >
              <span class="sequence__head">
                <NbIcon
                  v-if="node.is_milestone"
                  name="flag"
                  :size="13"
                  aria-hidden="true"
                />
                <span class="sequence__key">{{ node.key }}</span>
                <NbBadge
                  v-if="node.critical"
                  v-nb-tooltip="{
                    body: 'On the longest chain: slipping this slips the finish',
                  }"
                  size="sm"
                  variant="orange"
                >
                  critical
                </NbBadge>
                <span class="sequence__list">{{ node.list }}</span>
              </span>

              <span class="sequence__title">{{ node.title }}</span>

              <span class="sequence__meta">
                <ActorAvatar
                  v-for="handle in node.assignees"
                  :key="handle"
                  :handle="handle"
                  :size="18"
                />
                <LabelBadge
                  v-for="label in node.labels"
                  :key="label"
                  :name="label"
                />
                <span v-if="node.size !== null" class="sequence__size">
                  {{ node.size }}
                </span>
              </span>

              <!-- What it waits on, named. A plan that only draws position
                   makes you infer the reason; the reason is the content. -->
              <span v-if="node.blocked_by.length > 0" class="sequence__after">
                after {{ node.blocked_by.join(', ') }}
              </span>
              <span
                v-if="node.blocks.length > 0"
                class="sequence__unlocks"
                :title="`Unblocks ${node.blocks.join(', ')}`"
              >
                unblocks {{ node.blocks.length }}
              </span>
            </button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The plan, as an order rather than as dates.
 *
 * The timeline view can only draw what has a due date, and software rarely
 * has one: people know that a card blocks another long before anyone will
 * commit to a Tuesday. This draws the thing they do know.
 *
 * Read top to bottom: each band is one step, everything inside a band can be
 * worked at the same time, and the highlighted chain is the one that decides
 * when the whole thing finishes.
 */
import { computed, ref, watch } from 'vue'
import { api } from '@/api/client'
import { useLoadState } from '@/lib/state'
import ActorAvatar from '@/components/ActorAvatar.vue'
import LabelBadge from '@/components/LabelBadge.vue'

const props = defineProps<{ spaceKey: string }>()
const emit = defineEmits<{ open: [key: string] }>()

type TPlan = Awaited<ReturnType<typeof api.sequence>>

const plan = ref<TPlan | null>(null)
const onlyCritical = ref(false)
const load = useLoadState()

async function reload(): Promise<void> {
  const result = await load.run(api.sequence(props.spaceKey))
  if (result) plan.value = result
}
watch(() => props.spaceKey, reload, { immediate: true })

/**
 * Bands, with empty ones dropped.
 *
 * Filtering to the critical path can empty a step entirely, and a numbered
 * band with nothing in it reads as missing data rather than as a filter.
 */
const steps = computed(() => {
  const nodes = (plan.value?.nodes ?? []).filter(
    (n) => !onlyCritical.value || n.critical,
  )
  const byLayer = new Map<number, typeof nodes>()
  for (const node of nodes) {
    const bucket = byLayer.get(node.layer) ?? []
    bucket.push(node)
    byLayer.set(node.layer, bucket)
  }
  return [...byLayer.entries()]
    .sort(([a], [b]) => a - b)
    .map(([layer, group]) => ({ layer, nodes: group }))
})
</script>

<style scoped lang="scss">
.sequence {
  display: grid;
  gap: var(--nb-spacing-16);
  padding-block-end: var(--nb-spacing-24);

  &__loading {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__summary {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-16);
    flex-wrap: wrap;
    padding: var(--nb-spacing-8) var(--nb-spacing-12);
    border: 1px solid var(--nb-c-border-subtle, var(--nb-c-border));
    border-radius: var(--nb-radius-sm, 8px);
    background: var(--nb-c-surface-sunken, transparent);
  }

  &__stat {
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);

    strong {
      color: var(--nb-c-text);
      font-size: var(--nb-type-body-md-size);
    }

    &--muted {
      margin-inline-start: auto;
    }
  }

  /* A rail down the left carries the step number, so the eye can follow the
     order without reading any card. */
  &__step {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--nb-spacing-12);
    align-items: start;
  }

  &__rail {
    display: grid;
    justify-items: center;
    gap: var(--nb-spacing-4);
    position: sticky;
    top: 0;
  }

  &__badge {
    display: grid;
    place-items: center;
    inline-size: 1.75rem;
    block-size: 1.75rem;
    border-radius: var(--nb-radius-full, 999px);
    background: var(--nb-c-layer-2, var(--nb-c-border));
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
    font-weight: 600;
  }

  &__step--now &__badge {
    background: var(--nb-c-primary);
    color: var(--nb-c-white);
  }

  &__now {
    font-size: var(--nb-type-body-xs-size, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-primary);
    writing-mode: vertical-rl;
  }

  &__cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
    gap: var(--nb-spacing-8);
  }

  &__card {
    display: grid;
    gap: var(--nb-spacing-4);
    inline-size: 100%;
    min-inline-size: 0;
    padding: var(--nb-spacing-8) var(--nb-spacing-12);
    text-align: start;
    background: var(--nb-c-surface);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm, 6px);
    color: inherit;
    font: inherit;
    cursor: pointer;

    &:hover {
      border-color: var(--nb-c-primary);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
      outline-offset: 2px;
    }

    /* The chain that decides the finish, marked on its edge rather than by
       tinting the card: the cards already carry label colour. */
    &--critical {
      border-inline-start: 3px solid var(--nb-c-warning, orange);
    }

    &--milestone {
      border-style: dashed;
    }
  }

  &__head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    flex-wrap: wrap;
  }

  &__key {
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__list {
    margin-inline-start: auto;
    font-size: var(--nb-type-body-xs-size, 0.7rem);
    color: var(--nb-c-text-subtle);
  }

  /* Two lines, then stop. The point of a plan is the shape of the whole
     thing, and a card that prints its whole title buries it. */
  &__title {
    font-size: var(--nb-type-body-sm-size);
    font-weight: var(--nb-type-label-lg-weight, 500);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  &__meta {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    flex-wrap: wrap;
  }

  &__size {
    padding-inline: var(--nb-spacing-4);
    border-radius: var(--nb-radius-full, 999px);
    background: var(--nb-c-layer-2, var(--nb-c-border));
    font-size: var(--nb-type-body-xs-size, 0.7rem);
    color: var(--nb-c-text-subtle);
  }

  &__after,
  &__unlocks {
    font-size: var(--nb-type-body-xs-size, 0.7rem);
    color: var(--nb-c-text-subtle);
    overflow-wrap: anywhere;
  }
}
</style>

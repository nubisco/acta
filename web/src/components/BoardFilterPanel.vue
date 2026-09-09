<template>
  <div class="nb-inspector">
    <NbShellPanel title="Filters" fluid>
      <div class="filters">
        <div class="filters__head">
          <NbButton
            v-if="active"
            size="xs"
            variant="ghost"
            @click="emit('clear')"
          >
            Clear all
          </NbButton>
          <NbButton
            v-nb-tooltip="{ body: 'Close' }"
            size="xs"
            variant="ghost"
            icon="x"
            class="filters__close"
            aria-label="Close the filters panel"
            @click="emit('close')"
          />
        </div>

        <section class="filters__group">
          <h3 class="filters__title">Labels</h3>
          <p v-if="labelNames.length === 0" class="filters__none">
            This board has no labels yet.
          </p>
          <!-- Pills, not a dropdown: a label's colour is half of what
               identifies it, and a list of names in a closed select shows
               neither the colour nor which ones are on. -->
          <div v-else class="filters__pills" role="group" aria-label="Labels">
            <button
              v-for="name in labelNames"
              :key="name"
              type="button"
              class="filters__pill"
              :class="{ 'filters__pill--on': labels.includes(name) }"
              :aria-pressed="labels.includes(name)"
              @click="toggleLabel(name)"
            >
              <LabelBadge :name="name" />
            </button>
          </div>
          <p v-if="labelNames.length > 1" class="filters__hint">
            Cards matching any of the chosen labels.
          </p>
        </section>

        <section class="filters__group">
          <h3 class="filters__title">People</h3>
          <ActorFilter
            :model-value="assignees"
            label="Filter by assignee"
            @update:model-value="emit('update:assignees', $event)"
          />
        </section>

        <section class="filters__group">
          <h3 class="filters__title">Status</h3>
          <NbRadio
            name="board-filter-state"
            direction="horizontal"
            :options="stateOptions"
            :model-value="state"
            @update:model-value="emit('update:state', String($event))"
          />
        </section>
      </div>
    </NbShellPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * The board's filters, as a panel rather than a row of dropdowns.
 *
 * Four controls competing for the toolbar meant each was too narrow to show
 * what it held: the label select showed neither colour nor selection, and the
 * people select could only ever hold one person. Given the full width of the
 * side panel they can be what they actually are, coloured pills and avatars,
 * and the toolbar goes back to one icon.
 *
 * State stays in the board. This renders it and reports changes, so there is
 * one owner of what the board is filtered by and the panel can be mounted and
 * unmounted freely without carrying anything.
 */
import LabelBadge from '@/components/LabelBadge.vue'
import ActorFilter from '@/components/ActorFilter.vue'

const props = defineProps<{
  labels: string[]
  assignees: string[]
  state: string
  labelNames: string[]
  /** Whether anything is filtered, which is what makes "Clear all" worth showing. */
  active: boolean
}>()

const emit = defineEmits<{
  'update:labels': [value: string[]]
  'update:assignees': [value: string[]]
  'update:state': [value: string]
  clear: []
  close: []
}>()

const stateOptions = [
  { label: 'Open', value: 'open' },
  { label: 'Done', value: 'done' },
  { label: 'Archived', value: 'archived' },
  { label: 'All', value: 'all' },
]

function toggleLabel(name: string): void {
  emit(
    'update:labels',
    props.labels.includes(name)
      ? props.labels.filter((l) => l !== name)
      : [...props.labels, name],
  )
}
</script>

<style scoped lang="scss">
.filters {
  display: grid;
  gap: var(--nb-spacing-20);

  &__head {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--nb-spacing-4);
    min-block-size: 1.5rem;
  }

  &__close {
    margin-inline-start: var(--nb-spacing-8);
  }

  &__group {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__title {
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight, 600);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-text-subtle);
  }

  &__pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nb-spacing-8);
  }

  /* The pill itself carries the colour, so the button underneath only has to
     show whether it is on. Unselected pills are dimmed rather than outlined:
     an outline around a rounded badge reads as a second border. */
  &__pill {
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    border-radius: var(--nb-radius-full, 999px);
    opacity: 0.55;
    transition: opacity var(--nb-motion-fast, 120ms) ease;

    &:hover {
      opacity: 0.8;
    }

    &--on {
      opacity: 1;
      outline: 1px solid var(--nb-c-primary);
      outline-offset: 2px;
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
      outline-offset: 2px;
    }
  }

  &__none,
  &__hint {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }
}
</style>

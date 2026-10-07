<template>
  <div class="filters" role="group" aria-label="Filters">
    <!-- Rows of label + control, so the three groups read down the left edge
         and their contents run across. In a column each group stacked and the
         panel got tall; across the toolbar there is room to lay them out. -->
    <div class="filters__row">
      <span class="filters__label">Labels</span>
      <p v-if="labelIds.length === 0" class="filters__none">
        This space has no labels yet.
      </p>
      <!-- Pills, not a dropdown: a label's colour is half of what identifies
           it, and a list of names in a closed select shows neither the colour
           nor which ones are on. -->
      <div v-else class="filters__pills">
        <button
          v-for="id in labelIds"
          :key="id"
          type="button"
          class="filters__pill"
          :class="{ 'filters__pill--on': labels.includes(id) }"
          :aria-pressed="labels.includes(id)"
          @click="toggleLabel(id)"
        >
          <!-- Qualified: two pills both reading 1.12.0 are two different
               filters, and the group name is what tells them apart. -->
          <LabelBadge :id="id" qualify />
        </button>
      </div>
    </div>

    <div class="filters__row">
      <span class="filters__label">People</span>
      <ActorFilter
        :model-value="assignees"
        label="Filter by assignee"
        @update:model-value="emit('update:assignees', $event)"
      />
    </div>

    <div v-if="goalOptions.length > 1" class="filters__row">
      <span class="filters__label">Goal</span>
      <!-- A select rather than pills: goals are names, not colours, and
           there can be many. One at a time, since "serves either of two
           goals" is not a question anybody asks a board. -->
      <NbSelect
        id="field-space-filter-goal"
        size="sm"
        :model-value="goal === null ? '' : String(goal)"
        :options="goalOptions"
        aria-label="Filter by goal"
        @update:model-value="
          emit(
            'update:goal',
            $event === '' || $event === null ? null : Number($event),
          )
        "
      />
    </div>

    <div class="filters__row">
      <span class="filters__label">Status</span>
      <NbRadio
        name="space-filter-state"
        direction="horizontal"
        :options="stateOptions"
        :model-value="state"
        @update:model-value="emit('update:state', String($event))"
      />
    </div>

    <div class="filters__foot">
      <NbButton v-if="active" size="xs" variant="ghost" @click="emit('clear')">
        Clear all
      </NbButton>
      <NbButton
        v-nb-tooltip="{ body: 'Hide filters' }"
        size="xs"
        variant="ghost"
        icon="x"
        aria-label="Hide the filters"
        @click="emit('close')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The space's filters, as a panel rather than a row of dropdowns.
 *
 * Four controls competing for the toolbar meant each was too narrow to show
 * what it held: the label select showed neither colour nor selection, and the
 * people select could only ever hold one person. Given the full width of the
 * side panel they can be what they actually are, coloured pills and avatars,
 * and the toolbar goes back to one icon.
 *
 * State stays in the space. This renders it and reports changes, so there is
 * one owner of what the space is filtered by and the panel can be mounted and
 * unmounted freely without carrying anything.
 */
import { computed } from 'vue'
import LabelBadge from '@/components/LabelBadge.vue'
import ActorFilter from '@/components/ActorFilter.vue'
import { goalOptionLabel } from '@/lib/goals'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{
  labels: string[]
  assignees: string[]
  state: string
  /** The goal the cards must serve, by number. Null is any. */
  goal: number | null
  /** Every label this space can be filtered by, as ids. */
  labelIds: string[]
  /** Whether anything is filtered, which is what makes "Clear all" worth showing. */
  active: boolean
}>()

const emit = defineEmits<{
  'update:labels': [value: string[]]
  'update:assignees': [value: string[]]
  'update:state': [value: string]
  'update:goal': [value: number | null]
  clear: []
  close: []
}>()

const ws = useWorkspace()

/** Every goal not archived, plus whichever one is selected even if it is. */
const goalOptions = computed(() => [
  { label: 'Any goal', value: '' },
  ...(ws.overview.value?.goals ?? [])
    .filter((g) => !g.archived || g.number === props.goal)
    .map((g) => ({ label: goalOptionLabel(g), value: String(g.number) })),
])

const stateOptions = [
  { label: 'Open', value: 'open' },
  { label: 'Done', value: 'done' },
  { label: 'Archived', value: 'archived' },
  { label: 'All', value: 'all' },
]

function toggleLabel(id: string): void {
  emit(
    'update:labels',
    props.labels.includes(id)
      ? props.labels.filter((l) => l !== id)
      : [...props.labels, id],
  )
}
</script>

<style scoped lang="scss">
.filters {
  display: grid;
  /* One spine for the group names, content flowing across the rest. Sized to
     the longest label so the three rows line up without a table. */
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--nb-spacing-8) var(--nb-spacing-16);
  align-items: baseline;
  /* No surface of its own: this now renders inside an NbMenu, which is
     already a popover with its own background, border and radius. Painting a
     second box inside it was a box in a box. */
  padding: var(--nb-spacing-12) var(--nb-spacing-16);

  &__row {
    display: contents;
  }

  &__label {
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight);
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
    border-radius: var(--nb-radius-pill);
    opacity: 0.55;
    transition: opacity var(--nb-animation-fast) ease;

    &:hover {
      opacity: 0.8;
    }

    &--on {
      opacity: 1;
      outline: 1px solid var(--nb-c-primary);
      outline-offset: 2px;
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
    }
  }

  &__none {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }

  /* Spans both columns and sits hard right, so Clear and the dismiss are
     where the eye ends up rather than tucked under the labels. */
  &__foot {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--nb-spacing-4);
  }

  /* Narrow: the spine costs more than it gives, so labels sit above. */
  @media (max-inline-size: 40rem) {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--nb-spacing-4);
  }
}
</style>

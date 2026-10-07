<template>
  <div class="item-goals">
    <ul v-if="goals.length > 0" class="item-goals__list">
      <li v-for="goal in goals" :key="goal.number" class="item-goals__row">
        <RouterLink
          :to="wpath(`/goals/${goal.number}`)"
          class="item-goals__ref"
        >
          <span class="item-goals__key">{{ goal.key }}</span>
          <span class="item-goals__title">{{ goal.title }}</span>
          <GoalStatusBadge :status="goal.status" />
        </RouterLink>
        <!-- Inherited, and it says from where, because a card counting
             toward a goal nobody linked it to is otherwise a mystery. It can
             only be undone on the card the link is on. -->
        <span v-if="goal.via" class="item-goals__via">
          through {{ goal.via }}
        </span>
        <NbButton
          v-else
          v-nb-tooltip="{
            body: `Stop counting ${itemKey} toward ${goal.key}`,
          }"
          size="sm"
          variant="ghost"
          icon="x"
          :aria-label="`Unlink ${itemKey} from ${goal.key}`"
          @click="unlink(goal.number)"
        />
      </li>
    </ul>
    <p v-else class="item-goals__none">
      This card does not serve a goal yet. Linking it counts it, and everything
      that is part of it, toward the goal.
    </p>

    <NbSelect
      v-if="options.length > 0"
      :id="`field-item-goal-${itemKey}`"
      :model-value="null"
      size="sm"
      label="Serves a goal"
      placeholder="Link to a goal..."
      :options="options"
      :error="error"
      @update:model-value="link"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * The goals a card serves, on the card.
 *
 * Linked here, or inherited from something the card is part of. The second
 * kind is shown with where it comes from and cannot be removed here: it is
 * not this card's link to remove.
 */
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import { goalOptionLabel } from '@/lib/goals'
import { wpath } from '@/lib/paths'
import { useWorkspace } from '@/stores/workspace'
import type { IGoalRef } from '@/types/api'
import GoalStatusBadge from '@/components/goals/GoalStatusBadge.vue'

const props = defineProps<{
  itemKey: string
  goals: (IGoalRef & { via?: string })[]
}>()
const emit = defineEmits<{ changed: [] }>()

const ws = useWorkspace()
const error = ref<string | undefined>(undefined)

const options = computed(() => {
  const taken = new Set(props.goals.map((g) => g.number))
  return (ws.overview.value?.goals ?? [])
    .filter((g) => !g.archived && !taken.has(g.number))
    .map((g) => ({ label: goalOptionLabel(g), value: g.number }))
})

async function write(number: number, change: 'add' | 'remove'): Promise<void> {
  error.value = undefined
  try {
    const { results } = await api.goalWrite([
      { op: 'link', op_id: newOpId(), goal: number, [change]: [props.itemKey] },
    ])
    const result = results[0]
    if (!result.ok) {
      error.value = result.error
      return
    }
    emit('changed')
  } catch (err) {
    error.value = humanise(err)
  }
}

function link(value: unknown): void {
  if (value === null || value === undefined || value === '') return
  void write(Number(value), 'add')
}

function unlink(number: number): void {
  void write(number, 'remove')
}
</script>

<style scoped lang="scss">
.item-goals {
  display: grid;
  gap: var(--nb-spacing-12);

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-4);
  }

  &__row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    min-inline-size: 0;
  }

  &__ref {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    flex: 1;
    min-inline-size: 0;
    padding: var(--nb-spacing-4) var(--nb-spacing-8);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    color: inherit;
    text-decoration: none;

    &:hover {
      border-color: var(--nb-c-primary);
      background: var(--nb-c-surface-hover);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 1px;
    }
  }

  &__key {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__title {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--nb-type-body-sm-size);
  }

  &__via {
    flex: none;
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__none {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }
}
</style>

<template>
  <NbTreeNode
    :id="node.id"
    :label="`${node.card.key} ${node.card.title}`"
    :data-key="node.card.key"
    @select="emit('open', node.card.key)"
  >
    <template #label>
      <span class="goal-tree-row">
        <span
          class="goal-tree-row__key"
          :class="{ 'goal-tree-row__key--done': node.card.done }"
        >
          {{ node.card.key }}
        </span>
        <span class="goal-tree-row__title">{{ node.card.title }}</span>
      </span>
    </template>
    <template #meta>
      <span class="goal-tree-row__meta">
        <GoalCardPeople :assignees="node.card.assignees" />
        <GoalCardState :card="node.card" />
      </span>
    </template>

    <NbTreeNode
      v-for="blocker in node.blockers"
      :id="`${node.id}!${blocker.key}`"
      :key="`blocker-${blocker.key}`"
      :label="`${node.card.key} is blocked by ${blocker.key} ${blocker.title}`"
      :expandable="false"
      class="goal-tree-blocker"
      data-blocker
      @select="emit('open', blocker.key)"
    >
      <template #label>
        <span class="goal-tree-row">
          <NbBadge size="sm" variant="red" icon="prohibit">Blocked by</NbBadge>
          <span class="goal-tree-row__key">{{ blocker.key }}</span>
          <span class="goal-tree-row__title">{{ blocker.title }}</span>
        </span>
      </template>
      <template #meta>
        <span class="goal-tree-row__space">{{ blocker.space }}</span>
      </template>
    </NbTreeNode>
    <GoalCardTreeNode
      v-for="part in node.parts"
      :key="part.id"
      :node="part"
      @open="(key) => emit('open', key)"
    />
  </NbTreeNode>
</template>

<script setup lang="ts">
/**
 * One card in a goal's tree: the card, then what holds it up, then its parts,
 * each part drawn the same way at any depth.
 *
 * A blocker is a leaf marked in red. It is a pointer at another card, which
 * may live on another space and not serve the goal at all, so its own parts
 * and blockers are not followed: that is the blocker's own goal's business.
 */
import type { IGoalCardNode } from '@/lib/goals'
import GoalCardPeople from '@/components/goals/GoalCardPeople.vue'
import GoalCardState from '@/components/goals/GoalCardState.vue'

defineProps<{ node: IGoalCardNode }>()

const emit = defineEmits<{ open: [key: string] }>()
</script>

<style scoped lang="scss">
.goal-tree-row {
  display: inline-flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  min-inline-size: 0;

  &__key {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);

    &--done {
      text-decoration: line-through;
    }
  }

  &__title {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__meta {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__space {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }
}
</style>

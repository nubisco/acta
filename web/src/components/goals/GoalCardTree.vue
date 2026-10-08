<template>
  <NbTree
    ref="treeRef"
    size="sm"
    class="goal-card-tree"
    aria-label="Cards serving this goal, with their parts and blockers"
  >
    <GoalCardTreeNode
      v-for="node in nodes"
      :key="node.id"
      :node="node"
      @open="(key) => emit('open', key)"
    />
  </NbTree>
</template>

<script setup lang="ts">
/**
 * A goal's cards as a tree, the other way to read its card list: what each
 * linked card is made of, all the way down, and what is holding each one up.
 *
 * Opens fully expanded, because the reason to switch to it is to see the
 * depth. A branch somebody collapses stays collapsed when the goal reloads
 * under them; only a branch that is new opens itself.
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { NbTree } from '@nubisco/ui'
import { goalCardTree, type IGoalCardNode } from '@/lib/goals'
import type { IGoalCard } from '@/types/api'
import GoalCardTreeNode from '@/components/goals/GoalCardTreeNode.vue'

const props = defineProps<{ items: IGoalCard[] }>()

const emit = defineEmits<{ open: [key: string] }>()

const treeRef = ref<InstanceType<typeof NbTree> | null>(null)

const nodes = computed(() => goalCardTree(props.items))

/** Every node with something under it. */
function branches(list: IGoalCardNode[], out: string[] = []): string[] {
  for (const node of list) {
    if (node.parts.length > 0 || node.blockers.length > 0) out.push(node.id)
    branches(node.parts, out)
  }
  return out
}

const known = new Set<string>()

function openNew(): void {
  const fresh = branches(nodes.value).filter((id) => !known.has(id))
  for (const id of fresh) known.add(id)
  if (fresh.length > 0) treeRef.value?.expandIds(fresh)
}

onMounted(openNew)
watch(nodes, openNew)
</script>

<style scoped lang="scss">
.goal-card-tree {
  min-inline-size: 0;
}
</style>

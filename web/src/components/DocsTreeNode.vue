<template>
  <NbTreeNode
    :id="node.slug"
    :label="node.title"
    icon="file-text"
    :data-slug="node.slug"
  >
    <DocsTreeNode
      v-for="child in node.children"
      :key="child.slug"
      :node="child"
    />
  </NbTreeNode>
</template>

<script setup lang="ts">
import type { IDocTreeNode } from '@/types/docs'

defineProps<{ node: IDocTreeNode }>()
</script>

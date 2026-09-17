<template>
  <!--
    Every page is `droppable`, so a page can be dropped inside a page that has
    no subpages yet. NbTreeNode draws the expand caret only when the slot
    renders a child, so a leaf shows none.
  -->
  <NbTreeNode
    :id="node.slug"
    :label="node.title"
    icon="file-text"
    :data-slug="node.slug"
    droppable
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

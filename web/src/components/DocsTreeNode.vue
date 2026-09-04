<template>
  <NbTreeNode :id="node.slug" :label="node.title" icon="file-text">
    <DocsTreeNode
      v-for="child in node.children"
      :key="child.slug"
      :node="child"
    />
  </NbTreeNode>
</template>

<script setup lang="ts">
import { NbTreeNode } from '@nubisco/ui'
import type { IDocTreeNode } from '@/types/docs'

defineProps<{ node: IDocTreeNode }>()
</script>

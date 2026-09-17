<template>
  <!--
    Every page gets the children slot, including a page with no children yet.
    NbTreeNode (@nubisco/ui 5.3.0) only accepts a drop *inside* a row that has a
    slot, so leaving it off a leaf would make it impossible to drag a page into
    a page that has no subpages yet. The library also draws its expand caret
    for any slot, so a leaf is marked `data-leaf` and its caret is hidden in
    DocsTreePanel instead. Both belong in the library, see the note there.
  -->
  <NbTreeNode
    :id="node.slug"
    :label="node.title"
    icon="file-text"
    :data-slug="node.slug"
    :data-leaf="node.children?.length ? undefined : 'true'"
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

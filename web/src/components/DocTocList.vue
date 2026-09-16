<template>
  <!-- A nested list of in-page links, because that is what a table of
       contents is to assistive technology: links, grouped by section. -->
  <ol class="doc-toc-list" :class="{ 'doc-toc-list--nested': nested }">
    <li v-for="node in nodes" :key="node.slug">
      <a
        class="doc-toc-list__link"
        :class="{ 'doc-toc-list__link--active': node.slug === active }"
        :href="`#${node.slug}`"
        :aria-current="node.slug === active ? 'location' : undefined"
        :data-slug="node.slug"
        @click.prevent="emit('go', node.slug)"
        >{{ node.text }}</a
      >
      <DocTocList
        v-if="node.children.length > 0"
        :nodes="node.children"
        :active="active"
        nested
        @go="emit('go', $event)"
      />
    </li>
  </ol>
</template>

<script setup lang="ts">
import type { IOutlineNode } from '@/lib/docText'

defineProps<{
  nodes: IOutlineNode[]
  active: string | null
  nested?: boolean
}>()

const emit = defineEmits<{ go: [slug: string] }>()
</script>

<style scoped lang="scss">
.doc-toc-list {
  list-style: none;
  margin: 0;
  padding: 0;

  &--nested {
    padding-inline-start: var(--nb-spacing-12);
  }
}

.doc-toc-list__link {
  display: block;
  padding-block: var(--nb-spacing-2);
  padding-inline: var(--nb-spacing-8);
  border-inline-start: 2px solid transparent;
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-type-body-sm-size);
  line-height: var(--nb-type-body-sm-line-height);
  text-decoration: none;
  overflow-wrap: anywhere;

  &:hover {
    color: var(--nb-c-text);
  }

  &:focus-visible {
    outline: 2px solid var(--nb-c-focus-ring);
    outline-offset: -2px;
  }

  /* The section being read: an accent rule on the reading edge, the same
     "you are here" mark the tree uses for the selected page. */
  &--active {
    border-inline-start-color: var(--nb-c-primary);
    color: var(--nb-c-text);
    font-weight: 600;
  }
}
</style>

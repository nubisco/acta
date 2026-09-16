<template>
  <NodeViewWrapper
    as="blockquote"
    class="md__callout"
    :class="`md__callout--${kind}`"
    :data-callout="kind"
  >
    <svg
      class="md__callout-icon"
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
    >
      <path :d="glyph" />
    </svg>
    <strong v-if="title" class="md__callout-title" contenteditable="false">
      {{ title }}
    </strong>
    <NodeViewContent />
  </NodeViewWrapper>
</template>

<script setup lang="ts">
/**
 * A callout while editing, shown as the callout it is.
 *
 * The editor used to render it as an ordinary blockquote whose first line was
 * the literal text `[!NOTE]`, so people edited around a marker instead of
 * inside a callout, and the two surfaces disagreed about what they were
 * looking at. The classes are the reader's, so the styling is defined once.
 */
import { computed } from 'vue'
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/vue-3'
import { CALLOUT_ICON_PATHS } from '@/lib/callouts'

/* eslint-disable-next-line vue/prop-name-casing --
   NodeViewProps is Tiptap's type and carries `HTMLAttributes`. Renaming it
   would mean the node view no longer matches what Tiptap passes. */
const props = defineProps<NodeViewProps>()

const kind = computed(() => String(props.node.attrs.kind ?? 'note'))
const title = computed(() => String(props.node.attrs.title ?? '').trim())
const glyph = computed(
  () => CALLOUT_ICON_PATHS[kind.value] ?? CALLOUT_ICON_PATHS.info,
)
</script>

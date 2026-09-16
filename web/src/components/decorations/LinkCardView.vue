<template>
  <NodeViewWrapper class="md__card-slot" :data-link-card="url">
    <!-- The same markup the reader patches into its own HTML, from the same
         builder, so the card cannot look like one thing while editing and
         another while reading. Every value in it is escaped there. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <span class="md__card-hold" v-html="html" />
  </NodeViewWrapper>
</template>

<script setup lang="ts">
/**
 * A link preview card inside the editor.
 *
 * Its state while the metadata is in flight is the plain link, never a
 * spinner or an empty outline: a document opens before any preview has
 * landed, and a page of grey boxes that fill in one by one reads as a
 * document repairing itself rather than a document loading.
 */
import { computed } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import { linkCardHtml } from '@/components/decorations/linkCards'
import { useLinkPreviews } from '@/stores/linkPreviews'

/* eslint-disable-next-line vue/prop-name-casing --
   NodeViewProps is Tiptap's type and carries `HTMLAttributes`. Renaming it
   would mean the node view no longer matches what Tiptap passes. */
const props = defineProps<NodeViewProps>()

const store = useLinkPreviews()

const url = computed(() => String(props.node.attrs.url ?? ''))

const html = computed(() => {
  // Requesting inside a computed is deliberate, and the same thing RefChip
  // does: the store batches and de-duplicates, and this is the point at which
  // we know the URL is on screen.
  store.request(url.value)
  void store.version.value
  return linkCardHtml(url.value, store.previews.get(url.value))
})
</script>

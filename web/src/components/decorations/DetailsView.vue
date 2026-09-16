<template>
  <NodeViewWrapper
    as="div"
    class="md__details md__details--editing"
    :data-open="open ? 'true' : 'false'"
  >
    <!-- The control, not the title. A native <summary> toggles on any click,
         which cannot work here because the title is document text somebody
         has to be able to put the caret into. So the caret opens and closes
         it, and clicking the words edits them.

         A bare <button> rather than a library control: this is an affordance
         inside the document, at the size of the text around it, not a piece
         of application chrome. The same reasoning the callout icon follows. -->
    <button
      type="button"
      class="md__details-caret"
      contenteditable="false"
      :aria-expanded="open"
      :aria-label="open ? 'Collapse this section' : 'Expand this section'"
      @mousedown.prevent
      @click="open = !open"
    >
      <NbIcon :name="open ? 'caret-down' : 'caret-right'" :size="14" />
    </button>
    <NodeViewContent class="md__details-inner" />
  </NodeViewWrapper>
</template>

<script setup lang="ts">
/**
 * A toggle while editing, shown as the disclosure it is.
 *
 * Open or closed is local state, deliberately. It is how somebody is reading
 * the document, not something the document says, and there is nowhere in
 * `:::details` to record it. As a node attribute every click on the caret
 * would be a transaction, the editor would emit an update, and a page nobody
 * edited would come back dirty on close.
 *
 * Closed to begin with, which is what the reader does and what a toggle is
 * for. The classes are the reader's, so the two surfaces are styled once.
 */
import { ref } from 'vue'
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/vue-3'

/* eslint-disable-next-line vue/prop-name-casing --
   NodeViewProps is Tiptap's type and carries `HTMLAttributes`. Renaming it
   would mean the node view no longer matches what Tiptap passes. */
defineProps<NodeViewProps>()

const open = ref(false)
</script>

<template>
  <NodeViewWrapper
    v-if="!isMermaid"
    as="pre"
    class="md__code"
    :data-language="language || null"
  >
    <NodeViewContent
      as="code"
      :class="language ? `language-${language}` : null"
    />
  </NodeViewWrapper>

  <NodeViewWrapper
    v-else
    as="div"
    class="md__diagram"
    :class="{ 'is-editing': editing }"
    data-diagram="mermaid"
  >
    <!-- The source. Always in the document, hidden by CSS while the caret is
         elsewhere, which is why switching views cannot lose a line of it. -->
    <pre class="md__diagram-source"><NodeViewContent as="code" /></pre>

    <div
      v-if="error"
      class="md__diagram-error"
      role="note"
      @click="openSource"
      @keydown.enter="openSource"
    >
      {{ error }}
    </div>
    <!-- Sanitized: Mermaid renders with securityLevel 'strict', which keeps
         script and foreign HTML out of the SVG it returns. -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-else-if="svg"
      class="md__diagram-figure"
      contenteditable="false"
      role="img"
      :aria-label="'Diagram'"
      @click="openSource"
      v-html="svg"
    />
    <div v-else class="md__diagram-pending" contenteditable="false">
      Drawing diagram...
    </div>
    <!-- eslint-enable vue/no-v-html -->
  </NodeViewWrapper>
</template>

<script setup lang="ts">
/**
 * A fenced code block while editing, and a mermaid one drawn as a diagram.
 *
 * ## How editing works
 *
 * Source when the caret is inside the block, diagram when it is not. The
 * source is never a copy: it is the code block's own content, the same text
 * the serializer writes back between the fences, so the two views are two
 * renderings of one thing. Hiding the source is a CSS rule, not a discard, and
 * clicking the diagram puts the caret back in the text.
 *
 * That is also why this extends the existing code block rather than adding a
 * `mermaid` node. ```` ```mermaid ```` already parses and serializes correctly
 * as a code block. Replacing the node to draw a picture would have put a new
 * parse and a new serializer between every existing diagram and the file it
 * lives in, for no gain: the only thing missing was the drawing.
 *
 * A diagram that will not parse shows Mermaid's message where the picture
 * would be. Never a blank space, and never a thrown exception: `renderDiagram`
 * returns the error rather than raising it, so a half-typed diagram cannot
 * take the document with it.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/vue-3'
import { renderDiagram } from '@/components/decorations/mermaid'

/* eslint-disable-next-line vue/prop-name-casing --
   NodeViewProps is Tiptap's type and carries `HTMLAttributes`. Renaming it
   would mean the node view no longer matches what Tiptap passes. */
const props = defineProps<NodeViewProps>()

const language = computed(() => String(props.node.attrs.language ?? ''))
const isMermaid = computed(() => language.value.toLowerCase() === 'mermaid')
const source = computed(() => props.node.textContent)

const svg = ref('')
const error = ref('')
const editing = ref(false)

/** The caret is inside this block. Tiptap's `selected` only covers a node
 *  selection, and the ordinary way into a code block is a click into its text. */
function syncEditing(): void {
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  const { from, to } = props.editor.state.selection
  editing.value =
    props.editor.isFocused && from >= pos && to <= pos + props.node.nodeSize
}

props.editor.on('selectionUpdate', syncEditing)
props.editor.on('focus', syncEditing)
props.editor.on('blur', syncEditing)
onBeforeUnmount(() => {
  props.editor.off('selectionUpdate', syncEditing)
  props.editor.off('focus', syncEditing)
  props.editor.off('blur', syncEditing)
})
syncEditing()

watch(
  [source, isMermaid],
  async ([text, mermaid]) => {
    if (!mermaid) {
      svg.value = ''
      error.value = ''
      return
    }
    const result = await renderDiagram(text)
    // The block may have been edited again while Mermaid was in flight.
    if (text !== source.value) return
    svg.value = 'svg' in result ? result.svg : ''
    error.value = 'error' in result ? result.error : ''
  },
  { immediate: true },
)

/** Clicking the picture is how you get at the text that made it. */
function openSource(): void {
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  props.editor
    .chain()
    .focus()
    .setTextSelection(pos + 1)
    .run()
}
</script>

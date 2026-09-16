<template>
  <NodeViewWrapper
    :as="display ? 'div' : 'span'"
    :class="[
      display ? 'md__math' : 'md__math-inline',
      { 'is-editing': selected },
    ]"
    :data-math="latex"
  >
    <!-- Sanitized: KaTeX output, from KaTeX's own serializer. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <span v-if="!selected && html" class="md__math-render" v-html="html" />
    <span v-else-if="!selected && error" class="md__math-error">{{
      error
    }}</span>
    <!-- Before the first render lands, the source IS the correct content. -->
    <span v-else-if="!selected" class="md__math-source">{{ latex }}</span>

    <textarea
      v-if="selected"
      ref="field"
      class="md__math-input"
      :rows="display ? Math.max(1, latex.split('\n').length) : 1"
      :value="latex"
      spellcheck="false"
      :aria-label="display ? 'Formula source' : 'Inline formula source'"
      @input="onInput"
      @keydown.stop
      @mousedown.stop
    />
    <span v-if="selected && error" class="md__math-error">{{ error }}</span>
  </NodeViewWrapper>
</template>

<script setup lang="ts">
/**
 * A formula while editing.
 *
 * Rendered when it is not selected, source when it is. Clicking an atom node
 * selects it, so a click is what opens the source, and clicking away closes
 * it. The two states show the same attribute: the field writes every keystroke
 * back through `updateAttributes`, so what is on screen and what will be saved
 * are never two different things, and hiding the field hides a view rather
 * than discarding text.
 *
 * A formula that will not parse renders its error inline, in both states. It
 * never renders as a gap, and it never throws: `renderMath` returns the
 * message rather than raising it, because one typo must not take the document
 * down with it.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import { renderMath } from '@/components/decorations/katex'

/* eslint-disable-next-line vue/prop-name-casing --
   NodeViewProps is Tiptap's type and carries `HTMLAttributes`. Renaming it
   would mean the node view no longer matches what Tiptap passes. */
const props = defineProps<NodeViewProps>()

const display = computed(() => props.node.type.name === 'mathBlock')
const latex = computed(() => String(props.node.attrs.latex ?? ''))

const html = ref('')
const error = ref('')
const field = ref<HTMLTextAreaElement | null>(null)

watch(
  latex,
  async (value) => {
    if (!value.trim()) {
      html.value = ''
      error.value = ''
      return
    }
    const result = await renderMath(value, display.value)
    // The node may have changed again while KaTeX was in flight.
    if (value !== latex.value) return
    html.value = 'html' in result ? result.html : ''
    error.value = 'error' in result ? result.error : ''
  },
  { immediate: true },
)

// Selecting the node is the gesture that opens the source, so the caret
// belongs in the field without a second click.
watch(
  () => props.selected,
  async (now) => {
    if (!now) return
    await nextTick()
    field.value?.focus()
  },
)

function onInput(event: Event): void {
  props.updateAttributes({
    latex: (event.target as HTMLTextAreaElement).value,
  })
}
</script>

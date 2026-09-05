<template>
  <EditorContent :editor="editor" class="md-editor" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  autofocus?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  blur: []
}>()

/**
 * The document IS the editing surface (Typora-style): markdown in, markdown
 * out, WYSIWYG in between. Constructs the editor cannot represent (callouts,
 * :::details, [[refs]]) survive as their literal text, so the enhanced-
 * Markdown contract is never destroyed by an edit.
 */
const editor = new Editor({
  content: props.modelValue,
  autofocus: props.autofocus ? 'end' : false,
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      codeBlock: {},
    }),
    Link.configure({ openOnClick: false }),
    Placeholder.configure({
      placeholder: props.placeholder ?? 'Type here...',
    }),
    Markdown.configure({
      html: false,
      linkify: true,
      breaks: false,
      transformPastedText: true,
    }),
  ],
  onBlur: () => emit('blur'),
  onUpdate: ({ editor: instance }) => {
    emit(
      'update:modelValue',
      (
        instance.storage as { markdown: { getMarkdown: () => string } }
      ).markdown.getMarkdown(),
    )
  },
})

watch(
  () => props.modelValue,
  (value) => {
    const current = (
      editor.storage as { markdown: { getMarkdown: () => string } }
    ).markdown.getMarkdown()
    if (value !== current) editor.commands.setContent(value)
  },
)

onBeforeUnmount(() => editor.destroy())

defineExpose({ focus: () => editor.commands.focus('end') })
</script>

<style scoped lang="scss">
.md-editor {
  :deep(.tiptap) {
    outline: none;
    min-height: 8rem;
    line-height: var(--nb-type-body-md-line-height);
    caret-color: var(--nb-c-primary);

    > * + * {
      margin-block-start: var(--nb-spacing-8);
    }

    p,
    li,
    blockquote {
      max-width: 68ch;
    }

    h1,
    h2,
    h3,
    h4 {
      margin-block: var(--nb-spacing-24) var(--nb-spacing-8);

      &:first-child {
        margin-block-start: 0;
      }
    }

    ul,
    ol {
      padding-inline-start: var(--nb-spacing-24);
    }

    blockquote {
      border-inline-start: 2px solid var(--nb-c-border);
      padding-inline-start: var(--nb-spacing-12);
      margin-inline: 0;
      color: var(--nb-c-text-muted);
    }

    pre {
      overflow-x: auto;
      padding: var(--nb-spacing-12);
      border-radius: var(--nb-radius-sm, 8px);
      background: var(--nb-c-surface);
      border: 1px solid var(--nb-c-border);
      font-family: var(--nb-font-family-mono);
      font-size: var(--nb-type-code-sm-size);
    }

    code {
      font-family: var(--nb-font-family-mono);
      font-size: var(--nb-type-code-sm-size);
    }

    a {
      color: var(--nb-c-primary);
    }

    hr {
      border: 0;
      border-block-start: 1px solid var(--nb-c-border);
      margin-block: var(--nb-spacing-16);
    }

    p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: inline-start;
      color: var(--nb-c-text-subtle);
      pointer-events: none;
      height: 0;
    }
  }
}
</style>

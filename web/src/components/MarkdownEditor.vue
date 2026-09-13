<template>
  <BubbleMenu
    :editor="editor"
    :tippy-options="{ duration: 120 }"
    class="md-editor__bubble"
  >
    <button
      v-for="action in bubbleActions"
      :key="action.label"
      type="button"
      class="md-editor__bubble-btn"
      :class="{ 'is-active': action.isActive() }"
      :aria-label="action.label"
      :aria-pressed="action.isActive()"
      @click="action.run"
    >
      <NbIcon :name="action.icon" :size="15" />
    </button>
  </BubbleMenu>
  <EditorContent :editor="editor" class="md-editor" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { BubbleMenu, Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import {
  MentionTypeahead,
  RefTypeahead,
  SlashMenu,
} from '@/components/editor/suggestions'

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
    // The reader renders GFM tables and task lists. Without the matching
    // nodes here the editor did not merely fail to CREATE them: opening a
    // document that contained one and saving dropped it, because a node the
    // schema does not know is a node the serializer cannot write back.
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({
      placeholder: props.placeholder ?? 'Type here...',
    }),
    Markdown.configure({
      html: false,
      linkify: true,
      breaks: true,
      transformPastedText: true,
    }),
    // `[[` searches docs and cards; `/` opens the insert menu. Both write
    // plain enhanced-markdown, keeping editor and reader byte-compatible.
    RefTypeahead,
    MentionTypeahead,
    SlashMenu,
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

/* The selection bubble: inline styling first, block moves after. */
const bubbleActions = [
  {
    label: 'Bold',
    icon: 'text-b',
    isActive: () => editor.isActive('bold'),
    run: () => editor.chain().focus().toggleBold().run(),
  },
  {
    label: 'Italic',
    icon: 'text-italic',
    isActive: () => editor.isActive('italic'),
    run: () => editor.chain().focus().toggleItalic().run(),
  },
  {
    label: 'Strikethrough',
    icon: 'text-strikethrough',
    isActive: () => editor.isActive('strike'),
    run: () => editor.chain().focus().toggleStrike().run(),
  },
  {
    label: 'Inline code',
    icon: 'code',
    isActive: () => editor.isActive('code'),
    run: () => editor.chain().focus().toggleCode().run(),
  },
  {
    label: 'Heading 2',
    icon: 'text-h-two',
    isActive: () => editor.isActive('heading', { level: 2 }),
    run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: 'Heading 3',
    icon: 'text-h-three',
    isActive: () => editor.isActive('heading', { level: 3 }),
    run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: 'Bullet list',
    icon: 'list-bullets',
    isActive: () => editor.isActive('bulletList'),
    run: () => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    icon: 'list-numbers',
    isActive: () => editor.isActive('orderedList'),
    run: () => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    icon: 'quotes',
    isActive: () => editor.isActive('blockquote'),
    run: () => editor.chain().focus().toggleBlockquote().run(),
  },
]
</script>

<style scoped lang="scss">
.md-editor__bubble {
  display: flex;
  gap: 2px;
  padding: var(--nb-spacing-2);
  background: var(--nb-c-layer-3);
  border: 1px solid var(--nb-c-layer-border-3);
  border-radius: var(--nb-radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  z-index: var(--nb-zindex-dropdown);
}

.md-editor__bubble-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 28px;
  block-size: 28px;
  border: 0;
  border-radius: var(--nb-radius-sm);
  background: transparent;
  color: var(--nb-c-text);
  cursor: pointer;

  &:hover {
    background: var(--nb-c-surface-hover);
  }

  &.is-active {
    background: var(--nb-c-primary);
    color: var(--nb-c-primary-a11y);
  }

  &:focus-visible {
    outline: 2px solid var(--nb-c-focus-ring);
    outline-offset: 1px;
  }
}

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
      border-radius: var(--nb-radius-sm);
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

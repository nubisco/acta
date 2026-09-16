<template>
  <!--
    The one toolbar a text selection in the editor gets: formatting, and the
    comment action when the page can take comments.

    There used to be two. Tiptap's bubble menu (raw buttons, placed by
    tippy.js) held the formatting, and the inline comment layer added a
    floating toolbar of its own for the same selection, so both appeared on
    top of each other above the selected text. The comment layer now leaves
    editor selections to this, and keeps its own toolbar for the reader, which
    has nothing to format.

    NbFloatingToolbar never takes focus and cancels the mousedown, so pressing
    a button leaves the selection it acts on exactly where it was.
  -->
  <NbFloatingToolbar
    :open="!!range"
    :anchor="anchor"
    placement="top"
    label="Selection"
  >
    <NbButton
      v-for="action in ACTIONS"
      :key="action.id"
      v-nb-tooltip="{ body: action.label }"
      size="xs"
      variant="ghost"
      :icon="action.icon"
      :aria-label="action.label"
      :aria-pressed="pressed[action.id] ?? false"
      :class="{ 'is-active': pressed[action.id] }"
      :data-action="action.id"
      @click="run(action)"
    />
    <NbButton
      v-if="commentable"
      v-nb-tooltip="{ body: 'Comment on this text' }"
      size="xs"
      variant="ghost"
      icon="chat-circle-text"
      aria-label="Comment on this text"
      data-action="comment"
      @click="comment"
    />
  </NbFloatingToolbar>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { posToDOMRect, type Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { anchorFromDocRange, docTextIndex, type IAnchor } from '@/lib/anchors'

const props = defineProps<{
  editor: Editor
  /** Offer "Comment on this text". Only a page that stores comments can. */
  commentable?: boolean
}>()

const emit = defineEmits<{
  /** Somebody wants to comment on the selected text. */
  comment: [anchor: IAnchor]
}>()

interface IAction {
  id: string
  label: string
  icon: string
  isActive: (editor: Editor) => boolean
  run: (editor: Editor) => void
}

/* Inline styling first, block moves after, as the bubble menu had them. */
const ACTIONS: IAction[] = [
  {
    id: 'bold',
    label: 'Bold',
    icon: 'text-b',
    isActive: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    label: 'Italic',
    icon: 'text-italic',
    isActive: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: 'strike',
    label: 'Strikethrough',
    icon: 'text-strikethrough',
    isActive: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    id: 'code',
    label: 'Inline code',
    icon: 'code',
    isActive: (e) => e.isActive('code'),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
  {
    id: 'heading2',
    label: 'Heading 2',
    icon: 'text-h-two',
    isActive: (e) => e.isActive('heading', { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'heading3',
    label: 'Heading 3',
    icon: 'text-h-three',
    isActive: (e) => e.isActive('heading', { level: 3 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'bulletList',
    label: 'Bullet list',
    icon: 'list-bullets',
    isActive: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    label: 'Numbered list',
    icon: 'list-numbers',
    isActive: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'blockquote',
    label: 'Quote',
    icon: 'quotes',
    isActive: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
]

/** The selected range, or null when there is nothing to act on. */
const range = ref<{ from: number; to: number } | null>(null)
/** A live rectangle, so the toolbar follows the selection when the page scrolls. */
const anchor = shallowRef<{ getBoundingClientRect(): DOMRect } | null>(null)
/**
 * Which formatting is on for the selection. Mirrored into a ref because the
 * editor is not reactive: nothing re-renders when its state changes unless
 * something tells Vue.
 */
const pressed = ref<Record<string, boolean>>({})

function rectOf(from: number, to: number): DOMRect {
  const editor = props.editor
  try {
    return posToDOMRect(editor.view, from, to)
  } catch {
    // Coordinates can be unavailable for a moment while the view redraws.
    // The editor's own box keeps the toolbar near the text rather than at 0,0.
    return editor.view.dom.getBoundingClientRect()
  }
}

function read(): void {
  const editor = props.editor
  if (editor.isDestroyed) {
    range.value = null
    return
  }
  const { selection } = editor.state
  const show =
    editor.isEditable &&
    editor.view.hasFocus() &&
    selection instanceof TextSelection &&
    !selection.empty &&
    // A selection of nothing but block boundaries has no text to style.
    editor.state.doc.textBetween(selection.from, selection.to, ' ').trim() !==
      ''
  if (!show) {
    range.value = null
    anchor.value = null
    return
  }
  const { from, to } = selection
  if (range.value?.from !== from || range.value?.to !== to) {
    range.value = { from, to }
    anchor.value = { getBoundingClientRect: () => rectOf(from, to) }
  }
  const next: Record<string, boolean> = {}
  for (const action of ACTIONS) next[action.id] = action.isActive(editor)
  pressed.value = next
}

function run(action: IAction): void {
  action.run(props.editor)
  read()
}

function comment(): void {
  const current = range.value
  if (!current) return
  const made = anchorFromDocRange(
    docTextIndex(props.editor.state.doc),
    current.from,
    current.to,
  )
  if (made) emit('comment', made)
}

props.editor.on('transaction', read)
props.editor.on('focus', read)
props.editor.on('blur', read)

onBeforeUnmount(() => {
  props.editor.off('transaction', read)
  props.editor.off('focus', read)
  props.editor.off('blur', read)
})

defineExpose({ range })
</script>

<style scoped lang="scss">
/* The state the bubble menu showed: which formatting the selection has.
   Same treatment the image controls give their pressed alignment. */
.is-active {
  background: var(--nb-c-primary);
  color: var(--nb-c-primary-a11y);
}
</style>

<template>
  <!--
    The comment action for a text selection in the reader. A floating toolbar
    because it never takes focus and swallows the mousedown, so clicking it
    leaves the selection exactly as it was: the anchor is read from that
    selection.

    Reader only. A selection in the editor gets the editor's own toolbar
    (editor/SelectionToolbar.vue), which carries this action beside the
    formatting. Two toolbars for one selection drew on top of each other.
  -->
  <NbFloatingToolbar
    :open="!!selection"
    :anchor="selection?.rect ?? null"
    placement="top"
    label="Selection"
  >
    <NbButton
      v-nb-tooltip="{ body: 'Comment on this text' }"
      size="xs"
      variant="ghost"
      icon="chat-circle-text"
      aria-label="Comment on this text"
      @click="compose"
    />
  </NbFloatingToolbar>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import { anchorFromDomRange, domTextIndex, type IAnchor } from '@/lib/anchors'
import {
  COMMENT_OPEN_EVENT,
  setCommentHighlights,
  type ICommentHighlight,
} from './commentHighlights'
import {
  clearHighlights,
  highlightAt,
  locateHighlights,
  paintHighlights,
  type IPaintedHighlight,
} from './readerHighlights'

/**
 * Inline comments on a document page: the selection action, and the
 * highlights on whichever surface is showing, reader or editor.
 *
 * Owns no data. It is handed the comments and reports two things back: a
 * selection somebody wants to comment on (`compose`), and a highlight
 * somebody clicked (`open`). Where the thread lives and how a comment is
 * saved stay with the page, so this can sit on any surface that renders a
 * document.
 */

/** Id of the highlight shown for a comment still being written. */
const PENDING_ID = 'pending'

const props = defineProps<{
  /** The reader's element, when the document is being read. */
  reader?: HTMLElement | null
  /** The editor, when the document is being edited. */
  editor?: Editor | null
  comments: {
    id: string
    anchor?: IAnchor
    resolved?: unknown
  }[]
  /** The anchor of a comment being written, highlighted until it is sent. */
  pending?: IAnchor | null
  /** The comment whose thread is open, highlighted more strongly. */
  activeId?: string | null
}>()

const emit = defineEmits<{
  compose: [anchor: IAnchor]
  open: [id: string]
}>()

/** Resolved comments keep their anchor and lose their highlight. */
const highlights = computed<ICommentHighlight[]>(() => {
  const out: ICommentHighlight[] = props.comments
    .filter((c) => c.anchor && !c.resolved)
    .map((c) => ({ id: c.id, anchor: c.anchor! }))
  if (props.pending) out.push({ id: PENDING_ID, anchor: props.pending })
  return out
})

const active = computed(() =>
  props.pending ? PENDING_ID : (props.activeId ?? null),
)

/** The document text inside the reader, without its show-more control. */
function readerRoot(): HTMLElement | null {
  const el = props.reader
  if (!el) return null
  return el.querySelector<HTMLElement>('.md') ?? el
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface ISelection {
  rect: { getBoundingClientRect(): DOMRect }
  anchor: () => IAnchor | null
}

const selection = ref<ISelection | null>(null)

function readSelection(): void {
  const sel = document.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selection.value = null
    return
  }
  const range = sel.getRangeAt(0).cloneRange()
  const common = range.commonAncestorContainer
  const root = readerRoot()
  const inReader =
    !!root &&
    !props.editor &&
    root.contains(common) &&
    !!range.toString().trim()
  if (!inReader) {
    selection.value = null
    return
  }
  const anchor = () => anchorFromDomRange(domTextIndex(root), range)
  // A live rectangle, so the action follows the selection when the page
  // scrolls rather than staying where the selection used to be.
  selection.value = {
    rect: { getBoundingClientRect: () => range.getBoundingClientRect() },
    anchor,
  }
}

function compose(): void {
  const made = selection.value?.anchor()
  selection.value = null
  if (made) emit('compose', made)
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

let painted: IPaintedHighlight[] = []
let frame = 0

function paintReader(): void {
  const root = readerRoot()
  if (!root || props.editor) {
    painted = []
    clearHighlights()
    return
  }
  painted = locateHighlights(root, highlights.value)
  paintHighlights(painted, active.value)
}

/** Once per frame at most: hydration rewrites the reader in bursts. */
function schedulePaint(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    paintReader()
  })
}

function paintEditor(): void {
  const editor = props.editor
  if (!editor || editor.isDestroyed) return
  setCommentHighlights(editor.view, highlights.value, active.value)
}

let observer: MutationObserver | null = null

watch(
  () => props.reader,
  (el) => {
    observer?.disconnect()
    observer = null
    if (el && typeof MutationObserver !== 'undefined') {
      // The reader renders and hydrates after it mounts, and again whenever
      // the document or its reference cards change. Each of those replaces
      // text nodes, which invalidates any range painted over them.
      observer = new MutationObserver(schedulePaint)
      observer.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
    paintReader()
  },
  { immediate: true, flush: 'post' },
)

watch([highlights, active], () => {
  paintReader()
  paintEditor()
})

function onEditorOpen(event: Event): void {
  const id = (event as CustomEvent<{ id: string }>).detail?.id
  if (id && id !== PENDING_ID) emit('open', id)
}

watch(
  () => props.editor,
  (editor, previous) => {
    if (previous && !previous.isDestroyed)
      previous.view.dom.removeEventListener(COMMENT_OPEN_EVENT, onEditorOpen)
    if (editor && !editor.isDestroyed) {
      editor.view.dom.addEventListener(COMMENT_OPEN_EVENT, onEditorOpen)
      paintEditor()
    }
    paintReader()
  },
  { immediate: true, flush: 'post' },
)

function onReaderClick(event: MouseEvent): void {
  const root = readerRoot()
  if (!root || props.editor || !root.contains(event.target as Node)) return
  const sel = document.getSelection()
  if (sel && !sel.isCollapsed) return
  const id = highlightAt(painted, event.clientX, event.clientY)
  if (id && id !== PENDING_ID) emit('open', id)
}

onMounted(() => {
  document.addEventListener('selectionchange', readSelection)
  document.addEventListener('click', onReaderClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', readSelection)
  document.removeEventListener('click', onReaderClick)
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  const editor = props.editor
  if (editor && !editor.isDestroyed) {
    editor.view.dom.removeEventListener(COMMENT_OPEN_EVENT, onEditorOpen)
    setCommentHighlights(editor.view, [])
  }
  clearHighlights()
})
</script>

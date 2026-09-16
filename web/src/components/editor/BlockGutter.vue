<template>
  <!--
    The gutter beside a top-level block: `+` to insert below it, and a grip
    that moves it and opens its actions.

    Top-level blocks only, never the innermost one under the pointer. See
    blockOps.ts for why: a top-level block is the unit markdown is written in,
    so moving or deleting one always leaves a file that reads back the same,
    and it is the same unit focus mode dims. A grip per list item or table
    cell would also mean a column of grips jumping about as the pointer
    crosses nested content.
  -->
  <div
    v-if="current !== null"
    ref="gutterEl"
    class="md-gutter"
    :class="{ 'md-gutter--quiet': quiet && !pinned }"
    :style="{ insetBlockStart: `${top}px` }"
    data-testid="block-gutter"
    @focusout="onFocusOut"
  >
    <NbButton
      ref="plusRef"
      v-nb-tooltip="{ body: 'Insert a block below' }"
      size="xs"
      variant="ghost"
      icon="plus"
      aria-label="Insert a block below"
      aria-haspopup="menu"
      :aria-expanded="insertOpen"
      @click="openInsert"
    />
    <!-- Enter opens the actions, captured before the handle sees it. Space
         still picks the block up, so both jobs have a key. -->
    <span class="md-gutter__handle" @keydown.capture="onHandleKeydown">
      <NbDragHandle
        ref="handleRef"
        v-nb-tooltip="{ body: 'Drag to move, click for actions' }"
        :label="handleLabel"
        :instructions="INSTRUCTIONS"
        :announcement="announcement"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @drag-start="onDragStart"
        @drag-move="onDragMove"
        @drag-end="onDragEnd"
        @drag-cancel="onDragCancel"
        @click="openMenu"
      />
    </span>
  </div>

  <div
    v-if="dropLine !== null"
    class="md-gutter__drop"
    :style="{ insetBlockStart: `${dropLine}px` }"
    aria-hidden="true"
    data-testid="block-drop-line"
  />

  <NbMenu ref="menuRef" :open="menuOpen" size="sm" @close="onMenuClose">
    <template v-if="menuView === 'main'">
      <NbMenuItem
        v-if="conversions.length > 0"
        icon="arrows-clockwise"
        label="Turn into"
        data-testid="block-turn-into"
        @select="nextView = 'turnInto'"
      >
        <template #trailing>
          <NbIcon name="caret-right" :size="14" aria-hidden="true" />
        </template>
      </NbMenuItem>
      <NbMenuItem icon="copy" label="Duplicate" @select="duplicate" />
      <NbMenuItem
        icon="link"
        :label="
          linkable ? 'Copy link to block' : 'Copy link to block (no text)'
        "
        :disabled="!linkable"
        @select="copyLink"
      />
      <NbMenuDivider />
      <NbMenuItem icon="trash" label="Delete" danger @select="remove" />
    </template>
    <template v-else>
      <NbMenuItem icon="arrow-left" label="Back" @select="nextView = 'main'" />
      <NbMenuDivider />
      <NbMenuItem
        v-for="option in conversions"
        :key="option.target"
        :icon="option.icon"
        :label="
          option.warning ? `${option.label} (${option.warning})` : option.label
        "
        :data-target="option.target"
        @select="convert(option.target)"
      />
    </template>
  </NbMenu>

  <NbMenu ref="insertRef" :open="insertOpen" size="sm" @close="onInsertClose">
    <NbMenuItem
      v-for="item in insertItems"
      :key="item.id"
      :icon="item.icon"
      :label="item.label"
      :data-insert="item.id"
      @select="insert(item)"
    />
  </NbMenu>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue'
import type { Editor } from '@tiptap/core'
import { useToast } from '@nubisco/ui'
import {
  blockConversions,
  convertBlock,
  deleteBlock,
  duplicateBlock,
  insertParagraphBelow,
  moveBlock,
  topBlock,
  topBlockIndexAt,
  type TBlockKind,
} from '@/components/editor/blockOps'
import {
  slashItems,
  type ISuggestionItem,
} from '@/components/editor/suggestions'
import { blockAnchor, blockLinkUrl } from '@/lib/blockLinks'

const props = defineProps<{
  editor: Editor
  /** The positioned element the gutter is placed against. */
  frame: HTMLElement | null
}>()

const toast = useToast()

const INSTRUCTIONS =
  'Press Enter for block actions. Press Space to pick the block up, the arrow keys to move it, Space to drop it, and Escape to cancel.'

interface IMenuLike {
  setPosition(rect: {
    top: number
    left: number
    bottom: number
    width: number
  }): void
}
interface IHandleLike {
  grabbed: boolean
  el: HTMLButtonElement | null
}

const gutterEl = ref<HTMLElement | null>(null)
const handleRef = ref<IHandleLike | null>(null)
const plusRef = ref<{ $el: HTMLElement } | null>(null)
const menuRef = ref<IMenuLike | null>(null)
const insertRef = ref<IMenuLike | null>(null)

// ---------------------------------------------------------------------------
// Which block
// ---------------------------------------------------------------------------

/** The block under the pointer. */
const hoverIndex = ref<number | null>(null)
/** The block holding the caret, while the editor or the gutter has focus. */
const caretIndex = ref<number | null>(null)
/** The block a menu or a drag is about, held until it is finished. */
const heldIndex = ref<number | null>(null)

const current = computed(
  () => heldIndex.value ?? hoverIndex.value ?? caretIndex.value,
)

/**
 * Hidden while somebody types, so a grip is not flickering beside every line
 * as it is written. Moving the pointer or tabbing into the gutter brings it
 * back.
 */
const quiet = ref(false)
const menuOpen = ref(false)
const insertOpen = ref(false)
const drag = ref<{ from: number; to: number } | null>(null)
const pinned = computed(
  () => menuOpen.value || insertOpen.value || drag.value !== null,
)

/** Marks the gutter's own edits, which are not somebody typing. */
const GUTTER_META = 'actaBlockGutter'

/** Bumped on every transaction, so what is derived from the state refreshes. */
const version = ref(0)

const top = ref(0)
const dropLine = ref<number | null>(null)
const announcement = ref('')

function view() {
  return props.editor.view
}

function blockElement(index: number): HTMLElement | null {
  const block = topBlock(props.editor.state.doc, index)
  if (!block) return null
  const dom = view().nodeDOM(block.pos)
  return dom instanceof HTMLElement ? dom : null
}

/** The top-level block an element belongs to, by walking up to the root. */
function indexOfElement(target: EventTarget | null): number | null {
  if (!(target instanceof Node)) return null
  const root = view().dom
  let node: Node | null = target
  while (node && node.parentNode !== root) node = node.parentNode
  if (!node) return null
  const doc = props.editor.state.doc
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    if (view().nodeDOM(pos) === node) return i
    pos += doc.child(i).nodeSize
  }
  return null
}

function frameTop(): number {
  return props.frame?.getBoundingClientRect().top ?? 0
}

function measure(): void {
  const index = current.value
  if (index === null) return
  const el = blockElement(index)
  if (!el) return
  top.value = el.getBoundingClientRect().top - frameTop()
}

watch(current, () => void nextTick(measure))

function onMouseMove(event: MouseEvent): void {
  quiet.value = false
  if (pinned.value) return
  // Over the gutter itself, or between blocks: keep the block already shown,
  // so the pointer can travel from the text to the grip.
  if (gutterEl.value?.contains(event.target as Node)) return
  const index = indexOfElement(event.target)
  if (index !== null) hoverIndex.value = index
}

function onMouseLeave(): void {
  hoverIndex.value = null
}

function readCaret(): void {
  const editor = props.editor
  if (editor.isDestroyed) return
  if (editor.view.hasFocus())
    caretIndex.value = topBlockIndexAt(
      editor.state.doc,
      editor.state.selection.from,
    )
}

function onTransaction({
  transaction,
}: {
  transaction: { docChanged: boolean; getMeta(key: string): unknown }
}): void {
  version.value += 1
  const doc = props.editor.state.doc
  // A block that is not there any more cannot keep its grip.
  for (const index of [hoverIndex, caretIndex, heldIndex])
    if (index.value !== null && index.value >= doc.childCount)
      index.value = doc.childCount - 1
  if (transaction.docChanged && !transaction.getMeta(GUTTER_META))
    quiet.value = true
  readCaret()
  void nextTick(measure)
}

function onEditorBlur({ event }: { event: FocusEvent }): void {
  // Tabbing from the text into the gutter keeps the gutter.
  if (gutterEl.value?.contains(event.relatedTarget as Node)) return
  if (!pinned.value) caretIndex.value = null
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (gutterEl.value?.contains(next) || view().dom.contains(next)) return
  if (!pinned.value) caretIndex.value = null
}

function dispatch(tr: Parameters<typeof props.editor.view.dispatch>[0]) {
  view().dispatch(tr.setMeta(GUTTER_META, true))
}

props.editor.on('transaction', onTransaction)
props.editor.on('focus', readCaret)
props.editor.on('blur', onEditorBlur)

watch(
  () => props.frame,
  (frame, previous) => {
    previous?.removeEventListener('mousemove', onMouseMove)
    previous?.removeEventListener('mouseleave', onMouseLeave)
    frame?.addEventListener('mousemove', onMouseMove, { passive: true })
    frame?.addEventListener('mouseleave', onMouseLeave)
  },
  { immediate: true },
)

function onResize(): void {
  measure()
}
window.addEventListener('resize', onResize)

onBeforeUnmount(() => {
  props.editor.off('transaction', onTransaction)
  props.editor.off('focus', readCaret)
  props.editor.off('blur', onEditorBlur)
  props.frame?.removeEventListener('mousemove', onMouseMove)
  props.frame?.removeEventListener('mouseleave', onMouseLeave)
  window.removeEventListener('resize', onResize)
})

// ---------------------------------------------------------------------------
// What the block is
// ---------------------------------------------------------------------------

const handleLabel = computed(() => {
  void version.value
  const index = current.value
  const block = index === null ? null : topBlock(props.editor.state.doc, index)
  if (!block) return 'Block'
  const text = block.node.textContent.replace(/\s+/g, ' ').trim()
  const name = text
    ? text.length > 40
      ? `${text.slice(0, 40)}...`
      : text
    : block.node.type.name
  return `Block ${index! + 1}: ${name}`
})

/** Read when the menu opens, not live, so the list does not change under it. */
const conversions = shallowRef<ReturnType<typeof blockConversions>>([])
const linkable = ref(false)

// ---------------------------------------------------------------------------
// The actions menu
// ---------------------------------------------------------------------------

type TMenuView = 'main' | 'turnInto'
const menuView = ref<TMenuView>('main')
/** Set by an item that swaps the menu's contents rather than acting. */
const nextView = ref<TMenuView | null>(null)
/** Whether the last menu closed because something was done. */
let acted = false

function handleElement(): HTMLElement | null {
  return handleRef.value?.el ?? null
}

function openMenu(): void {
  const index = current.value
  if (index === null) return
  heldIndex.value = index
  conversions.value = blockConversions(props.editor.state, index)
  const block = topBlock(props.editor.state.doc, index)
  linkable.value = !!block && !!blockAnchor(props.editor.state.doc, block.pos)
  menuView.value = 'main'
  acted = false
  const handle = handleElement()
  if (handle) menuRef.value?.setPosition(handle.getBoundingClientRect())
  menuOpen.value = true
}

function onHandleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || handleRef.value?.grabbed) return
  event.preventDefault()
  event.stopPropagation()
  openMenu()
}

function onMenuClose(): void {
  menuOpen.value = false
  if (nextView.value) {
    // An item that leads to more choices: the menu closes as every item
    // makes it, and reopens where it was with the other list, which also
    // puts focus on its first entry.
    const view = nextView.value
    nextView.value = null
    menuView.value = view
    void nextTick(() => (menuOpen.value = true))
    return
  }
  heldIndex.value = null
  if (!acted) restoreFocus(handleElement())
}

/**
 * Back to the control that opened a menu, when the menu was dismissed and
 * focus would otherwise fall to the page. Not when somebody clicked elsewhere:
 * focus is already where they put it.
 */
function restoreFocus(target: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (target?.isConnected && (!active || active === document.body))
      target.focus({ preventScroll: true })
  })
}

function afterEdit(): void {
  acted = true
  view().focus()
}

function convert(target: TBlockKind): void {
  const index = heldIndex.value
  if (index === null) return
  convertBlock(props.editor.state, index, target, dispatch)
  afterEdit()
}

function duplicate(): void {
  const index = heldIndex.value
  if (index === null) return
  duplicateBlock(props.editor.state, index, dispatch)
  afterEdit()
}

function remove(): void {
  const index = heldIndex.value
  if (index === null) return
  deleteBlock(props.editor.state, index, dispatch)
  afterEdit()
}

async function copyLink(): Promise<void> {
  const index = heldIndex.value
  const block = index === null ? null : topBlock(props.editor.state.doc, index)
  const anchor = block ? blockAnchor(props.editor.state.doc, block.pos) : null
  if (!anchor) return
  try {
    await navigator.clipboard.writeText(blockLinkUrl(anchor))
    toast.success('Link to block copied')
  } catch {
    toast.error('The browser did not allow copying to the clipboard.', {
      title: 'Could not copy the link',
    })
  }
}

// ---------------------------------------------------------------------------
// Insert below
// ---------------------------------------------------------------------------

const insertItems = shallowRef<ISuggestionItem[]>([])

function openInsert(): void {
  const index = current.value
  if (index === null) return
  heldIndex.value = index
  insertItems.value = slashItems('')
  acted = false
  const plus = plusRef.value?.$el
  if (plus) insertRef.value?.setPosition(plus.getBoundingClientRect())
  insertOpen.value = true
}

function onInsertClose(): void {
  insertOpen.value = false
  heldIndex.value = null
  if (!acted) restoreFocus(plusRef.value?.$el ?? null)
}

/**
 * Nothing is written until an entry is chosen. Opening this menu and closing
 * it again leaves the document exactly as it was, which is the whole
 * difference from a `+` that types a `/` into the page and hopes.
 */
function insert(item: ISuggestionItem): void {
  const index = heldIndex.value
  if (index === null) return
  acted = true
  insertParagraphBelow(props.editor.state, index, dispatch)
  const at = props.editor.state.selection.from
  item.apply(props.editor, { from: at, to: at })
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

function blockCount(): number {
  return props.editor.state.doc.childCount
}

/** The gap a pointer is over: 0 is above the first block, n below the last. */
function gapAt(clientY: number): number {
  let gap = 0
  for (let i = 0; i < blockCount(); i++) {
    const rect = blockElement(i)?.getBoundingClientRect()
    if (!rect) continue
    if (clientY > rect.top + rect.height / 2) gap = i + 1
  }
  return gap
}

/** Where the line showing a drop goes, relative to the frame. */
function lineFor(from: number, to: number): number | null {
  if (to === from) return null
  const gap = to > from ? to + 1 : to
  const above = gap > 0 ? blockElement(gap - 1)?.getBoundingClientRect() : null
  const below =
    gap < blockCount() ? blockElement(gap)?.getBoundingClientRect() : null
  const y =
    above && below
      ? (above.bottom + below.top) / 2
      : (above?.bottom ?? below?.top ?? 0)
  return y - frameTop()
}

function positionText(index: number): string {
  return `position ${index + 1} of ${blockCount()}`
}

function onDragStart(event: { via: string }): void {
  const index = current.value
  if (index === null) return
  heldIndex.value = index
  drag.value = { from: index, to: index }
  dropLine.value = null
  if (event.via === 'keyboard')
    announcement.value = `Picked up, ${positionText(index)}.`
}

function onDragMove(event: {
  via: string
  clientY?: number
  direction?: string
}): void {
  const state = drag.value
  if (!state) return
  let to = state.to
  if (event.via === 'keyboard') {
    if (event.direction === 'up') to = Math.max(0, to - 1)
    if (event.direction === 'down') to = Math.min(blockCount() - 1, to + 1)
    announcement.value = `Moving to ${positionText(to)}.`
  } else if (typeof event.clientY === 'number') {
    const gap = gapAt(event.clientY)
    to = gap > state.from ? gap - 1 : gap
  }
  drag.value = { from: state.from, to }
  dropLine.value = lineFor(state.from, to)
}

function onDragEnd(): void {
  const state = drag.value
  drag.value = null
  dropLine.value = null
  if (!state) return
  if (state.to !== state.from) {
    moveBlock(props.editor.state, state.from, state.to, dispatch)
    announcement.value = `Moved to ${positionText(state.to)}.`
    // The grip follows the block to where it went, and keeps focus there.
    hoverIndex.value = null
    caretIndex.value = Math.min(state.to, blockCount() - 1)
  } else {
    announcement.value = 'Dropped where it was.'
  }
  heldIndex.value = null
  void nextTick(measure)
}

function onDragCancel(): void {
  drag.value = null
  dropLine.value = null
  heldIndex.value = null
  announcement.value = 'Move cancelled.'
}

defineExpose({ current, openMenu, openInsert })
</script>

<style scoped lang="scss">
/* In the page margin to the left of the block, level with its first line. The
   frame is the positioning context, so nothing here is measured against the
   window and scrolling needs no update. */
.md-gutter {
  position: absolute;
  z-index: 1;
  inset-inline-end: 100%;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-inline-end: var(--nb-spacing-8);
  transition: opacity 120ms ease;

  &--quiet:not(:focus-within) {
    opacity: 0;
  }
}

.md-gutter__handle {
  display: inline-flex;
}

/* Where a dragged block will land. */
.md-gutter__drop {
  position: absolute;
  z-index: 1;
  inset-inline: 0;
  block-size: 2px;
  margin-block-start: -1px;
  border-radius: 1px;
  background: var(--nb-c-primary);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .md-gutter {
    transition: none;
  }
}
</style>

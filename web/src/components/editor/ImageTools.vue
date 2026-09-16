<template>
  <div
    v-if="target && box"
    ref="rootEl"
    class="img-tools"
    :style="{
      insetBlockStart: `${box.top}px`,
      insetInlineStart: `${box.left}px`,
      inlineSize: `${box.width}px`,
      blockSize: `${box.height}px`,
    }"
    data-testid="image-tools"
  >
    <!-- Four corners rather than two, so a picture can be grabbed from
         whichever side has room. Only the horizontal movement counts: width
         is the single stored dimension, and height follows it. -->
    <span
      v-for="corner in CORNERS"
      :key="corner"
      class="img-tools__handle"
      :class="`img-tools__handle--${corner}`"
      :data-testid="`image-handle-${corner}`"
      @pointerdown="startResize(corner, $event)"
    />

    <div class="img-tools__bar" role="toolbar" aria-label="Image">
      <NbButton
        size="xs"
        variant="ghost"
        icon="text-align-left"
        aria-label="Align left"
        :aria-pressed="align === 'left'"
        :class="{ 'is-active': align === 'left' }"
        @click="setAlign('left')"
      />
      <NbButton
        size="xs"
        variant="ghost"
        icon="text-align-center"
        aria-label="Align centre"
        :aria-pressed="align === 'center'"
        :class="{ 'is-active': align === 'center' }"
        @click="setAlign('center')"
      />
      <NbButton
        size="xs"
        variant="ghost"
        icon="text-align-right"
        aria-label="Align right"
        :aria-pressed="align === 'right'"
        :class="{ 'is-active': align === 'right' }"
        @click="setAlign('right')"
      />
      <NbButton
        size="xs"
        variant="ghost"
        icon="arrows-in-simple"
        aria-label="Reset width"
        :disabled="width === null"
        @click="resetWidth"
      />
      <NbButton
        v-if="upload"
        size="xs"
        variant="ghost"
        icon="image"
        aria-label="Replace image"
        @click="fileEl?.click()"
      />
      <NbButton
        size="xs"
        variant="ghost"
        icon="frame-corners"
        aria-label="View full screen"
        @click="preview = true"
      />
    </div>
  </div>

  <!-- A native file control, hidden and driven by the button above it. The
       visible control is an NbButton: this input is never seen or styled. -->
  <input
    v-if="upload"
    ref="fileEl"
    type="file"
    accept="image/*"
    class="img-tools__file"
    aria-hidden="true"
    tabindex="-1"
    @change="onReplace"
  />

  <NbModal
    v-if="preview"
    :open="preview"
    size="immersive"
    :title="alt || 'Image'"
    @close="preview = false"
  >
    <img
      v-if="previewSrc"
      class="img-tools__preview"
      :src="previewSrc"
      :alt="alt"
    />
  </NbModal>
</template>

<script setup lang="ts">
/**
 * The controls that appear over a picture in the editor: placement, size, a
 * replacement, and a look at it full screen.
 *
 * An overlay rather than a node view. The image node is the thing that got
 * every picture in a document deleted a day ago, and the fix was to keep it
 * a plain node the serializer can always write back. Hanging a component off
 * it would put a rendering concern back inside the schema, so the schema
 * stays as it is and the chrome floats above it, reading the node's
 * attributes and writing them through ordinary transactions.
 *
 * Drag-resize writes only a width. Height stays `auto`, which holds the
 * aspect ratio exactly rather than approximately, and it means a picture
 * whose stored width exceeds the column is capped by `max-inline-size`
 * instead of overflowing it.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { NodeSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'
import {
  clampImageWidth,
  resizedWidth,
  type TImageAlign,
} from '@/lib/imageAttrs'
import { imageSrc } from '@/components/editor/nodes/Image'

const props = defineProps<{
  editor: Editor
  /**
   * Puts a file somewhere and answers with the markdown `src` for it. Absent,
   * the replace control is not offered, which is right for a surface with
   * nothing to attach a file to.
   */
  upload?: (file: File) => Promise<string | null>
}>()

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const
type TCorner = (typeof CORNERS)[number]

const rootEl = ref<HTMLElement | null>(null)
const fileEl = ref<HTMLInputElement | null>(null)
const preview = ref(false)

/** The picture under the pointer, and the picture the selection is on. */
const hovered = shallowRef<HTMLImageElement | null>(null)
const selected = shallowRef<HTMLImageElement | null>(null)
/** Bumped whenever the document or the viewport moves, to re-measure. */
const version = ref(0)

/**
 * Selection wins over hover: a picture somebody has clicked keeps its
 * controls while the pointer wanders off to reach them.
 */
const target = computed<HTMLImageElement | null>(
  () => selected.value ?? hovered.value,
)

const box = computed(() => {
  // Read so a transaction or a scroll re-runs this.
  void version.value
  const el = target.value
  const host = rootEl.value?.offsetParent ?? props.editor.view.dom.offsetParent
  if (!el || !host) return null
  const a = el.getBoundingClientRect()
  const b = (host as HTMLElement).getBoundingClientRect()
  return {
    top: a.top - b.top,
    left: a.left - b.left,
    width: a.width,
    height: a.height,
  }
})

/** The node behind the element on screen, and where it sits in the document. */
function located(): { pos: number; attrs: Record<string, unknown> } | null {
  const el = target.value
  if (!el) return null
  const { state, view } = props.editor
  let found: { pos: number; attrs: Record<string, unknown> } | null = null
  state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'image' && view.nodeDOM(pos) === el) {
      found = { pos, attrs: node.attrs }
      return false
    }
    return true
  })
  return found
}

const attrs = computed<Record<string, unknown>>(() => {
  void version.value
  return located()?.attrs ?? {}
})
const align = computed(() => (attrs.value.align as TImageAlign | null) ?? null)
const width = computed(() => (attrs.value.width as number | null) ?? null)
const alt = computed(() => String(attrs.value.alt ?? ''))
const previewSrc = computed(() => imageSrc(String(attrs.value.src ?? '')))

/** Writes attributes onto the pictured node, and selects it. */
function patch(changes: Record<string, unknown>): void {
  const at = located()
  if (!at) return
  const pos = at.pos
  props.editor
    .chain()
    .setNodeSelection(pos)
    .command(({ tr }) => {
      for (const [key, value] of Object.entries(changes))
        tr.setNodeAttribute(pos, key, value)
      return true
    })
    .run()
  version.value++
}

/** Pressing the alignment a picture already has puts it back in the flow. */
function setAlign(value: TImageAlign): void {
  patch({ align: align.value === value ? null : value })
}

function resetWidth(): void {
  patch({ width: null })
}

/* Drag-resize. The live size is written straight onto the element while the
   pointer is down, because a transaction per pointermove would put a step on
   the undo stack for every pixel travelled. One transaction lands on
   release. */
let drag: { corner: TCorner; startX: number; startWidth: number } | null = null

function startResize(corner: TCorner, event: PointerEvent): void {
  const el = target.value
  if (!el) return
  event.preventDefault()
  event.stopPropagation()
  drag = {
    corner,
    startX: event.clientX,
    startWidth: el.getBoundingClientRect().width || (width.value ?? 0),
  }
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', onResize)
  window.addEventListener('pointerup', endResize, { once: true })
}

/**
 * The widest a picture may become here: the column it sits in.
 *
 * Undefined when there is no layout to ask (a test environment, or a hidden
 * editor), which leaves the absolute ceiling as the only bound rather than
 * clamping every drag to zero.
 */
function columnWidth(): number | undefined {
  const dom = props.editor.view.dom as HTMLElement
  return dom.clientWidth || dom.getBoundingClientRect().width || undefined
}

function onResize(event: PointerEvent): void {
  const el = target.value
  if (!drag || !el) return
  const next = resizedWidth(
    drag.startWidth,
    event.clientX - drag.startX,
    drag.corner === 'nw' || drag.corner === 'sw' ? 'left' : 'right',
    columnWidth(),
  )
  el.style.inlineSize = `${next}px`
  version.value++
}

function endResize(event: PointerEvent): void {
  window.removeEventListener('pointermove', onResize)
  const el = target.value
  if (!drag || !el) {
    drag = null
    return
  }
  const next = resizedWidth(
    drag.startWidth,
    event.clientX - drag.startX,
    drag.corner === 'nw' || drag.corner === 'sw' ? 'left' : 'right',
    columnWidth(),
  )
  drag = null
  // Cleared, because the node re-renders with the width from its attributes
  // and a leftover inline style would win over the next change.
  el.style.inlineSize = ''
  patch({ width: clampImageWidth(next, columnWidth()) })
}

async function onReplace(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared either way, so choosing the same file twice still fires.
  input.value = ''
  if (!file || !props.upload) return
  const src = await props.upload(file)
  if (src) patch({ src })
}

/* What the controls follow. Hover and selection are tracked separately
   because they answer different questions: hover is "the picture you are
   pointing at", selection is "the picture you are working on". */
function onPointerOver(event: Event): void {
  const node = event.target as HTMLElement | null
  const img = node?.closest?.('img.md__img') as HTMLImageElement | null
  if (img && props.editor.view.dom.contains(img)) {
    hovered.value = img
    return
  }
  // Inside our own chrome counts as still on the picture, or reaching for a
  // button would dismiss the thing you are reaching for.
  if (rootEl.value && node && rootEl.value.contains(node)) return
  hovered.value = null
}

function onTransaction(): void {
  const { selection } = props.editor.state
  const node =
    selection instanceof NodeSelection && selection.node.type.name === 'image'
      ? props.editor.view.nodeDOM(selection.from)
      : null
  selected.value = node instanceof HTMLImageElement ? node : null
  version.value++
}

function onViewport(): void {
  version.value++
}

onMounted(() => {
  document.addEventListener('pointerover', onPointerOver, true)
  window.addEventListener('scroll', onViewport, true)
  window.addEventListener('resize', onViewport)
  props.editor.on('transaction', onTransaction)
  onTransaction()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerover', onPointerOver, true)
  window.removeEventListener('scroll', onViewport, true)
  window.removeEventListener('resize', onViewport)
  window.removeEventListener('pointermove', onResize)
  props.editor.off('transaction', onTransaction)
})
</script>

<style scoped lang="scss">
/* The frame itself takes no pointer events, so the picture underneath is
   still clickable, draggable and deletable. Only the handles and the bar
   answer the pointer. */
.img-tools {
  position: absolute;
  pointer-events: none;
  z-index: var(--nb-zindex-dropdown);
  outline: 1px solid var(--nb-c-primary);
  outline-offset: 2px;
  border-radius: var(--nb-radius-sm);
}

.img-tools__handle {
  position: absolute;
  pointer-events: auto;
  inline-size: 10px;
  block-size: 10px;
  background: var(--nb-c-primary);
  border: 1px solid var(--nb-c-primary-a11y);
  border-radius: var(--nb-radius-xs);
  touch-action: none;
}

.img-tools__handle--nw {
  inset-block-start: -5px;
  inset-inline-start: -5px;
  cursor: nwse-resize;
}

.img-tools__handle--ne {
  inset-block-start: -5px;
  inset-inline-end: -5px;
  cursor: nesw-resize;
}

.img-tools__handle--sw {
  inset-block-end: -5px;
  inset-inline-start: -5px;
  cursor: nesw-resize;
}

.img-tools__handle--se {
  inset-block-end: -5px;
  inset-inline-end: -5px;
  cursor: nwse-resize;
}

/* Above the picture, not over it: a bar covering the top of a small image
   hides the thing it is there to act on. */
.img-tools__bar {
  position: absolute;
  inset-block-end: calc(100% + var(--nb-spacing-8));
  inset-inline-start: 0;
  display: flex;
  gap: 2px;
  pointer-events: auto;
  padding: var(--nb-spacing-2);
  background: var(--nb-c-layer-3);
  border: 1px solid var(--nb-c-layer-border-3);
  border-radius: var(--nb-radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  white-space: nowrap;

  :deep(.is-active) {
    background: var(--nb-c-primary);
    color: var(--nb-c-primary-a11y);
  }
}

.img-tools__file {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.img-tools__preview {
  display: block;
  max-inline-size: 100%;
  max-block-size: 80vh;
  margin-inline: auto;
  object-fit: contain;
}
</style>

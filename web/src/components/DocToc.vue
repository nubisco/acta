<template>
  <div
    v-if="visible"
    ref="rootEl"
    class="doc-toc"
    :class="{ 'doc-toc--overlay': overlay, 'doc-toc--open': open }"
    @keydown.esc="onEscape"
  >
    <NbButton
      v-if="!open"
      v-nb-tooltip="{ body: 'Show contents' }"
      size="sm"
      variant="ghost"
      icon="list-dashes"
      aria-label="Show contents"
      :aria-expanded="false"
      :aria-controls="navId"
      class="doc-toc__show"
      @click="setOpen(true)"
    />
    <component :is="overlay ? NbPanel : 'div'" v-else class="doc-toc__body">
      <nav :id="navId" class="doc-toc__nav" aria-label="Table of contents">
        <div class="doc-toc__head">
          <span class="doc-toc__title">Contents</span>
          <NbButton
            v-nb-tooltip="{ body: 'Hide contents' }"
            size="xs"
            variant="ghost"
            icon="caret-right"
            aria-label="Hide contents"
            :aria-expanded="true"
            :aria-controls="navId"
            @click="setOpen(false)"
          />
        </div>
        <DocTocList :nodes="tree" :active="activeSlug" @go="go" />
      </nav>
    </component>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NbPanel, prefersReducedMotion } from '@nubisco/ui'
import DocTocList from '@/components/DocTocList.vue'
import { useDocChrome } from '@/lib/docChrome'
import {
  activeHeadingIndex,
  documentOutline,
  outlineTree,
  tocWorthShowing,
} from '@/lib/docText'

const props = defineProps<{
  /** The markdown being shown: the stored body, or the draft while editing. */
  source: string
  /** The element the document's headings are rendered inside. */
  root: HTMLElement | null
  /** Readable words, from the stats, so the threshold agrees with them. */
  words: number
  /**
   * No gutter to sit in: the contents float over the page, start closed, and
   * close again once a section is chosen.
   */
  overlay?: boolean
}>()

/**
 * How far below the top of the scroll viewport a heading still counts as the
 * section being read. Larger than the heading's scroll margin, so the heading
 * a link just scrolled to is the one highlighted.
 */
const ACTIVE_THRESHOLD_PX = 96

const chrome = useDocChrome()
const navId = `doc-toc-${Math.random().toString(36).slice(2, 8)}`
const rootEl = ref<HTMLElement | null>(null)
const overlayOpen = ref(false)

const outline = computed(() => documentOutline(props.source))
const tree = computed(() => outlineTree(outline.value))
const visible = computed(() =>
  tocWorthShowing(outline.value, props.words, props.source),
)
const open = computed(() =>
  props.overlay ? overlayOpen.value : !chrome.prefs.tocClosed,
)
const activeSlug = ref<string | null>(null)

function setOpen(value: boolean): void {
  // Closing the floating one is momentary. Closing the docked one is a
  // preference the reader expects to stay closed on the next page.
  if (props.overlay) overlayOpen.value = value
  else chrome.prefs.tocClosed = !value
  if (!value) void nextTick(() => focusShowButton())
}

function focusShowButton(): void {
  rootEl.value?.querySelector<HTMLElement>('.doc-toc__show')?.focus()
}

function onEscape(event: KeyboardEvent): void {
  if (!props.overlay || !overlayOpen.value) return
  // Handled here, so page focus mode does not also leave on the same press.
  event.stopPropagation()
  setOpen(false)
}

/** The rendered headings, in document order. */
function headingElements(): HTMLElement[] {
  if (!props.root) return []
  return Array.from(
    props.root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
  )
}

type TScroller = HTMLElement | Window

/** Whatever actually scrolls the page: the shell's `<main>` in the app. */
function scrollParent(el: HTMLElement | null): TScroller {
  let node = el?.parentElement ?? null
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return window
}

let scroller: TScroller | null = null
let frame: number | null = null
let suppressUntil = 0

function measure(): void {
  frame = null
  if (!visible.value) return
  if (Date.now() < suppressUntil) return
  const elements = headingElements()
  const count = Math.min(elements.length, outline.value.length)
  if (count === 0) {
    activeSlug.value = null
    return
  }
  const target = scroller ?? window
  const isWindow = target === window
  const box = isWindow
    ? { top: 0, height: window.innerHeight }
    : (() => {
        const rect = (target as HTMLElement).getBoundingClientRect()
        return { top: rect.top, height: (target as HTMLElement).clientHeight }
      })()
  const scrollTop = isWindow
    ? window.scrollY
    : (target as HTMLElement).scrollTop
  const scrollHeight = isWindow
    ? document.documentElement.scrollHeight
    : (target as HTMLElement).scrollHeight
  const atBottom =
    scrollHeight > box.height && scrollTop + box.height >= scrollHeight - 2
  const tops = elements
    .slice(0, count)
    .map((el) => el.getBoundingClientRect().top - box.top)
  const index = activeHeadingIndex(tops, ACTIVE_THRESHOLD_PX, {
    atBottom,
    viewportHeight: box.height,
  })
  activeSlug.value = index >= 0 ? outline.value[index].slug : null
}

function schedule(): void {
  if (frame !== null) return
  frame =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(measure)
      : (setTimeout(measure, 16) as unknown as number)
}

function attach(): void {
  detach()
  scroller = scrollParent(props.root ?? rootEl.value)
  scroller.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule, { passive: true })
  schedule()
}

function detach(): void {
  scroller?.removeEventListener('scroll', schedule)
  window.removeEventListener('resize', schedule)
  scroller = null
}

/**
 * Scroll to a section, the way the heading's own copied link would.
 *
 * The address bar gets the same `#slug` the heading's copy button produces,
 * so what a reader copies from the address bar after using the contents is
 * the same link. Replaced, not pushed: every click adding a history entry
 * would make Back walk through the outline instead of leaving the page.
 */
function go(slug: string, opts: { instant?: boolean } = {}): void {
  const index = outline.value.findIndex((entry) => entry.slug === slug)
  const el = headingElements()[index]
  if (!el) return
  const instant = opts.instant || prefersReducedMotion()
  el.scrollIntoView?.({ behavior: instant ? 'auto' : 'smooth', block: 'start' })
  activeSlug.value = slug
  // Smooth scrolling passes other headings on the way. Hold the highlight on
  // the chosen one until it has arrived.
  suppressUntil = instant ? 0 : Date.now() + 700
  try {
    const { pathname, search } = window.location
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${search}#${slug}`,
    )
  } catch {
    // An address bar that cannot be written is not a reason to not scroll.
  }
  // In the reader, move focus to the section, so a keyboard or screen
  // reader user continues from there. Not in the editor, where focusing a
  // heading element would not put the caret in it.
  if (!el.closest('[contenteditable="true"]')) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
  }
  if (props.overlay) overlayOpen.value = false
}

/** A link opened with `#slug` lands on the section once it is rendered. */
let hashHandled = false
function followHash(): void {
  if (hashHandled || !visible.value) return
  const slug = decodeURIComponent(window.location.hash.slice(1))
  if (!slug) {
    hashHandled = true
    return
  }
  if (!outline.value.some((entry) => entry.slug === slug)) return
  if (headingElements().length === 0) return
  hashHandled = true
  go(slug, { instant: true })
}

// Headings arrive after the markdown does: the reader anchors them a tick
// after render, and the editor rebuilds them as they are typed. So re-measure
// after the source changes rather than when it changes.
watch(
  () => props.source,
  () =>
    void nextTick(() => {
      schedule()
      followHash()
    }),
  { flush: 'post' },
)
watch(
  () => [props.root, visible.value] as const,
  () => void nextTick(attach),
  { flush: 'post' },
)
watch(
  () => props.overlay,
  () => (overlayOpen.value = false),
)

onMounted(() => {
  attach()
  void nextTick(followHash)
})
onBeforeUnmount(() => {
  detach()
  if (frame !== null && typeof cancelAnimationFrame === 'function')
    cancelAnimationFrame(frame)
})

defineExpose({ activeSlug, go, measure })
</script>

<style scoped lang="scss">
.doc-toc {
  inline-size: 100%;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-8);
    padding-inline-start: var(--nb-spacing-8);
    margin-block-end: var(--nb-spacing-4);
  }

  &__title {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  &__nav {
    /* Long outlines scroll inside the contents rather than running off the
       bottom of the screen, where the sticky position would strand them. */
    max-block-size: calc(100dvh - 12rem);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  &__show {
    display: flex;
    margin-inline-start: auto;
  }

  &--overlay {
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 0;
    inline-size: auto;

    .doc-toc__body {
      inline-size: min(18rem, calc(100vw - 2rem));
      padding: var(--nb-spacing-8);
    }
  }
}
</style>

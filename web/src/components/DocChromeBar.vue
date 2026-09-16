<template>
  <div class="doc-chrome">
    <p class="doc-chrome__stats">
      <span>{{ wordsLabel }}</span>
      <span aria-hidden="true">·</span>
      <span>{{ charactersLabel }}</span>
      <template v-if="stats.readingMinutes > 0">
        <span aria-hidden="true">·</span>
        <span>{{ stats.readingMinutes }} min read</span>
      </template>
      <NbInfoHint
        :size="14"
        label="What these counts include"
        title="Counted as a reader reads it"
        text="Prose, headings, lists, tables, link text and inline code. Left out: markdown syntax, code blocks, diagram source, maths, and images. Reading time assumes 238 words a minute."
      />
    </p>

    <div class="doc-chrome__controls">
      <NbButton
        v-if="canEdit"
        v-nb-tooltip="{
          body: wide ? 'Use the default page width' : 'Use a wide page',
        }"
        size="sm"
        variant="ghost"
        :icon="
          wide ? 'arrows-in-line-horizontal' : 'arrows-out-line-horizontal'
        "
        aria-label="Wide page"
        :aria-pressed="wide"
        :loading="savingWidth"
        @click="toggleWidth"
      />
      <NbButton
        v-if="editing"
        v-nb-tooltip="{ body: `Dim other blocks (${shortcuts.dim})` }"
        size="sm"
        variant="ghost"
        icon="crosshair-simple"
        aria-label="Dim other blocks"
        aria-keyshortcuts="Control+Alt+F Meta+Alt+F"
        :aria-pressed="chrome.prefs.dimBlocks"
        @click="toggleDimBlocks"
      />
      <NbButton
        v-nb-tooltip="{
          body: chrome.prefs.page
            ? 'Leave focus mode (Esc)'
            : `Focus mode (${shortcuts.page})`,
        }"
        size="sm"
        variant="ghost"
        :icon="chrome.prefs.page ? 'corners-in' : 'corners-out'"
        aria-label="Focus mode"
        aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
        :aria-pressed="chrome.prefs.page"
        @click="togglePage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useViewCommands } from '@/lib/commands'
import {
  isDimBlocksShortcut,
  isPageFocusShortcut,
  useDocChrome,
} from '@/lib/docChrome'
import type { IDocStats } from '@/lib/docText'

const props = defineProps<{
  slug: string
  stats: IDocStats
  /** The document's stored layout. */
  wide: boolean
  editing: boolean
  /** Whether this viewer may write to the document. */
  canEdit: boolean
}>()

const emit = defineEmits<{
  /** The stored layout changed, or a failed change was rolled back. */
  'update:wide': [wide: boolean]
}>()

const chrome = useDocChrome()
const toast = useToast()
const savingWidth = ref(false)

const number = new Intl.NumberFormat()
const wordsLabel = computed(
  () =>
    `${number.format(props.stats.words)} ${props.stats.words === 1 ? 'word' : 'words'}`,
)
const charactersLabel = computed(
  () =>
    `${number.format(props.stats.characters)} ${props.stats.characters === 1 ? 'character' : 'characters'}`,
)

const isApple =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const shortcuts = isApple
  ? { page: '⌘⇧F', dim: '⌘⌥F' }
  : { page: 'Ctrl+Shift+F', dim: 'Ctrl+Alt+F' }

/**
 * Page width is the document's stored `layout`, so it goes through the same
 * doc write every other client uses. Shown as changed straight away and put
 * back if the write fails, because a toggle that waits on the network feels
 * broken and one that silently disagrees with the server is worse.
 */
async function toggleWidth(): Promise<void> {
  if (!props.canEdit || savingWidth.value) return
  const next = !props.wide
  emit('update:wide', next)
  savingWidth.value = true
  try {
    const { results } = await api.docWrite([
      {
        op: 'set_layout',
        op_id: newOpId(),
        ref: props.slug,
        layout: next ? 'wide' : 'default',
      },
    ])
    if (!results[0]?.ok) throw new Error(String(results[0]?.error ?? 'failed'))
  } catch (err) {
    emit('update:wide', !next)
    toast.error(humanise(err), { title: 'Could not change the page width' })
  } finally {
    savingWidth.value = false
  }
}

function toggleDimBlocks(): void {
  chrome.prefs.dimBlocks = !chrome.prefs.dimBlocks
}

function togglePage(): void {
  chrome.prefs.page = !chrome.prefs.page
}

function onKeydown(event: KeyboardEvent): void {
  if (isPageFocusShortcut(event)) {
    event.preventDefault()
    togglePage()
    return
  }
  if (isDimBlocksShortcut(event) && props.editing) {
    event.preventDefault()
    toggleDimBlocks()
    return
  }
  if (event.key !== 'Escape' || !chrome.prefs.page) return
  // Something else already used this Escape: a suggestion list, a menu, the
  // floating contents. Leaving focus mode as well would be two things at once.
  if (event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  if (target?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]'))
    return
  chrome.prefs.page = false
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

useViewCommands('docs', [
  {
    id: 'docs:focus-page',
    label: 'Toggle focus mode',
    icon: 'corners-out',
    namespace: 'Docs',
    shortcut: shortcuts.page,
    handler: togglePage,
  },
  {
    id: 'docs:focus-blocks',
    label: 'Toggle dimming other blocks while editing',
    icon: 'crosshair-simple',
    namespace: 'Docs',
    shortcut: shortcuts.dim,
    handler: toggleDimBlocks,
  },
])
</script>

<style scoped lang="scss">
.doc-chrome {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-spacing-8);
  min-block-size: 2rem;

  &__stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nb-spacing-4);
    margin: 0;
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
    font-variant-numeric: tabular-nums;
  }

  &__controls {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-2);
  }
}
</style>

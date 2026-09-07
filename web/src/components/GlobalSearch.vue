<template>
  <form
    ref="rootEl"
    class="global-search"
    role="search"
    aria-label="Search Acta"
    @submit.prevent="goToSearchPage"
  >
    <NbTextInput
      id="field-topbar-search"
      v-model="query"
      size="sm"
      placeholder="Search..."
      aria-label="Search Acta"
      autocomplete="off"
      @focus="open = true"
      @keydown="onKeyDown"
    />
    <div
      v-if="open && query.trim()"
      class="global-search__panel nb-layer-2"
      role="listbox"
      aria-label="Search results"
    >
      <p v-if="searching && hits.length === 0" class="global-search__note">
        Searching...
      </p>
      <p v-else-if="hits.length === 0" class="global-search__note">
        No matches yet
      </p>
      <button
        v-for="(hit, index) in hits"
        :key="`${hit.type}:${hit.ref}`"
        type="button"
        class="global-search__hit"
        :class="{ 'global-search__hit--active': index === active }"
        role="option"
        :aria-selected="index === active"
        @mouseenter="active = index"
        @click="openHit(hit)"
      >
        <NbIcon
          :name="iconFor(hit.type)"
          :size="14"
          class="global-search__icon"
        />
        <span class="global-search__title">{{ hit.title }}</span>
        <span class="global-search__hint">{{
          hit.type === 'item' ? hit.ref : (hit.board ?? hit.type)
        }}</span>
      </button>
      <button
        v-if="hits.length > 0"
        type="submit"
        class="global-search__hit global-search__all"
      >
        <NbIcon
          name="magnifying-glass"
          :size="14"
          class="global-search__icon"
        />
        <span class="global-search__title">All results for "{{ query }}"</span>
        <span class="global-search__hint">Enter</span>
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
// The topbar search answers WHILE you type, the way cmd+k does: top hits in
// a dropdown, Enter for the full search page. Same endpoint as everything
// else, so a card key, a half-typed word, or operator soup all behave.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NbIcon, NbTextInput } from '@nubisco/ui'
import { api } from '@/api/client'
import type { ISearchResult } from '@/types/api'
import { useInspector } from '@/stores/workspace'

const router = useRouter()
const inspector = useInspector()

const rootEl = ref<HTMLElement | null>(null)
const query = ref('')
const open = ref(false)
const searching = ref(false)
const hits = ref<ISearchResult[]>([])
const active = ref(0)

let debounce: ReturnType<typeof setTimeout> | undefined
let generation = 0

watch(query, () => {
  open.value = true
  active.value = 0
  clearTimeout(debounce)
  const q = query.value.trim()
  if (!q) {
    hits.value = []
    return
  }
  searching.value = true
  debounce = setTimeout(() => void run(q), 250)
})

async function run(q: string): Promise<void> {
  const mine = ++generation
  try {
    const { results } = await api.search(q)
    if (mine !== generation) return
    hits.value = results.slice(0, 7)
  } catch {
    if (mine === generation) hits.value = []
  } finally {
    if (mine === generation) searching.value = false
  }
}

function iconFor(type: string): string {
  if (type === 'doc') return 'file-text'
  if (type === 'comment') return 'chat-circle'
  return 'kanban'
}

function openHit(hit: ISearchResult): void {
  open.value = false
  if (hit.type === 'doc') void router.push(`/docs/${hit.ref}`)
  else if (hit.type === 'item') inspector.open(hit.ref)
  // Comment hits carry the owning item key as their title.
  else inspector.open(hit.title)
}

function goToSearchPage(): void {
  const q = query.value.trim()
  if (!q) return
  open.value = false
  void router.push({ path: '/search', query: { q } })
}

function onKeyDown(event: KeyboardEvent): void {
  if (!open.value || hits.value.length === 0) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    active.value = (active.value + 1) % hits.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    active.value = (active.value - 1 + hits.value.length) % hits.value.length
  } else if (event.key === 'Enter') {
    // Enter picks the highlighted hit; the form submit (full page) stays
    // reachable with the explicit "All results" row.
    event.preventDefault()
    const hit = hits.value[active.value]
    if (hit) openHit(hit)
  } else if (event.key === 'Escape') {
    open.value = false
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!rootEl.value?.contains(event.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() =>
  document.removeEventListener('pointerdown', onDocumentPointerDown),
)
</script>

<style scoped lang="scss">
.global-search {
  position: relative;
  display: flex;
  align-items: center;

  &__panel {
    position: absolute;
    inset-block-start: calc(100% + 6px);
    inset-inline-end: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    min-inline-size: 340px;
    max-inline-size: 420px;
    max-block-size: 60vh;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm, 8px);
    background: var(--nb-c-bg-raised, var(--nb-c-bg));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  &__note {
    margin: 0;
    padding: 8px 10px;
    font-size: var(--nb-font-size-13, 13px);
    color: var(--nb-c-text-muted);
  }

  &__hit {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--nb-c-text);
    font: inherit;
    font-size: var(--nb-font-size-13, 13px);
    text-align: start;
    cursor: pointer;

    &--active,
    &:hover {
      background: var(--nb-c-bg-soft);
    }
  }

  &__all {
    border-block-start: 1px solid var(--nb-c-border);
    border-radius: 0 0 4px 4px;
    color: var(--nb-c-text-muted);
  }

  &__icon {
    flex: none;
    color: var(--nb-c-text-muted);
  }

  &__title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__hint {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-muted);
  }
}
</style>

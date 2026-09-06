<template>
  <div class="search">
    <h1 class="type-heading-03">Search</h1>

    <component :is="filterBar.Outlet">
      <div class="search__bar" role="search" aria-label="Search Acta">
        <NbTextInput
          id="field-search"
          v-model="query"
          size="sm"
          label="Search"
          placeholder="Items, docs, comments..."
        />
        <NbSelect
          id="field-search-type"
          v-model="typeFilter"
          size="sm"
          :options="typeOptions"
        />
      </div>
    </component>

    <p class="sr-only" role="status">{{ results.length }} results</p>

    <NbEmptyState
      v-if="query.trim() === ''"
      title="Search the workspace"
      description="Item titles and descriptions, comments, and documents are all searchable."
    />

    <div v-else-if="load.state.value === 'loading'" class="search__loading">
      <NbSkeleton variant="text" :lines="5" label="Searching" />
    </div>

    <NbEmptyState
      v-else-if="load.state.value === 'error'"
      kind="error"
      title="Search failed"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="run">Retry</NbButton>
      </template>
    </NbEmptyState>

    <NbEmptyState
      v-else-if="results.length === 0"
      kind="no-results"
      :title="`No results for “${query}”`"
      description="Nothing matched. Try fewer words, or a different type filter."
    >
      <template #actions>
        <NbButton variant="secondary" @click="clear">Clear search</NbButton>
      </template>
    </NbEmptyState>

    <NbDataTable
      v-else
      :columns="columns"
      :rows="rows"
      row-key="ref"
      size="sm"
      aria-label="Search results"
      @row-click="openResult"
    >
      <template #cell-type="{ row }">
        <NbBadge size="sm" variant="grey">{{ row.type }}</NbBadge>
      </template>
    </NbDataTable>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NbBadge,
  NbButton,
  NbDataTable,
  NbEmptyState,
  NbSelect,
  NbSkeleton,
  NbTextInput,
  useShellSlot,
} from '@nubisco/ui'
import { api } from '@/api/client'
import type { ISearchResult } from '@/types/api'
import { useLoadState } from '@/lib/state'
import { useInspector } from '@/stores/workspace'

const route = useRoute()
const router = useRouter()
const inspector = useInspector()
const load = useLoadState()
const filterBar = useShellSlot('fixedbar')

const query = ref(String(route.query.q ?? ''))
const typeFilter = ref('')
const results = ref<ISearchResult[]>([])

const typeOptions = [
  { label: 'Everything', value: '' },
  { label: 'Items', value: 'item' },
  { label: 'Docs', value: 'doc' },
  { label: 'Comments', value: 'comment' },
]

const columns = [
  { key: 'type', header: 'Type' },
  { key: 'title', header: 'Title' },
  { key: 'snippet', header: 'Match' },
  { key: 'board', header: 'Board' },
]

const rows = computed(() =>
  results.value.map((r) => ({
    type: r.type,
    title: r.title,
    snippet: r.snippet.replace(/<<|>>/g, ''),
    board: r.board ?? '',
    ref: `${r.type}:${r.ref}`,
    rawRef: r.ref,
  })),
)

async function run(): Promise<void> {
  const q = query.value.trim()
  if (!q) {
    results.value = []
    load.state.value = 'ready'
    return
  }
  void router.replace({ query: { q } })
  const result = await load.run(
    api.search(q, typeFilter.value ? [typeFilter.value] : undefined),
  )
  if (result) results.value = result.results
}

let debounce: ReturnType<typeof setTimeout> | undefined
watch([query, typeFilter], () => {
  clearTimeout(debounce)
  debounce = setTimeout(run, 300)
})
void run()

function clear(): void {
  query.value = ''
  typeFilter.value = ''
  results.value = []
}

function openResult(row: {
  type: string
  rawRef: string
  title: string
}): void {
  if (row.type === 'doc') void router.push(`/docs/${row.rawRef}`)
  else if (row.type === 'item') inspector.open(row.rawRef)
  // Comment rows carry the item key as their title.
  else if (row.type === 'comment') inspector.open(row.title)
}
</script>

<style scoped lang="scss">
.search {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  &__bar {
    display: flex;
    align-items: end;
    gap: var(--nb-spacing-8);
    padding-block: var(--nb-spacing-8);
  }

  &__loading {
    padding-block: var(--nb-spacing-16);
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>

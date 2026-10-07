<template>
  <div class="goal-picker">
    <NbTextInput
      :id="`field-goal-cards-${goal}`"
      v-model="query"
      size="sm"
      label="Link a card"
      placeholder="Search any space..."
      autocomplete="off"
      :error="error"
    >
      <template #leading>
        <NbIcon name="magnifying-glass" :size="15" />
      </template>
    </NbTextInput>
    <p v-if="searching" class="goal-picker__note">Searching...</p>
    <p v-else-if="query.trim() && hits.length === 0" class="goal-picker__note">
      No card matches that.
    </p>
    <ul v-else-if="hits.length > 0" class="goal-picker__hits">
      <li v-for="hit in hits" :key="hit.ref">
        <button
          type="button"
          class="goal-picker__hit"
          :disabled="busy"
          :aria-label="`Link ${hit.ref} to G-${goal}`"
          @click="link(hit.ref)"
        >
          <span class="goal-picker__key">{{ hit.ref }}</span>
          <span class="goal-picker__title">{{ hit.title }}</span>
          <NbBadge v-if="hit.space" size="sm" variant="grey">
            {{ hit.space }}
          </NbBadge>
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
/**
 * Search for a card on any space and link it to a goal.
 *
 * Search rather than a select, for the reason the Parts panel gives: the
 * pool is the whole workspace, which is too big for a list and is exactly
 * what search already answers. Linking a card brings its parts with it.
 */
import { ref, watch } from 'vue'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import type { ISearchResult } from '@/types/api'

const props = defineProps<{
  goal: number
  /** Keys already counted, which are not offered again. */
  taken: string[]
}>()
const emit = defineEmits<{ linked: [] }>()

const query = ref('')
const hits = ref<ISearchResult[]>([])
const searching = ref(false)
const busy = ref(false)
const error = ref<string | undefined>(undefined)
let debounce: ReturnType<typeof setTimeout> | undefined
let generation = 0

watch(query, () => {
  error.value = undefined
  clearTimeout(debounce)
  const q = query.value.trim()
  if (!q) {
    hits.value = []
    searching.value = false
    generation++
    return
  }
  searching.value = true
  debounce = setTimeout(() => void run(q), 250)
})

async function run(q: string): Promise<void> {
  const mine = ++generation
  try {
    const { results } = await api.search(q, ['item'])
    if (mine !== generation) return
    const taken = new Set(props.taken)
    hits.value = results.filter((r) => !taken.has(r.ref)).slice(0, 7)
  } catch {
    if (mine === generation) hits.value = []
  } finally {
    if (mine === generation) searching.value = false
  }
}

async function link(key: string): Promise<void> {
  busy.value = true
  error.value = undefined
  try {
    const { results } = await api.goalWrite([
      { op: 'link', op_id: newOpId(), goal: props.goal, add: [key] },
    ])
    const result = results[0]
    if (!result.ok) {
      error.value = result.error
      return
    }
    query.value = ''
    hits.value = []
    emit('linked')
  } catch (err) {
    error.value = humanise(err)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped lang="scss">
.goal-picker {
  display: grid;
  gap: var(--nb-spacing-8);

  &__hits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-2);
  }

  &__hit {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    inline-size: 100%;
    min-inline-size: 0;
    padding: var(--nb-spacing-4) var(--nb-spacing-8);
    background: var(--nb-c-surface);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    text-align: start;
    font: inherit;
    color: inherit;
    cursor: pointer;

    &:hover {
      background: var(--nb-c-surface-hover);
      border-color: var(--nb-c-primary);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 1px;
    }

    &:disabled {
      cursor: default;
      opacity: 0.6;
    }
  }

  &__key {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__title {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--nb-type-body-sm-size);
  }

  &__note {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }
}
</style>

<template>
  <div class="parts">
    <div class="parts__body nb-layer-2">
      <p v-if="parts.length > 0" class="parts__progress">
        {{ doneCount }} of {{ parts.length }} done
      </p>

      <ul v-if="parts.length > 0" class="parts__list">
        <li v-for="part in parts" :key="part.key" class="parts__row nb-layer-3">
          <button
            type="button"
            class="parts__ref"
            :aria-label="`Open ${part.key}: ${part.title}`"
            @click="emit('open', part.key)"
          >
            <span class="parts__key" :class="{ 'parts__key--done': part.done }">
              {{ part.key }}
            </span>
            <!-- The title leads, as it does on a dependency row: nobody reads
                 a plan by its addresses. -->
            <span class="parts__title">{{ part.title }}</span>
            <!-- Only when it is somewhere else. Stamping every row with the
                 board you are already looking at says nothing, and it is the
                 rows that leave this board that need the warning. -->
            <NbBadge
              v-if="part.space !== space"
              size="sm"
              variant="grey"
              class="parts__space"
            >
              {{ part.space }}
            </NbBadge>
            <NbIcon
              v-if="part.done"
              v-nb-tooltip="{ body: 'Done' }"
              name="check-circle"
              :size="14"
              class="parts__done"
            />
          </button>
          <!-- Detach, not delete, and the label says so. The card carries on
               existing on its own board: the only thing this removes is the
               link, which is why there is no confirm in front of it. -->
          <NbButton
            v-nb-tooltip="{
              body: `Detach ${part.key}. The card itself stays.`,
            }"
            size="sm"
            variant="ghost"
            icon="x"
            class="parts__detach"
            :aria-label="`Detach ${part.key} from ${itemKey}. The card is not deleted.`"
            @click="detach(part.key)"
          />
        </li>
      </ul>

      <p v-else class="parts__none">
        Nothing is part of this card yet. Adding one does not move it: it stays
        on its own board.
      </p>

      <!-- Search rather than a list of options. A part may be on any board,
           so the pool is the whole workspace, which is too big to put in a
           select and is exactly what search already answers. -->
      <div class="parts__add">
        <NbTextInput
          :id="`field-part-${itemKey}`"
          v-model="query"
          size="sm"
          label="Add a part"
          placeholder="Search any board..."
          autocomplete="off"
          :error="error"
        >
          <template #leading>
            <NbIcon name="magnifying-glass" :size="15" />
          </template>
        </NbTextInput>

        <p v-if="searching" class="parts__note">Searching...</p>
        <p v-else-if="query.trim() && hits.length === 0" class="parts__note">
          No card matches that.
        </p>
        <ul v-else-if="hits.length > 0" class="parts__hits">
          <li v-for="hit in hits" :key="hit.ref">
            <button
              type="button"
              class="parts__hit"
              :disabled="busy"
              :aria-label="`Make ${hit.ref} part of ${itemKey}`"
              @click="attach(hit.ref)"
            >
              <span class="parts__key">{{ hit.ref }}</span>
              <span class="parts__title">{{ hit.title }}</span>
              <NbBadge
                v-if="hit.space && hit.space !== space"
                size="sm"
                variant="grey"
              >
                {{ hit.space }}
              </NbBadge>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * What this card is made of.
 *
 * Deliberately not part of the dependency panel. "ST-9 waits on ST-4" and
 * "ST-9 is part of ST-4" are different relations, and the whole reason the
 * model has a parent link rather than a card type is that the two must stay
 * visibly apart on the card as well as in the data.
 *
 * Every write is the same op on the CHILD: a part is made by pointing the
 * child at this card, and detached by pointing it at nothing. The parent
 * never stores a list, so there is no second place for the two to disagree.
 */
import { computed, ref, watch } from 'vue'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import type { IPartRef, ISearchResult } from '@/types/api'

const props = defineProps<{
  itemKey: string
  /** The space this card is on, which decides which parts are "elsewhere". */
  space: string
  parts: IPartRef[]
}>()

const emit = defineEmits<{ changed: []; open: [key: string] }>()

const query = ref('')
const hits = ref<ISearchResult[]>([])
const searching = ref(false)
const busy = ref(false)
const error = ref<string | undefined>(undefined)

const doneCount = computed(() => props.parts.filter((p) => p.done).length)

let debounce: ReturnType<typeof setTimeout> | undefined
// A slow search that lands after a newer one would otherwise overwrite it
// with stale hits, which reads as the search box ignoring what was typed.
let generation = 0

/** Cards that cannot be a part: this one, and the ones already attached. */
const taken = computed(
  () => new Set([props.itemKey, ...props.parts.map((p) => p.key)]),
)

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
    hits.value = results.filter((r) => !taken.value.has(r.ref)).slice(0, 7)
  } catch {
    // A picker that cannot reach the server shows no matches rather than an
    // error banner on a card. The card itself is fine.
    if (mine === generation) hits.value = []
  } finally {
    if (mine === generation) searching.value = false
  }
}

async function attach(key: string): Promise<void> {
  busy.value = true
  error.value = undefined
  try {
    const { results } = await api.itemWrite([
      { op: 'set_parent', op_id: newOpId(), key, parent: props.itemKey },
    ])
    const result = results[0]
    // A refusal is a sentence the server has already written ("ST-4 is
    // already part of ST-9, directly or through others"), and naming the two
    // cards is the whole value of it. humanise() would turn that into "try
    // again", inviting a retry of something that can never succeed.
    if (!result.ok) {
      error.value = (result as { error: string }).error
      return
    }
    query.value = ''
    hits.value = []
    emit('changed')
  } catch (err) {
    error.value = humanise(err)
  } finally {
    busy.value = false
  }
}

async function detach(key: string): Promise<void> {
  await api.itemWrite([
    { op: 'set_parent', op_id: newOpId(), key, parent: null },
  ])
  emit('changed')
}
</script>

<style scoped lang="scss">
.parts {
  display: grid;
  gap: var(--nb-spacing-12);

  /* Same bounded surface as the dependency panel: two sibling sections of a
     card should not read as two different kinds of thing. */
  &__body {
    display: grid;
    gap: var(--nb-spacing-12);
    padding: var(--nb-spacing-12);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-md);
    background: var(--nb-c-surface);
  }

  /* A sentence, not a bar. The checklists in the same panel already state
     progress as a count, and a second, louder way of saying the same thing
     would make parts look more important than the work on the card. */
  &__progress {
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-text-subtle);
  }

  &__list,
  &__hits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-2);
  }

  &__row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    min-inline-size: 0;
  }

  &__ref,
  &__hit {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    flex: 1;
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

  /* Never wraps: a key broken across two lines is unreadable as an address. */
  &__key {
    flex: none;
    white-space: nowrap;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);

    &--done {
      text-decoration: line-through;
    }
  }

  &__title {
    flex: 1;
    min-inline-size: 0;
    font-size: var(--nb-type-body-sm-size);
    font-weight: var(--nb-type-label-lg-weight);
    color: var(--nb-c-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__space {
    flex: none;
  }

  &__done {
    flex: none;
    color: var(--nb-c-success);
  }

  &__detach {
    flex: none;
  }

  &__none,
  &__note {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__add {
    display: grid;
    gap: var(--nb-spacing-8);
    padding-block-start: var(--nb-spacing-8);
    border-block-start: 1px solid var(--nb-c-border);
  }
}
</style>

<template>
  <div class="deps">
    <!-- A bounded block, because "what this waits on" is one fact with a start
         and an end, and the previous version let it bleed into the fields
         above it. Both directions live here: a card's place in a plan is as
         much what waits on it as what it waits for, and only one of those is
         visible from the card you are reading. -->
    <div class="deps__links nb-layer-2">
      <div v-if="relations.length > 0" class="deps__groups">
        <section
          v-for="group in relations"
          :key="group.kind"
          class="deps__group"
        >
          <h4 class="deps__label">
            <NbIcon
              v-if="group.kind === 'blocked_by'"
              name="arrow-line-left"
              :size="13"
              aria-hidden="true"
            />
            <NbIcon
              v-else
              name="arrow-line-right"
              :size="13"
              aria-hidden="true"
            />
            {{ group.label }}
          </h4>
          <ul class="deps__list">
            <li
              v-for="dep in group.refs"
              :key="dep.key"
              class="deps__row nb-layer-3"
            >
              <button
                type="button"
                class="deps__ref"
                :aria-label="`Open ${dep.key}: ${dep.title}`"
                @click="emit('open', dep.key)"
              >
                <span
                  class="deps__key"
                  :class="{ 'deps__key--done': dep.done }"
                >
                  {{ dep.key }}
                </span>
                <!-- The title leads. The key is the address, but nobody reads
                     a plan by its addresses. -->
                <span class="deps__title">{{ dep.title }}</span>
                <NbIcon
                  v-if="dep.done"
                  v-nb-tooltip="{ body: 'Done' }"
                  name="check-circle"
                  :size="14"
                  class="deps__done"
                />
              </button>
              <NbButton
                v-nb-tooltip="{ body: `Unlink ${dep.key}` }"
                size="sm"
                variant="ghost"
                icon="x"
                class="deps__remove"
                :aria-label="`Remove the link to ${dep.key}`"
                @click="remove(group.kind, dep.key)"
              />
            </li>
          </ul>
        </section>
      </div>

      <p v-else class="deps__none">
        Not linked to anything. This can start whenever you like.
      </p>

      <!-- Pick the relation, pick the card. Typing a key meant knowing it by
           heart and finding out it was wrong only after submitting. -->
      <form class="deps__add" @submit.prevent="add">
        <NbSelect
          :id="`field-relation-${itemKey}`"
          v-model="relation"
          size="sm"
          :options="RELATIONS"
          aria-label="How this card relates to the one you pick"
          class="deps__relation"
        />
        <NbSelect
          :id="`field-target-${itemKey}`"
          v-model="target"
          size="sm"
          :options="candidates"
          :disabled="loadingCandidates"
          :error="error"
          :placeholder="loadingCandidates ? 'Loading cards…' : 'Pick a card'"
          aria-label="The card to link to"
          class="deps__target"
          @update:model-value="error = undefined"
        >
          <template #option="{ option }">
            <span class="deps__opt">
              <span class="deps__key">{{ option.value }}</span>
              <span class="deps__opt-title">{{ titleOf(option) }}</span>
            </span>
          </template>
        </NbSelect>
        <NbButton
          type="submit"
          size="sm"
          variant="secondary"
          :loading="busy"
          :disabled="!target"
        >
          Link
        </NbButton>
      </form>
    </div>

    <div class="deps__estimate nb-layer-2">
      <NbTextInput
        :id="`field-size-${itemKey}`"
        v-model="sizeDraft"
        size="sm"
        label="Size"
        inputmode="decimal"
        placeholder="Unsized"
        class="deps__size"
        @blur="commitSize"
      />
      <NbCheckbox
        :id="`field-milestone-${itemKey}`"
        v-model="milestoneDraft"
        label="Milestone"
        @update:model-value="commitSize"
      />
      <p class="deps__hint">
        Size is unitless and feeds the critical path in the sequence view.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * A card's place in the plan, on the card.
 *
 * The sequence view knew what a card waited on and the card itself said
 * nothing, which reads as two different sources of truth. This is the same
 * fact, shown where the fact is edited.
 */
import { computed, ref, watch } from 'vue'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import type { IDependencyRef } from '@/types/api'

const props = defineProps<{
  itemKey: string
  /** Where to look for cards to link to. */
  space: string
  blockedBy: IDependencyRef[]
  blocks: IDependencyRef[]
  size?: number
  isMilestone?: boolean
}>()

const emit = defineEmits<{ changed: []; open: [key: string] }>()

type TKind = 'blocked_by' | 'blocks'

/** Phrased as a sentence about this card, so the row reads left to right. */
const RELATIONS = [
  { label: 'is blocked by', value: 'blocked_by' },
  { label: 'blocks', value: 'blocks' },
]

const relation = ref<TKind>('blocked_by')
const target = ref<string | null>(null)
const error = ref<string | undefined>(undefined)
const busy = ref(false)
const sizeDraft = ref('')
const milestoneDraft = ref(false)

const relations = computed(() =>
  [
    {
      kind: 'blocked_by' as const,
      label: 'Blocked by',
      refs: props.blockedBy,
    },
    {
      kind: 'blocks' as const,
      label: 'Blocks',
      refs: props.blocks,
    },
  ].filter((group) => group.refs.length > 0),
)

watch(
  () => [props.size, props.isMilestone] as const,
  ([size, milestone]) => {
    sizeDraft.value = size === undefined ? '' : String(size)
    milestoneDraft.value = milestone === true
  },
  { immediate: true },
)

/**
 * Cards in the same space, minus this one and anything already linked.
 *
 * Same space only: a dependency across spaces is legal in the model but the
 * sequence view is drawn per space, so an edge leaving it would be invisible
 * exactly where it matters.
 */
const pool = ref<{ key: string; title: string }[]>([])
const loadingCandidates = ref(false)

const linked = computed(
  () =>
    new Set([
      props.itemKey,
      ...props.blockedBy.map((d) => d.key),
      ...props.blocks.map((d) => d.key),
    ]),
)

const candidates = computed(() =>
  pool.value
    .filter((row) => !linked.value.has(row.key))
    .map((row) => ({ label: `${row.key}  ${row.title}`, value: row.key })),
)

/** The option slot wants the two halves apart; the label keeps them together
    for the closed control and for typeahead inside the listbox. */
function titleOf(option: { label: string; value: string | number }): string {
  return option.label.slice(String(option.value).length).trim()
}

watch(
  () => props.space,
  async (space) => {
    if (!space) return
    loadingCandidates.value = true
    try {
      // 200 is the server's cap. Asking for 500 was refused outright, so the
      // picker was empty every time it opened rather than merely short.
      const { items } = await api.spaceGet(space, { limit: '200' })
      pool.value = items
        .filter((row) => !row.archived && !row.done)
        .map((row) => ({ key: row.key, title: row.title }))
    } catch {
      // A picker that cannot load is not worth an error banner on a card:
      // the list is simply empty and Link stays disabled.
      pool.value = []
    } finally {
      loadingCandidates.value = false
    }
  },
  { immediate: true },
)

async function add(): Promise<void> {
  const other = target.value
  if (!other) return
  busy.value = true
  error.value = undefined
  // One op, either direction: "A blocks B" is "B is blocked by A" with the
  // ends swapped, and the model only stores it once.
  const [key, blocker] =
    relation.value === 'blocked_by'
      ? [props.itemKey, other]
      : [other, props.itemKey]
  try {
    const { results } = await api.itemWrite([
      { op: 'depends_on', op_id: newOpId(), key, blocker },
    ])
    const result = results[0]
    // A refusal is not a failure: the server has already written the sentence
    // ("ST-41 already waits on ST-33, directly or through others"), and naming
    // the two cards is the whole value. Running it through humanise() turned
    // it into "Something went wrong; try again", which invites a retry of
    // something that can never succeed. humanise() stays for the transport.
    if (!result.ok) {
      error.value = (result as { error: string }).error
      return
    }
    target.value = null
    emit('changed')
  } catch (err) {
    error.value = humanise(err)
  } finally {
    busy.value = false
  }
}

async function remove(kind: TKind, other: string): Promise<void> {
  const [key, blocker] =
    kind === 'blocked_by' ? [props.itemKey, other] : [other, props.itemKey]
  await api.itemWrite([{ op: 'undepend', op_id: newOpId(), key, blocker }])
  emit('changed')
}

/** Size and milestone travel together: both live on the same op. */
async function commitSize(): Promise<void> {
  const raw = sizeDraft.value.trim()
  const parsed = raw === '' ? null : Number(raw)
  if (parsed !== null && !Number.isFinite(parsed)) {
    sizeDraft.value = props.size === undefined ? '' : String(props.size)
    return
  }
  if (
    parsed === (props.size ?? null) &&
    milestoneDraft.value === !!props.isMilestone
  )
    return
  await api.itemWrite([
    {
      op: 'size',
      op_id: newOpId(),
      key: props.itemKey,
      size: parsed,
      is_milestone: milestoneDraft.value,
    },
  ])
  emit('changed')
}
</script>

<style scoped lang="scss">
.deps {
  display: grid;
  gap: var(--nb-spacing-12);

  /* The answer to "where does this start and end" is a surface, not just a
     border. .nb-layer-2 is the library's level for a nested panel: it rebinds
     --nb-c-surface, --nb-c-border and --nb-c-surface-hover for everything
     inside, so the rows below get their lift from the same system rather than
     from a hand-picked grey. */
  &__links {
    display: grid;
    gap: var(--nb-spacing-12);
    padding: var(--nb-spacing-12);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-md);
    background: var(--nb-c-surface);
  }

  &__groups {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__group {
    display: grid;
    gap: var(--nb-spacing-4);
  }

  &__label {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-text-subtle);
  }

  &__list {
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

  &__ref {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    flex: 1;
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
  }

  /* Never wraps. A two-character-wide column that broke "ST-41" across two
     lines was the single worst thing about the old version. */
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

  /* The prominent half: full text colour and weight, the key beside it muted.
     Reversing those made every row look like an id with a footnote. */
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

  &__done {
    flex: none;
    color: var(--nb-c-success);
  }

  /* Square and reachable. An xxs icon button is a 16px target sitting next to
     a 32px row, which reads as damage rather than as a control. */
  &__remove {
    flex: none;
  }

  &__none {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__add {
    display: grid;
    grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) max-content;
    align-items: end;
    gap: var(--nb-spacing-4);
    padding-block-start: var(--nb-spacing-8);
    border-block-start: 1px solid var(--nb-c-border);
  }

  &__opt {
    display: flex;
    align-items: baseline;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
  }

  &__opt-title {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__estimate {
    display: grid;
    grid-template-columns: max-content max-content;
    align-items: end;
    gap: var(--nb-spacing-8) var(--nb-spacing-16);
    padding: var(--nb-spacing-12);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-md);
    background: var(--nb-c-surface);
  }

  &__size {
    inline-size: 5rem;
  }

  &__hint {
    grid-column: 1 / -1;
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
  }
}

/* The checkbox sits on the input's baseline, not the label's. */
:deep(.nb-checkbox) {
  padding-block-end: var(--nb-spacing-4);
}
</style>

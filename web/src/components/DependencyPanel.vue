<template>
  <div class="deps">
    <!-- Both directions, because a card's place in a plan is as much what
         waits on it as what it waits for, and only one of those is visible
         from the card you are reading. -->
    <div class="deps__group">
      <span class="deps__label">Waits for</span>
      <ul v-if="blockedBy.length > 0" class="deps__list">
        <li v-for="dep in blockedBy" :key="dep.key">
          <button
            type="button"
            class="deps__ref"
            @click="emit('open', dep.key)"
          >
            <s v-if="dep.done">{{ dep.key }}</s>
            <template v-else>{{ dep.key }}</template>
            <span class="deps__title">{{ dep.title }}</span>
          </button>
          <NbButton
            v-nb-tooltip="{ body: `Stop waiting for ${dep.key}` }"
            size="xxs"
            variant="ghost"
            icon="x"
            :aria-label="`Remove the dependency on ${dep.key}`"
            @click="remove(dep.key)"
          />
        </li>
      </ul>
      <p v-else class="deps__none">Nothing. This can start now.</p>

      <form class="deps__add" @submit.prevent="add">
        <NbTextInput
          :id="`field-blocker-${itemKey}`"
          v-model="draft"
          size="sm"
          placeholder="Card key, e.g. ST-41"
          :error="error"
          aria-label="Add a card this one waits for"
        />
        <NbButton
          type="submit"
          size="xs"
          variant="secondary"
          :loading="busy"
          :disabled="!draft.trim()"
        >
          Add
        </NbButton>
      </form>
    </div>

    <!-- Read-only: an edge is owned by the card that waits, so the place to
         remove it is there. Offering it from both ends means two controls
         for one fact. -->
    <div v-if="blocks.length > 0" class="deps__group">
      <span class="deps__label">Blocks</span>
      <ul class="deps__list">
        <li v-for="dep in blocks" :key="dep.key">
          <button
            type="button"
            class="deps__ref"
            @click="emit('open', dep.key)"
          >
            <s v-if="dep.done">{{ dep.key }}</s>
            <template v-else>{{ dep.key }}</template>
            <span class="deps__title">{{ dep.title }}</span>
          </button>
        </li>
      </ul>
    </div>

    <div class="deps__group deps__group--inline">
      <span class="deps__label">Size</span>
      <NbTextInput
        :id="`field-size-${itemKey}`"
        v-model="sizeDraft"
        size="sm"
        inputmode="decimal"
        placeholder="—"
        aria-label="Estimated size, unitless"
        class="deps__size"
        @blur="commitSize"
      />
      <NbCheckbox
        :id="`field-milestone-${itemKey}`"
        v-model="milestoneDraft"
        label="Milestone"
        @update:model-value="commitSize"
      />
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
import { ref, watch } from 'vue'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import type { IDependencyRef } from '@/types/api'

const props = defineProps<{
  itemKey: string
  blockedBy: IDependencyRef[]
  blocks: IDependencyRef[]
  size?: number
  isMilestone?: boolean
}>()

const emit = defineEmits<{ changed: []; open: [key: string] }>()

const draft = ref('')
const error = ref<string | undefined>(undefined)
const busy = ref(false)
const sizeDraft = ref('')
const milestoneDraft = ref(false)

watch(
  () => [props.size, props.isMilestone] as const,
  ([size, milestone]) => {
    sizeDraft.value = size === undefined ? '' : String(size)
    milestoneDraft.value = milestone === true
  },
  { immediate: true },
)

async function add(): Promise<void> {
  const blocker = draft.value.trim().toUpperCase()
  if (!blocker) return
  busy.value = true
  error.value = undefined
  try {
    const { results } = await api.itemWrite([
      { op: 'depends_on', op_id: newOpId(), key: props.itemKey, blocker },
    ])
    const result = results[0]
    // The server refuses a cycle and a card blocking itself. Both are worth
    // saying plainly here rather than as a toast that outlives the form.
    if (!result.ok) throw new Error((result as { error: string }).error)
    draft.value = ''
    emit('changed')
  } catch (err) {
    error.value = humanise(err)
  } finally {
    busy.value = false
  }
}

async function remove(blocker: string): Promise<void> {
  await api.itemWrite([
    { op: 'undepend', op_id: newOpId(), key: props.itemKey, blocker },
  ])
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

  &__group {
    display: grid;
    gap: var(--nb-spacing-4);

    &--inline {
      grid-template-columns: max-content max-content max-content;
      align-items: center;
      gap: var(--nb-spacing-8);
    }
  }

  &__label {
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight, 600);
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

    li {
      display: flex;
      align-items: center;
      gap: var(--nb-spacing-4);
      min-inline-size: 0;
    }
  }

  &__ref {
    display: flex;
    align-items: baseline;
    gap: var(--nb-spacing-8);
    flex: 1;
    min-inline-size: 0;
    padding: var(--nb-spacing-2) var(--nb-spacing-4);
    background: none;
    border: 0;
    border-radius: var(--nb-radius-sm, 4px);
    text-align: start;
    font: inherit;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: inherit;
    cursor: pointer;

    &:hover {
      background: var(--nb-c-surface-hover, rgb(128 128 128 / 8%));
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
      outline-offset: -1px;
    }
  }

  /* The title is why the key means anything, but the key is what is being
     referred to, so the title gives way first. */
  &__title {
    font-family: var(--nb-font-family-sans);
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-inline-size: 0;
  }

  &__none {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__add {
    display: flex;
    align-items: start;
    gap: var(--nb-spacing-4);
    margin-block-start: var(--nb-spacing-4);
  }

  &__size {
    inline-size: 5rem;
  }
}
</style>

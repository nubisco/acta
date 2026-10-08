<template>
  <NbMenu
    ref="menu"
    :open="open"
    :min-width="300"
    :max-width="380"
    @update:open="(value: boolean) => !value && emit('close')"
    @close="emit('close')"
  >
    <form
      v-if="row && field"
      class="quick-edit"
      :aria-label="`${HEADINGS[field]} for ${row.key}`"
      @submit.prevent="submitSize"
    >
      <p class="quick-edit__head">
        {{ HEADINGS[field] }}
        <span class="quick-edit__key">{{ row.key }}</span>
      </p>
      <NbBanner v-if="error" status="error" variant="inline" :title="error" />

      <NbSelect
        v-if="field === 'goal'"
        id="quick-edit-goal"
        :model-value="null"
        size="sm"
        placeholder="Pick a goal"
        :options="goalOptions"
        :disabled="saving"
        @update:model-value="linkGoal"
      />

      <NbSelect
        v-else-if="field === 'labels'"
        id="quick-edit-labels"
        v-model="labelDraft"
        size="sm"
        multiple
        placeholder="Pick labels"
        :options="labelOptions"
        :disabled="saving"
        @change="void commitSet('label')"
      >
        <template #option="{ option }">
          <span
            v-if="headingName(String(option.value))"
            class="quick-edit__group"
          >
            {{ headingName(String(option.value)) }}
          </span>
          <LabelBadge v-else :id="String(option.value)" size="md" />
        </template>
      </NbSelect>

      <NbSelect
        v-else-if="field === 'people'"
        id="quick-edit-people"
        v-model="peopleDraft"
        size="sm"
        multiple
        placeholder="Pick people"
        :options="peopleOptions"
        :disabled="saving"
        @change="void commitSet('assign')"
      >
        <template #option="{ option }">
          <ActorChip :handle="String(option.value)" />
        </template>
      </NbSelect>

      <NbDatePicker
        v-else-if="field === 'due'"
        id="quick-edit-due"
        v-model="dueDraft"
        size="sm"
        :disabled="saving"
        @change="commitDue"
      />

      <div v-else-if="field === 'size'" class="quick-edit__size">
        <NbNumberInput
          id="quick-edit-size"
          v-model="sizeDraft"
          size="sm"
          :min="0"
          :max="1000"
          :disabled="saving"
        />
        <NbButton
          type="submit"
          size="sm"
          variant="primary"
          :loading="saving"
          :disabled="sizeDraft === null"
        >
          Set
        </NbButton>
      </div>
    </form>
  </NbMenu>
</template>

<script setup lang="ts">
/**
 * Setting a field from an empty slot on a board card.
 *
 * Each empty row of a card is a button ("No goal", the empty calendar, the
 * empty face). This is what it opens: the one field, right where the slot
 * is, so filling in a card does not mean opening it. Anything more than the
 * one field still belongs to the details panel.
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { NbMenu } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import type { ISpaceItemRow } from '@/types/api'
import { humanise } from '@/lib/state'
import { goalOptionLabel } from '@/lib/goals'
import { headingName, headingOption, labelGroups } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'
import type { TCardField } from '@/components/BoardCard.vue'
import ActorChip from '@/components/ActorChip.vue'
import LabelBadge from '@/components/LabelBadge.vue'

const props = defineProps<{
  open: boolean
  field: TCardField | null
  row: ISpaceItemRow | null
  spaceKey: string
  /** The slot that was clicked, which the menu opens under. */
  anchor: HTMLElement | null
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const HEADINGS: Record<TCardField, string> = {
  goal: 'Goal',
  labels: 'Labels',
  people: 'Assignees',
  due: 'Due date',
  size: 'Size',
}

const ws = useWorkspace()
const menu = ref<InstanceType<typeof NbMenu> | null>(null)
const saving = ref(false)
const error = ref('')

const labelDraft = ref<string[]>([])
const peopleDraft = ref<string[]>([])
/* What the card holds as far as this menu knows. Moved forward on every
 * write, so a second pick is measured against the first rather than against
 * a row the board has not reloaded yet. */
let labelBase: string[] = []
let peopleBase: string[] = []
const dueDraft = ref<string | null>(null)
const sizeDraft = ref<number | null>(null)

watch(
  () => [props.open, props.row?.key, props.field] as const,
  async ([open]) => {
    if (!open || !props.row) return
    error.value = ''
    labelBase = [...(props.row.label_ids ?? [])]
    peopleBase = [...(props.row.assignees ?? [])]
    labelDraft.value = [...labelBase]
    peopleDraft.value = [...peopleBase]
    dueDraft.value = null
    sizeDraft.value = null
    await nextTick()
    const rect = props.anchor?.getBoundingClientRect()
    if (rect) menu.value?.setPosition(rect)
    // Into the field, so typing and Escape work at once and a keyboard user
    // is not left on the card behind the menu.
    await nextTick()
    document
      .querySelector<HTMLElement>(
        `.quick-edit #quick-edit-${props.field}, .quick-edit [id^="quick-edit-${props.field}"]`,
      )
      ?.focus()
  },
  { immediate: true },
)

const goalOptions = computed(() =>
  (ws.overview.value?.goals ?? [])
    .filter((g) => !g.archived)
    .map((g) => ({ label: goalOptionLabel(g), value: g.number })),
)

const labelOptions = computed(() =>
  labelGroups(ws.overview.value, props.spaceKey).flatMap((group) => [
    headingOption(group),
    ...group.labels.map((l) => ({ label: l.name, value: l.id })),
  ]),
)

const peopleOptions = computed(() =>
  (ws.overview.value?.actors ?? [])
    .filter((a) => a.kind === 'human')
    .map((a) => ({ label: a.name, value: a.handle })),
)

/** Runs one write, reports a refusal in place, and says whether it took. */
async function run(write: () => Promise<{ ok: boolean; error?: string }>) {
  saving.value = true
  error.value = ''
  try {
    const result = await write()
    if (!result.ok) {
      error.value = result.error ?? 'That did not save'
      return false
    }
    emit('saved')
    return true
  } catch (err) {
    error.value = humanise(err)
    return false
  } finally {
    saving.value = false
  }
}

type TItemOp = Parameters<typeof api.itemWrite>[0][number]

async function itemOp(op: TItemOp): Promise<boolean> {
  return run(async () => {
    const { results } = await api.itemWrite([op])
    return results[0] as { ok: boolean; error?: string }
  })
}

async function linkGoal(value: unknown): Promise<void> {
  if (!props.row || value === null || value === undefined || value === '')
    return
  const key = props.row.key
  const done = await run(async () => {
    const { results } = await api.goalWrite([
      { op: 'link', op_id: newOpId(), goal: Number(value), add: [key] },
    ])
    return results[0] as { ok: boolean; error?: string }
  })
  if (done) emit('close')
}

/**
 * Labels and people stay open while you pick, since picking two is normal,
 * and each change is written as it happens: add what is new, remove what
 * went. A group that takes a single answer is pruned by the server.
 */
async function commitSet(kind: 'label' | 'assign'): Promise<void> {
  if (!props.row) return
  const current =
    kind === 'label' ? [...labelDraft.value] : [...peopleDraft.value]
  const before = new Set(kind === 'label' ? labelBase : peopleBase)
  const after = new Set(current)
  const add = [...after].filter((v) => !before.has(v))
  const remove = [...before].filter((v) => !after.has(v))
  if (add.length === 0 && remove.length === 0) return
  const done = await itemOp({
    op: kind,
    op_id: newOpId(),
    key: props.row.key,
    add: add.length > 0 ? add : undefined,
    remove: remove.length > 0 ? remove : undefined,
  })
  if (!done) return
  if (kind === 'label') labelBase = current
  else peopleBase = current
}

async function commitDue(): Promise<void> {
  if (!props.row || !dueDraft.value) return
  const done = await itemOp({
    op: 'update',
    op_id: newOpId(),
    key: props.row.key,
    due: Date.parse(dueDraft.value),
  })
  if (done) emit('close')
}

async function submitSize(): Promise<void> {
  if (!props.row || props.field !== 'size' || sizeDraft.value === null) return
  const done = await itemOp({
    op: 'size',
    op_id: newOpId(),
    key: props.row.key,
    size: sizeDraft.value,
  })
  if (done) emit('close')
}
</script>

<style scoped lang="scss">
.quick-edit {
  display: grid;
  gap: var(--nb-spacing-8);
  padding: var(--nb-spacing-8);

  &__head {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: var(--nb-spacing-8);
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-md-weight);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-text-subtle);
  }

  &__key {
    font-family: var(--nb-font-family-mono);
    text-transform: none;
    letter-spacing: 0;
  }

  &__group {
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__size {
    display: flex;
    align-items: end;
    gap: var(--nb-spacing-8);
  }
}
</style>

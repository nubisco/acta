<template>
  <NbModal
    close-appearance="button"
    :open="open"
    :title="editing ? `Edit ${goal?.key}` : 'New goal'"
    size="md"
    :close-on-overlay="!isDirty"
    @close="onClose"
  >
    <NbForm id="goal-form" class="goal-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-goal-title"
        ref="titleInput"
        v-model="form.title"
        label="What are we trying to achieve?"
        placeholder="Ship licensing v2 to every customer"
        :error="errors.title"
        required
        @blur="validateTitle"
      />

      <div class="goal-form__row">
        <NbSelect
          id="field-goal-owner"
          v-model="form.owner"
          label="Owner"
          :options="ownerOptions"
          helper="The person steering it, who posts the check-ins."
        >
          <template #option="{ option }">
            <ActorChip v-if="option.value" :handle="String(option.value)" />
            <span v-else>{{ option.label }}</span>
          </template>
          <template #value="{ values }">
            <ActorChip v-if="values[0]" :handle="String(values[0])" />
            <span v-else>No owner</span>
          </template>
        </NbSelect>
        <NbSelect
          id="field-goal-parent"
          v-model="form.parent"
          label="Part of"
          :options="parentOptions"
          helper="A bigger goal this one contributes to."
        />
      </div>

      <NbDatePicker
        id="field-goal-window"
        v-model="form.start"
        v-model:end-value="form.target"
        type="range"
        label="Start"
        end-label="Target date"
      />

      <NbSelect
        v-if="!editing"
        id="field-goal-status"
        v-model="form.status"
        label="Status"
        :options="GOAL_STATUS_OPTIONS"
        helper="After this, the status moves with check-ins."
      />

      <div class="goal-form__description">
        <span class="goal-form__label">Why it matters</span>
        <div class="goal-form__editor">
          <MarkdownEditor
            v-model="form.description"
            placeholder="The outcome, who it is for, and how we will know it worked..."
          />
        </div>
      </div>

      <NbSwitch
        v-model="form.measured"
        name="goal-measured"
        label="Measure it with a number"
      />
      <div v-if="form.measured" class="goal-form__metric">
        <NbTextInput
          id="field-goal-metric-name"
          v-model="form.metricName"
          label="Metric"
          placeholder="Monthly recurring revenue"
          :error="errors.metric"
        />
        <NbTextInput
          id="field-goal-metric-unit"
          v-model="form.metricUnit"
          label="Unit"
          placeholder="€, %, users"
        />
        <NbNumberInput
          id="field-goal-metric-start"
          v-model="form.metricStart"
          label="Starts at"
        />
        <NbNumberInput
          id="field-goal-metric-target"
          v-model="form.metricTarget"
          label="Target"
        />
      </div>
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="onClose">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="goal-form"
        variant="primary"
        :loading="saving"
      >
        {{ editing ? 'Save goal' : 'Create goal' }}
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * Creating a goal and editing one, in one form.
 *
 * Status is offered only on create. After that it belongs to check-ins,
 * where a change of status comes with a dated sentence saying why, which is
 * the whole difference between a goal and a field somebody flips.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useConfirm } from '@nubisco/ui'
import type { NbTextInput } from '@nubisco/ui'
import type { TGoalOp } from '@nubisco/acta-shared'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import { GOAL_STATUS_OPTIONS, goalOptionLabel } from '@/lib/goals'
import { useWorkspace } from '@/stores/workspace'
import type { IGoalDetail, TGoalStatus } from '@/types/api'
import ActorChip from '@/components/ActorChip.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** The goal being edited. Absent means a new one. */
    goal?: IGoalDetail | null
    /** For a new goal: the goal it starts as part of. */
    parent?: number | null
  }>(),
  { goal: null, parent: null },
)
const emit = defineEmits<{ close: []; saved: [number: number] }>()

const ws = useWorkspace()
const confirm = useConfirm()
const titleInput = ref<InstanceType<typeof NbTextInput> | null>(null)
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ title?: string; metric?: string }>({})

const editing = computed(() => props.goal !== null)

/** Empty string stands for "none", because a select cannot hold null. */
const NONE = ''

function blank() {
  return {
    title: '',
    owner: ws.me.value?.kind === 'human' ? ws.me.value.handle : NONE,
    parent: props.parent !== null ? String(props.parent) : NONE,
    start: null as string | null,
    target: null as string | null,
    status: 'pending' as TGoalStatus,
    description: '',
    measured: false,
    metricName: '',
    metricUnit: '',
    metricStart: 0 as number | null,
    metricTarget: null as number | null,
  }
}

const form = reactive(blank())
let initial = JSON.stringify(form)

const isDirty = computed(() => JSON.stringify(form) !== initial)

function iso(ts: number | undefined): string | null {
  return ts === undefined ? null : new Date(ts).toISOString().slice(0, 10)
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const g = props.goal
    Object.assign(
      form,
      g
        ? {
            title: g.title,
            owner: g.owner ?? NONE,
            parent: g.parent !== undefined ? String(g.parent) : NONE,
            start: iso(g.start_date),
            target: iso(g.target_date),
            status: g.status,
            description: g.description,
            measured: g.metric !== undefined,
            metricName: g.metric?.name ?? '',
            metricUnit: g.metric?.unit ?? '',
            metricStart: g.metric?.start ?? 0,
            metricTarget: g.metric?.target ?? null,
          }
        : blank(),
    )
    initial = JSON.stringify(form)
    serverError.value = ''
    errors.title = undefined
    errors.metric = undefined
    requestAnimationFrame(() => titleInput.value?.focus())
  },
)

const ownerOptions = computed(() => [
  { label: 'No owner', value: NONE },
  ...(ws.overview.value?.actors ?? [])
    .filter((a) => a.kind === 'human')
    .map((a) => ({ label: a.name, value: a.handle })),
])

/**
 * Any goal but this one and what is already inside it, which the server
 * would refuse as a loop. Refusing it here as well means the choice is never
 * offered rather than offered and then rejected.
 */
const parentOptions = computed(() => {
  const all = (ws.overview.value?.goals ?? []).filter((g) => !g.archived)
  const blocked = new Set<number>()
  if (props.goal) {
    blocked.add(props.goal.number)
    let grew = true
    while (grew) {
      grew = false
      for (const g of all) {
        if (
          g.parent !== undefined &&
          blocked.has(g.parent) &&
          !blocked.has(g.number)
        ) {
          blocked.add(g.number)
          grew = true
        }
      }
    }
  }
  return [
    { label: 'Nothing, it stands on its own', value: NONE },
    ...all
      .filter((g) => !blocked.has(g.number))
      .map((g) => ({ label: goalOptionLabel(g), value: String(g.number) })),
  ]
})

function validateTitle(): void {
  errors.title = form.title.trim() ? undefined : 'Say what the goal is'
}

function validateMetric(): void {
  if (!form.measured) {
    errors.metric = undefined
    return
  }
  if (!form.metricName.trim()) errors.metric = 'Name what is being measured'
  else if (form.metricTarget === null || form.metricStart === null)
    errors.metric = 'Give it a starting value and a target'
  else if (form.metricTarget === form.metricStart)
    errors.metric = 'The target has to differ from where it starts'
  else errors.metric = undefined
}

function dateOf(value: string | null): number | null {
  return value ? Date.parse(value) : null
}

function metric() {
  return {
    name: form.metricName.trim(),
    unit: form.metricUnit.trim() || undefined,
    start: form.metricStart ?? 0,
    target: form.metricTarget ?? 0,
  }
}

async function submit(): Promise<void> {
  validateTitle()
  validateMetric()
  if (errors.title || errors.metric) return
  saving.value = true
  serverError.value = ''
  try {
    const ops: TGoalOp[] = []
    const g = props.goal
    if (!g) {
      ops.push({
        op: 'create',
        op_id: newOpId(),
        title: form.title.trim(),
        description: form.description,
        owner: form.owner || null,
        parent: form.parent ? Number(form.parent) : undefined,
        status: form.status,
        start_date: dateOf(form.start),
        target_date: dateOf(form.target),
        metric: form.measured ? metric() : undefined,
      })
    } else {
      ops.push({
        op: 'update',
        op_id: newOpId(),
        goal: g.number,
        if_rev: g.rev,
        title: form.title.trim(),
        description: form.description,
        owner: form.owner || null,
        start_date: dateOf(form.start),
        target_date: dateOf(form.target),
        metric: form.measured ? metric() : null,
      })
      const parent = form.parent ? Number(form.parent) : null
      if (parent !== (g.parent ?? null))
        ops.push({ op: 'set_parent', op_id: newOpId(), goal: g.number, parent })
    }
    const { results } = await api.goalWrite(ops)
    const failed = results.find((r) => !r.ok)
    if (failed && !failed.ok) {
      // The server's sentence names the goals involved, which is the useful
      // part of a refusal ("G-3 is already part of G-7").
      serverError.value = failed.error.startsWith('rev conflict')
        ? 'Somebody changed this goal while you were editing. Close and open it again to see their version.'
        : failed.error
      return
    }
    await ws.refresh()
    const number = g
      ? g.number
      : Number(String(results[0].ok && results[0].key).slice(2))
    emit('saved', number)
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}

function onClose(): void {
  if (!isDirty.value) {
    emit('close')
    return
  }
  void confirm({
    title: editing.value ? 'Discard your changes' : 'Discard this goal',
    message: 'What you typed will be lost.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
    onConfirm: () => emit('close'),
  })
}
</script>

<style scoped lang="scss">
.goal-form {
  display: grid;
  gap: var(--nb-spacing-16);

  &__row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--nb-spacing-16);
  }

  &__description {
    display: grid;
    gap: var(--nb-spacing-4);
  }

  &__label {
    font-size: var(--nb-type-label-md-size);
    font-weight: var(--nb-type-label-md-weight);
    color: var(--nb-c-text);
  }

  /* The box is ours, not the editor's: MarkdownEditor is a fragment, so a
     class on it is dropped. See CommentThread's composer for the same rule. */
  &__editor {
    border: 1px solid var(--nb-c-field-border, var(--nb-c-border));
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-8);
    background: var(--nb-c-surface);
    --md-editor-min-height: 6rem;

    &:focus-within {
      border-color: var(--nb-c-primary);
      box-shadow: 0 0 0 2px var(--nb-c-focus-ring);
    }
  }

  &__metric {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--nb-spacing-16);
  }
}

/* A phone. The form's implicit track grows to its widest field, and two
   14rem columns are wider than the dialog, so the fields ran off its edge.
   One column, sized by the dialog. */
@include variables.phone {
  .goal-form,
  .goal-form__row,
  .goal-form__metric {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

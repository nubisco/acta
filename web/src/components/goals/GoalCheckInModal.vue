<template>
  <NbModal
    close-appearance="button"
    :open="open"
    :title="`Check in on ${goal.key}`"
    size="md"
    :close-on-overlay="!isDirty"
    @close="onClose"
  >
    <NbForm id="goal-check-in-form" class="check-in" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <p class="check-in__context">
        <!-- The measured half, so the judgement is made looking at the work
             rather than from memory. -->
        <template v-if="goal.progress.cards_total > 0">
          The work behind it is {{ goal.progress.percent }}% done ({{
            goal.progress.cards_done
          }}
          of {{ goal.progress.cards_total }}
          cards).
        </template>
        <template v-else>No cards are linked to this goal yet.</template>
        <template v-if="goal.target_date">
          {{ targetLabel(goal.target_date) }}.
        </template>
      </p>

      <NbRadio
        v-model="status"
        name="goal-check-in-status"
        direction="horizontal"
        label="Where does it stand?"
        :options="statusOptions"
      />

      <NbNumberInput
        v-if="goal.metric"
        id="field-check-in-metric"
        v-model="metricValue"
        :label="`${goal.metric.name} now`"
        :helper="`Target ${metricValue_(goal.metric.target)}, last reported ${metricValue_(goal.metric.current)}.`"
      />

      <div class="check-in__note">
        <span class="check-in__label">What changed, and what is next</span>
        <div class="check-in__editor">
          <MarkdownEditor
            v-model="body"
            placeholder="A sentence or two. @handle to bring somebody in."
          />
        </div>
      </div>
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="onClose">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="goal-check-in-form"
        variant="primary"
        :loading="saving"
      >
        Post check-in
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * A check-in: the owner's dated word on where a goal stands.
 *
 * The status is chosen here and nowhere else after a goal is created, so
 * every change of status arrives with the sentence that explains it. Owners
 * and followers are told; the history stays on the goal.
 */
import { computed, ref, watch } from 'vue'
import { useConfirm } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import {
  GOAL_STATUS_OPTIONS,
  metricValue as formatMetric,
  targetLabel,
} from '@/lib/goals'
import type { IGoalRow, TGoalStatus } from '@/types/api'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

const props = defineProps<{ open: boolean; goal: IGoalRow }>()
const emit = defineEmits<{ close: []; posted: [] }>()

const confirm = useConfirm()
const status = ref<TGoalStatus>(props.goal.status)
const body = ref('')
const metricValue = ref<number | null>(null)
const saving = ref(false)
const serverError = ref('')

const statusOptions = GOAL_STATUS_OPTIONS

function metricValue_(value: number): string {
  return formatMetric(value, props.goal.metric?.unit)
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    status.value = props.goal.status
    body.value = ''
    metricValue.value = props.goal.metric?.current ?? null
    serverError.value = ''
  },
)

const isDirty = computed(
  () =>
    body.value.trim() !== '' ||
    status.value !== props.goal.status ||
    (props.goal.metric !== undefined &&
      metricValue.value !== props.goal.metric.current),
)

async function submit(): Promise<void> {
  saving.value = true
  serverError.value = ''
  try {
    const metricChanged =
      props.goal.metric !== undefined &&
      metricValue.value !== null &&
      metricValue.value !== props.goal.metric.current
    const { results } = await api.goalWrite([
      {
        op: 'check_in',
        op_id: newOpId(),
        goal: props.goal.number,
        // Always sent: a check-in that confirms "still on track" is news,
        // and it is what keeps a goal from reading as quiet.
        status: status.value,
        body: body.value.trim() || undefined,
        metric_value: metricChanged
          ? (metricValue.value ?? undefined)
          : undefined,
      },
    ])
    const result = results[0]
    if (!result.ok) {
      serverError.value = result.error
      return
    }
    emit('posted')
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
    title: 'Discard this check-in',
    message: 'What you wrote will be lost.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep writing',
    onConfirm: () => emit('close'),
  })
}
</script>

<style scoped lang="scss">
.check-in {
  display: grid;
  gap: var(--nb-spacing-16);

  &__context {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
  }

  &__note {
    display: grid;
    gap: var(--nb-spacing-4);
  }

  &__label {
    font-size: var(--nb-type-label-md-size);
    font-weight: var(--nb-type-label-md-weight);
    color: var(--nb-c-text);
  }

  &__editor {
    border: 1px solid var(--nb-c-field-border, var(--nb-c-border));
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-8);
    background: var(--nb-c-surface);
    --md-editor-min-height: 5rem;

    &:focus-within {
      border-color: var(--nb-c-primary);
      box-shadow: 0 0 0 2px var(--nb-c-focus-ring);
    }
  }
}
</style>

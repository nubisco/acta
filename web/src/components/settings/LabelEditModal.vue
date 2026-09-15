<template>
  <NbModal
    :open="open"
    :title="title"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="emit('close')"
  >
    <NbForm :id="formId" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />

      <template v-if="mode === 'merge'">
        <p class="label-edit__lede">
          Every item labelled <strong>{{ label?.name }}</strong> gets the label
          you pick instead, and <strong>{{ label?.name }}</strong> is deleted.
          This cannot be undone.
        </p>
        <NbSelect
          :id="`${formId}-target`"
          v-model="target"
          label="Merge into"
          :options="siblingOptions"
          :error="errors.target"
          @change="errors.target = undefined"
        />
      </template>

      <template v-else>
        <NbTextInput
          :id="`${formId}-name`"
          ref="nameInput"
          v-model="name"
          label="Name"
          placeholder="Bug"
          :error="errors.name"
          @blur="validateName"
        />
        <NbSelect
          :id="`${formId}-color`"
          v-model="color"
          label="Colour"
          :options="LABEL_COLOR_OPTIONS"
        />
      </template>
    </NbForm>

    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        :form="formId"
        :variant="mode === 'merge' ? 'danger' : 'primary'"
        :loading="saving"
      >
        {{ submitLabel }}
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * One dialog for the three things you can do to a label: create it, rename
 * or recolour it, or merge it into another.
 *
 * Merge is destructive and irreversible, so it is a deliberate dialog with a
 * danger-coloured confirm rather than what it replaced: a select labelled
 * "Merge into..." sitting in the row, one mis-click away from silently
 * rewriting every item that carried the label.
 */
import { computed, reactive, ref, watch } from 'vue'
import type { NbTextInput } from '@nubisco/ui'
import { useToast } from '@nubisco/ui'
import { api, newOpId as opId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import {
  LABEL_COLOR_OPTIONS,
  type ILabelView,
} from '@/components/settings/labels'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit' | 'merge'
  /** The label being edited or merged. Null when creating. */
  label: ILabelView | null
  groupName: string
  /** Other labels in the same group, which are the merge targets. */
  siblings: ILabelView[]
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const ws = useWorkspace()
const toast = useToast()

const name = ref('')
const color = ref('gray')
const target = ref('')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ name?: string; target?: string }>({})
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const formId = 'label-edit-form'

const title = computed(
  () =>
    ({
      create: `New label in ${props.groupName}`,
      edit: 'Edit label',
      merge: 'Merge label',
    })[props.mode],
)

const submitLabel = computed(
  () =>
    ({
      create: 'Add label',
      edit: 'Save changes',
      merge: 'Merge labels',
    })[props.mode],
)

const siblingOptions = computed(() =>
  props.siblings.map((l) => ({ label: l.name, value: l.id })),
)

const isDirty = computed(() =>
  props.mode === 'merge'
    ? target.value !== ''
    : name.value !== (props.label?.name ?? '') ||
      color.value !== (props.label?.color ?? 'gray'),
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = props.label?.name ?? ''
    color.value = props.label?.color ?? 'gray'
    target.value = ''
    serverError.value = ''
    errors.name = undefined
    errors.target = undefined
    requestAnimationFrame(() => nameInput.value?.focus())
  },
)

function validateName(): void {
  errors.name = name.value.trim() ? undefined : 'Name the label'
}

async function run(ops: Parameters<typeof api.labelWrite>[0]): Promise<void> {
  const { results } = await api.labelWrite(ops)
  const bad = results.find((r) => !r.ok)
  if (bad) throw new Error((bad as { error: string }).error)
  await ws.refresh()
}

async function submit(): Promise<void> {
  if (props.mode === 'merge') {
    if (!target.value) {
      errors.target = 'Pick the label to keep'
      return
    }
  } else {
    validateName()
    if (errors.name) return
  }

  saving.value = true
  serverError.value = ''
  try {
    if (props.mode === 'create') {
      await run([
        {
          op: 'label_create',
          op_id: opId(),
          group: props.groupName,
          name: name.value.trim(),
          color: color.value,
        },
      ])
      toast.success('Label added')
    } else if (props.mode === 'edit') {
      const ops: Parameters<typeof api.labelWrite>[0] = []
      const trimmed = name.value.trim()
      // Only what actually changed. Sending an unchanged name as a rename
      // writes an event saying somebody renamed a label to itself.
      if (trimmed !== props.label?.name)
        ops.push({
          op: 'label_update',
          op_id: opId(),
          label: props.label!.id,
          name: trimmed,
        })
      if (color.value !== props.label?.color)
        ops.push({
          op: 'label_update',
          op_id: opId(),
          label: props.label!.id,
          color: color.value,
        })
      if (ops.length > 0) await run(ops)
      toast.success('Label saved')
    } else {
      await run([
        {
          op: 'label_merge',
          op_id: opId(),
          from: props.label!.id,
          into: target.value,
        },
      ])
      toast.success('Labels merged')
    }
    emit('saved')
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped lang="scss">
.label-edit__lede {
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-type-body-sm-size);
}
</style>

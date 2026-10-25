<template>
  <NbModal
    close-appearance="button"
    :open="open"
    :title="group ? 'Rename group' : 'New label group'"
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
      <NbTextInput
        :id="`${formId}-name`"
        ref="nameInput"
        v-model="name"
        label="Name"
        placeholder="Fixes version"
        :maxlength="100"
        :error="error"
        @blur="validate"
      />
      <NbSwitch
        v-if="!group"
        size="sm"
        label="One value per card"
        name="label-group-exclusive"
        :model-value="exclusive"
        @update:model-value="(on?: boolean) => (exclusive = on === true)"
      />
      <p class="label-group__scope">{{ scopeNote }}</p>
    </NbForm>

    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        :form="formId"
        variant="primary"
        :loading="saving"
      >
        {{ group ? 'Save' : 'Create group' }}
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * Make a label group, or rename one: the `group_create` and `group_update`
 * ops of `label_write`, so Settings can do what an agent can. Where it is
 * opened decides where the group belongs. From a space's Settings it is that
 * space's alone, from workspace Settings it applies to every space.
 */
import { computed, ref, watch } from 'vue'
import type { NbTextInput } from '@nubisco/ui'
import { useToast } from '@nubisco/ui'
import { api, newOpId as opId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{
  open: boolean
  /** The group being renamed. Null when creating. */
  group: { id: string; name: string } | null
  /** The space a new group belongs to, or null for the whole workspace. */
  space: string | null
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const ws = useWorkspace()
const toast = useToast()

const formId = 'label-group-form'
const name = ref('')
const exclusive = ref(false)
const saving = ref(false)
const serverError = ref('')
const error = ref<string | undefined>()
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => name.value !== (props.group?.name ?? ''))

const scopeNote = computed(() =>
  props.space
    ? 'Its labels are offered on this space only.'
    : 'Its labels are offered on every space in the workspace.',
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = props.group?.name ?? ''
    exclusive.value = false
    serverError.value = ''
    error.value = undefined
    requestAnimationFrame(() => nameInput.value?.focus())
  },
)

function validate(): void {
  error.value = name.value.trim() ? undefined : 'Name the group'
}

async function submit(): Promise<void> {
  validate()
  if (error.value) return
  const trimmed = name.value.trim()
  if (props.group && trimmed === props.group.name) {
    emit('saved')
    return
  }
  saving.value = true
  serverError.value = ''
  try {
    const { results } = await api.labelWrite([
      props.group
        ? {
            op: 'group_update',
            op_id: opId(),
            group: props.group.id,
            name: trimmed,
          }
        : {
            op: 'group_create',
            op_id: opId(),
            name: trimmed,
            ...(props.space ? { space: props.space } : {}),
            exclusive: exclusive.value,
          },
    ])
    const bad = results.find((r) => !r.ok)
    if (bad) throw new Error((bad as { error: string }).error)
    await ws.refresh()
    toast.success(props.group ? 'Group renamed' : 'Group created')
    emit('saved')
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped lang="scss">
.label-group__scope {
  margin: 0;
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-type-body-sm-size);
}
</style>

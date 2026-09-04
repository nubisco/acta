<template>
  <NbModal :open="open" :title="title" @close="cancel">
    <NbForm @submit.prevent="submit">
      <NbField v-for="field in fields" :key="field.name" :label="field.label">
        <NbTextInput
          v-model="values[field.name]"
          :placeholder="field.placeholder"
          :autofocus="field === fields[0]"
        />
      </NbField>
      <footer class="prompt__actions">
        <NbButton variant="ghost" type="button" @click="cancel"
          >Cancel</NbButton
        >
        <NbButton variant="primary" type="submit" :disabled="!valid">{{
          submitLabel
        }}</NbButton>
      </footer>
    </NbForm>
  </NbModal>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { NbButton, NbField, NbForm, NbModal, NbTextInput } from '@nubisco/ui'

export interface IPromptField {
  name: string
  label: string
  placeholder?: string
  optional?: boolean
  initial?: string
}

const props = defineProps<{
  open: boolean
  title: string
  fields: IPromptField[]
  submitLabel?: string
}>()

const emit = defineEmits<{
  submit: [values: Record<string, string>]
  close: []
}>()

const submitLabel = computed(() => props.submitLabel ?? 'Create')
const values = reactive<Record<string, string>>({})

watch(
  () => props.open,
  (open) => {
    if (open) {
      for (const field of props.fields) values[field.name] = field.initial ?? ''
    }
  },
  { immediate: true },
)

const valid = computed(() =>
  props.fields.every((f) => f.optional || values[f.name]?.trim()),
)

function submit(): void {
  if (!valid.value) return
  emit('submit', { ...values })
}

function cancel(): void {
  emit('close')
}
</script>

<style scoped lang="scss">
.prompt__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--nb-base-unit);
  margin-top: calc(var(--nb-base-unit) * 2);
}
</style>

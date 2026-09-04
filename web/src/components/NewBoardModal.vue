<template>
  <NbModal
    :open="open"
    title="New board"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="onClose"
  >
    <NbForm id="new-board-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-board-name"
        ref="nameInput"
        v-model="name"
        label="Name"
        placeholder="Stagewright"
        :error="errors.name"
        @blur="validateName"
      />
      <NbTextInput
        id="field-board-key"
        v-model="key"
        label="Key"
        placeholder="SW"
        :error="errors.key"
        @blur="validateKey"
      />
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="onClose">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="new-board-form"
        variant="primary"
        :loading="saving"
      >
        Create board
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NbBanner,
  NbButton,
  NbForm,
  NbModal,
  NbTextInput,
  useConfirm,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [key: string] }>()

const ws = useWorkspace()
const confirm = useConfirm()
const name = ref('')
const key = ref('')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ name?: string; key?: string }>({})
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => name.value !== '' || key.value !== '')

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = ''
      key.value = ''
      serverError.value = ''
      errors.name = undefined
      errors.key = undefined
      requestAnimationFrame(() => nameInput.value?.focus())
    }
  },
)

watch(name, (value) => {
  if (key.value === '' && value) {
    key.value = value
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .split(' ')
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 5)
  }
})

function validateName(): void {
  errors.name = name.value.trim() ? undefined : 'Give the board a name'
}

function validateKey(): void {
  key.value = key.value.toUpperCase().trim()
  errors.key = /^[A-Z][A-Z0-9]{1,4}$/.test(key.value)
    ? undefined
    : 'Use 2 to 5 uppercase letters or digits'
}

async function submit(): Promise<void> {
  validateName()
  validateKey()
  if (errors.name || errors.key) return
  saving.value = true
  serverError.value = ''
  try {
    const { results } = await api.boardWrite([
      {
        op: 'create',
        op_id: newOpId(),
        key: key.value,
        name: name.value.trim(),
        template: 'kanban6',
      },
    ])
    if (!results[0].ok) {
      serverError.value = 'That board key is already taken'
      return
    }
    await ws.refresh()
    emit('created', key.value)
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
    title: 'Discard this board',
    message: 'The name and key you typed will be lost.',
    confirmLabel: 'Discard board',
    cancelLabel: 'Keep editing',
    onConfirm: () => emit('close'),
  })
}
</script>

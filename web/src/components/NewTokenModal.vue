<template>
  <NbModal
    :open="open"
    :title="kind === 'agent' ? 'New agent token' : 'New ingest token'"
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
        :placeholder="kind === 'agent' ? 'Claude Code' : 'Contact form'"
        :error="errors.name"
        @blur="validateName"
      />
      <NbSelect
        v-if="kind === 'agent'"
        :id="`${formId}-scopes`"
        v-model="scopes"
        label="Scopes"
        multiple
        :options="scopeOptions"
      />
      <NbSelect
        v-if="kind === 'ingest'"
        :id="`${formId}-board`"
        v-model="board"
        label="Board"
        :options="boardOptions"
        :error="errors.board"
        @change="errors.board = undefined"
      />
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
        Create token
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
  NbSelect,
  NbTextInput,
} from '@nubisco/ui'
import { api } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{ open: boolean; kind: 'agent' | 'ingest' }>()
const emit = defineEmits<{ close: []; created: [token: string] }>()

const ws = useWorkspace()
const name = ref('')
const scopes = ref<string[]>(['read', 'write'])
const board = ref('')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ name?: string; board?: string }>({})
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const formId = computed(() => `new-${props.kind}-token-form`)
const isDirty = computed(() => name.value !== '')

const scopeOptions = [
  { label: 'read', value: 'read' },
  { label: 'write', value: 'write' },
  { label: 'admin', value: 'admin' },
]

const boardOptions = computed(() =>
  (ws.overview.value?.boards ?? [])
    .filter((b) => !b.archived)
    .map((b) => ({ label: b.name, value: b.key })),
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = ''
      scopes.value = ['read', 'write']
      board.value = ''
      serverError.value = ''
      errors.name = undefined
      errors.board = undefined
      requestAnimationFrame(() => nameInput.value?.focus())
    }
  },
)

function validateName(): void {
  errors.name = name.value.trim() ? undefined : 'Name the token'
}

async function submit(): Promise<void> {
  validateName()
  if (props.kind === 'ingest' && !board.value)
    errors.board = 'Pick the board new items land on'
  if (errors.name || errors.board) return
  saving.value = true
  serverError.value = ''
  try {
    const token =
      props.kind === 'agent'
        ? (await api.createAgentToken(name.value.trim(), scopes.value)).token
        : (await api.createIngestToken(name.value.trim(), board.value)).token
    await ws.refresh()
    emit('created', token)
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

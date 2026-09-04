<template>
  <NbModal
    :open="open"
    title="Add member"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="emit('close')"
  >
    <NbForm id="new-member-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-member-email"
        ref="emailInput"
        v-model="email"
        type="email"
        label="Email"
        placeholder="daniela@nubisco.io"
        :error="errors.email"
        @blur="validateEmail"
      />
      <NbTextInput
        id="field-member-name"
        v-model="name"
        label="Name"
        placeholder="Daniela Pinho"
        :error="errors.name"
        @blur="validateName"
      />
      <NbSelect
        id="field-member-role"
        v-model="role"
        label="Role"
        :options="roleOptions"
      />
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="new-member-form"
        variant="primary"
        :loading="saving"
      >
        Add member
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

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [] }>()

const ws = useWorkspace()
const email = ref('')
const name = ref('')
const role = ref<'admin' | 'member'>('member')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ email?: string; name?: string }>({})
const emailInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => email.value !== '' || name.value !== '')

const roleOptions = [
  { label: 'Member', value: 'member' },
  { label: 'Admin', value: 'admin' },
]

watch(
  () => props.open,
  (open) => {
    if (open) {
      email.value = ''
      name.value = ''
      role.value = 'member'
      serverError.value = ''
      errors.email = undefined
      errors.name = undefined
      requestAnimationFrame(() => emailInput.value?.focus())
    }
  },
)

function validateEmail(): void {
  errors.email = /.+@.+\..+/.test(email.value)
    ? undefined
    : 'Enter their email address'
}

function validateName(): void {
  errors.name = name.value.trim() ? undefined : 'Enter their name'
}

async function submit(): Promise<void> {
  validateEmail()
  validateName()
  if (errors.email || errors.name) return
  saving.value = true
  serverError.value = ''
  const handle = email.value
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
  try {
    await api.createMember({
      email: email.value.trim(),
      handle,
      name: name.value.trim(),
      role: role.value,
    })
    await ws.refresh()
    emit('created')
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

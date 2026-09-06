<template>
  <NbModal
    :open="open"
    title="New webhook"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="emit('close')"
  >
    <NbForm id="new-webhook-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-webhook-url"
        ref="urlInput"
        v-model="url"
        label="URL"
        placeholder="https://example.com/hook"
        :error="errors.url"
        @blur="validateUrl"
      />
      <NbSelect
        id="field-webhook-events"
        v-model="events"
        label="Events"
        multiple
        :options="eventOptions"
      />
      <NbField
        v-slot="{ id }"
        label="Secret"
        hint="Optional. Deliveries are HMAC-signed with it (x-acta-signature)."
      >
        <NbTextInput :id="id" v-model="secret" />
      </NbField>
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="new-webhook-form"
        variant="primary"
        :loading="saving"
      >
        Create webhook
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NbBanner,
  NbButton,
  NbField,
  NbForm,
  NbModal,
  NbSelect,
  NbTextInput,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [] }>()

const url = ref('')
const events = ref<string[]>(['item.*'])
const secret = ref('')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ url?: string }>({})
const urlInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => url.value !== '' || secret.value !== '')

const eventOptions = [
  { label: 'All events (*)', value: '*' },
  { label: 'item.*', value: 'item.*' },
  { label: 'item.created', value: 'item.created' },
  { label: 'item.moved', value: 'item.moved' },
  { label: 'comment.created', value: 'comment.created' },
  { label: 'doc.*', value: 'doc.*' },
]

watch(
  () => props.open,
  (open) => {
    if (open) {
      url.value = ''
      events.value = ['item.*']
      secret.value = ''
      serverError.value = ''
      errors.url = undefined
      requestAnimationFrame(() => urlInput.value?.focus())
    }
  },
)

function validateUrl(): void {
  try {
    const parsed = new URL(url.value)
    errors.url = parsed.protocol.startsWith('http')
      ? undefined
      : 'Use an http(s) URL'
  } catch {
    errors.url = 'Enter a full URL, like https://example.com/hook'
  }
}

async function submit(): Promise<void> {
  validateUrl()
  if (errors.url) return
  saving.value = true
  serverError.value = ''
  try {
    const { results } = await api.webhookWrite([
      {
        op: 'create',
        op_id: newOpId(),
        url: url.value,
        events: events.value.length > 0 ? events.value : ['*'],
        secret: secret.value || undefined,
      },
    ])
    if (!results[0].ok) throw new Error((results[0] as { error: string }).error)
    emit('created')
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

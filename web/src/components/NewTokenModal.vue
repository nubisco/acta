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
      <NbTextInput
        :id="`${formId}-name`"
        ref="nameInput"
        v-model="name"
        :label="kind === 'personal' ? 'Label' : 'Name'"
        :placeholder="namePlaceholder"
        :error="errors.name"
        @blur="validateName"
      />
      <!-- A personal token acts as the person who minted it, so it can never
           carry admin and the choice is only how much of their own access to
           hand over. Offering the agent scope list here would advertise a
           scope the server refuses. -->
      <NbSelect
        v-if="kind === 'personal'"
        :id="`${formId}-access`"
        v-model="personalScope"
        label="Access"
        :options="[
          { label: 'Read and write', value: 'write' },
          { label: 'Read only', value: 'read' },
        ]"
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
        :id="`${formId}-space`"
        v-model="space"
        label="Space"
        :options="spaceOptions"
        :error="errors.space"
        @change="errors.space = undefined"
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
import type { NbTextInput } from '@nubisco/ui'
import { api, auth } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{
  open: boolean
  kind: 'agent' | 'ingest' | 'personal'
}>()
const emit = defineEmits<{ close: []; created: [token: string] }>()

const ws = useWorkspace()
const name = ref('')
const scopes = ref<string[]>(['read', 'write'])
const personalScope = ref('write')
const space = ref('')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ name?: string; space?: string }>({})
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const formId = computed(() => `new-${props.kind}-token-form`)

const title = computed(
  () =>
    ({
      agent: 'New agent token',
      ingest: 'New ingest endpoint',
      personal: 'New access token',
    })[props.kind],
)

const namePlaceholder = computed(
  () =>
    ({
      agent: 'Release bot',
      ingest: 'Contact form',
      personal: 'laptop, Claude Code',
    })[props.kind],
)
const isDirty = computed(() => name.value !== '')

const scopeOptions = [
  { label: 'read', value: 'read' },
  { label: 'write', value: 'write' },
  { label: 'admin', value: 'admin' },
]

const spaceOptions = computed(() =>
  (ws.overview.value?.spaces ?? [])
    .filter((b) => !b.archived)
    .map((b) => ({ label: b.name, value: b.key })),
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = ''
      scopes.value = ['read', 'write']
      personalScope.value = 'write'
      space.value = ''
      serverError.value = ''
      errors.name = undefined
      errors.space = undefined
      requestAnimationFrame(() => nameInput.value?.focus())
    }
  },
)

function validateName(): void {
  errors.name = name.value.trim() ? undefined : 'Name the token'
}

/**
 * Read is implied by write. Asking for write alone and silently getting less
 * is the kind of thing that gets debugged at the far end, so the two are sent
 * together, matching what the server stores either way.
 */
function personalScopes(): string[] {
  return personalScope.value === 'write' ? ['read', 'write'] : ['read']
}

async function submit(): Promise<void> {
  validateName()
  if (props.kind === 'ingest' && !space.value)
    errors.space = 'Pick the space new items land on'
  if (errors.name || errors.space) return
  saving.value = true
  serverError.value = ''
  try {
    let token: string
    if (props.kind === 'agent') {
      token = (await api.createAgentToken(name.value.trim(), scopes.value))
        .token
    } else if (props.kind === 'ingest') {
      token = (await api.createIngestToken(name.value.trim(), space.value))
        .token
    } else {
      token = (await auth.createToken(name.value.trim(), personalScopes()))
        .token
    }
    // A personal token creates no actor, so nothing in the shared overview
    // changed and refreshing it would be a wasted round trip on every mint.
    if (props.kind !== 'personal') await ws.refresh()
    emit('created', token)
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

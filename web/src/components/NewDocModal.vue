<template>
  <NbModal
    :open="open"
    title="New document"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="onClose"
  >
    <NbForm id="new-doc-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-doc-title"
        ref="titleInput"
        v-model="title"
        label="Title"
        placeholder="Decision log"
        :error="errors.title"
        @blur="validateTitle"
      />
      <NbTextInput
        id="field-doc-parent"
        v-model="parentSlug"
        label="Parent"
        placeholder="Leave empty for a top-level page"
      />
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="onClose">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="new-doc-form"
        variant="primary"
        :loading="saving"
      >
        Create document
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
import { slugify } from '@nubisco/acta-shared'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'

const props = defineProps<{ open: boolean; parent?: string }>()
const emit = defineEmits<{ close: []; created: [slug: string] }>()

const confirm = useConfirm()
const title = ref('')
const parentSlug = ref('')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ title?: string }>({})
const titleInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => title.value !== '')

watch(
  () => props.open,
  (open) => {
    if (open) {
      title.value = ''
      parentSlug.value = props.parent ?? ''
      serverError.value = ''
      errors.title = undefined
      requestAnimationFrame(() => titleInput.value?.focus())
    }
  },
)

function validateTitle(): void {
  errors.title = title.value.trim() ? undefined : 'Give the page a title'
}

async function submit(): Promise<void> {
  validateTitle()
  if (errors.title) return
  saving.value = true
  serverError.value = ''
  const base = slugify(title.value)
  const parent = parentSlug.value.trim() || undefined
  const slug = parent ? `${parent}/${base}` : base
  try {
    const { results } = await api.docWrite([
      {
        op: 'create',
        op_id: newOpId(),
        slug,
        title: title.value.trim(),
        parent,
        body: '',
        layout: 'default',
        tags: [],
      },
    ])
    if (!results[0].ok) {
      serverError.value = 'A page with that name already exists there'
      return
    }
    emit('created', slug)
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
    title: 'Discard this document',
    message: 'The title you typed will be lost.',
    confirmLabel: 'Discard document',
    cancelLabel: 'Keep editing',
    onConfirm: () => emit('close'),
  })
}
</script>

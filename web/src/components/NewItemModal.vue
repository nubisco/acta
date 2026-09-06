<template>
  <NbModal
    :open="open"
    title="New item"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="onClose"
  >
    <NbForm id="new-item-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-item-title"
        ref="titleInput"
        v-model="title"
        label="Title"
        placeholder="What needs doing?"
        :error="errors.title"
        @blur="validateTitle"
      />
      <NbSelect
        id="field-item-list"
        v-model="targetList"
        label="List"
        :options="listOptions"
      />
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="onClose">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="new-item-form"
        variant="primary"
        :loading="saving"
      >
        Create item
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
  useConfirm,
} from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'

/**
 * Creating an item asks for nothing up front but a title and a list: every
 * other fact (labels, assignees, due, description) is set on the item once it
 * exists. `list` preselects the column whose footer opened the modal; the
 * shell's own Add item button leaves it on the board's backlog.
 */
const props = defineProps<{
  open: boolean
  boardKey: string
  lists: { name: string; role?: string }[]
  list?: string
}>()
const emit = defineEmits<{ close: []; created: [key: string] }>()

const confirm = useConfirm()
const title = ref('')
const targetList = ref('')
const saving = ref(false)
const serverError = ref('')
const errors = reactive<{ title?: string }>({})
const titleInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => title.value !== '')

const listOptions = computed(() =>
  props.lists.map((l) => ({ label: l.name, value: l.name })),
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      title.value = ''
      targetList.value =
        props.list ??
        (props.lists.find((l) => l.role === 'backlog') ?? props.lists[0])
          ?.name ??
        ''
      serverError.value = ''
      errors.title = undefined
      requestAnimationFrame(() => titleInput.value?.focus())
    }
  },
)

function validateTitle(): void {
  errors.title = title.value.trim() ? undefined : 'Give the item a title'
}

async function submit(): Promise<void> {
  validateTitle()
  if (errors.title) return
  saving.value = true
  serverError.value = ''
  try {
    const { results } = await api.itemWrite(
      [
        {
          op: 'create',
          op_id: newOpId(),
          list: targetList.value,
          title: title.value.trim(),
        },
      ],
      props.boardKey,
    )
    const result = results[0]
    if (!result.ok) throw new Error((result as { error: string }).error)
    emit('created', result.key ?? '')
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
    title: 'Discard this item',
    message: 'The title you typed will be lost.',
    confirmLabel: 'Discard item',
    cancelLabel: 'Keep editing',
    onConfirm: () => emit('close'),
  })
}
</script>

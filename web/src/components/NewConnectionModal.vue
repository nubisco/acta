<template>
  <NbModal
    :open="open"
    title="Connect GitHub"
    size="sm"
    :close-on-overlay="!isDirty"
    @close="emit('close')"
  >
    <NbForm id="new-connection-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbTextInput
        id="field-connection-name"
        ref="nameInput"
        v-model="name"
        label="Name"
        placeholder="GitHub"
        hint="Cards it creates are attributed to this name."
      />
      <NbSelect
        id="field-connection-board"
        v-model="board"
        label="Board"
        :options="boardOptions"
      />
      <NbSelect
        id="field-connection-list"
        v-model="list"
        label="List"
        :options="listOptions"
        placeholder="First inbox or backlog list"
      />
      <NbSelect
        v-if="labelOptions.length > 0"
        id="field-connection-labels"
        v-model="labels"
        label="Labels"
        multiple
        :options="labelOptions"
      />
      <NbTextInput
        id="field-connection-repos"
        v-model="repos"
        label="Repositories"
        placeholder="owner/repo"
        helper="Optional, comma separated. Leave empty to accept every repository this hook is added to."
      />
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="new-connection-form"
        variant="primary"
        :loading="saving"
      >
        Create connection
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { NbTextInput } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  close: []
  /** The signing secret is shown once, so the parent has to receive it. */
  created: [payload: { id: string; secret: string }]
}>()

const ws = useWorkspace()

const name = ref('GitHub')
const board = ref('')
const list = ref('')
const labels = ref<string[]>([])
const repos = ref('')
const saving = ref(false)
const serverError = ref('')
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => board.value !== '' || repos.value !== '')

const boardOptions = computed(() =>
  (ws.overview.value?.boards ?? []).map((b) => ({
    label: b.name,
    value: b.key,
  })),
)

const listOptions = computed(() => {
  const selected = ws.overview.value?.boards.find((b) => b.key === board.value)
  return (selected?.lists ?? []).map((l) => ({ label: l.name, value: l.name }))
})

// Only labels reachable from the chosen board: the server refuses the rest,
// and offering them here would just move the error later.
const labelOptions = computed(() =>
  (ws.overview.value?.labels ?? [])
    .filter((l) => l.board_key === null || l.board_key === board.value)
    .map((l) => ({ label: l.name, value: l.name })),
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = 'GitHub'
      board.value = ws.overview.value?.boards[0]?.key ?? ''
      list.value = ''
      labels.value = []
      repos.value = ''
      serverError.value = ''
      requestAnimationFrame(() => nameInput.value?.focus())
    }
  },
)

// Changing board invalidates a list and labels picked for the previous one.
watch(board, () => {
  list.value = ''
  labels.value = []
})

async function submit(): Promise<void> {
  if (!board.value) {
    serverError.value = 'Choose a board for incoming issues'
    return
  }
  saving.value = true
  serverError.value = ''
  try {
    const { results } = await api.connectionWrite([
      {
        op: 'create',
        op_id: newOpId(),
        provider: 'github',
        name: name.value.trim() || 'GitHub',
        board: board.value,
        list: list.value || undefined,
        config: {
          labels: labels.value.length > 0 ? labels.value : undefined,
          repos: repos.value
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean),
        },
      },
    ])
    const result = results[0]
    if (!result.ok) throw new Error((result as { error: string }).error)
    emit('created', result as unknown as { id: string; secret: string })
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

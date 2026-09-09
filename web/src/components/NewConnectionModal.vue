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
      >
        <template #option="{ option }">
          <LabelBadge :name="String(option.value)" />
        </template>
        <template #value="{ values }">
          <span class="label-values">
            <LabelBadge
              v-for="label in values"
              :key="String(label)"
              :name="String(label)"
            />
          </span>
        </template>
      </NbSelect>
      <NbField
        v-slot="{ id }"
        label="Repositories"
        orientation="stack"
        hint="Optional. Type a name and press Enter to add it. Leave empty to accept any repository this hook is added to, which the signing secret already vouches for."
      >
        <NbSelect
          :id="id"
          v-model="repos"
          multiple
          creatable
          :options="repoOptions"
          placeholder="Any repository"
          create-placeholder="owner/repo, then Enter"
          @create="addRepo"
        >
          <!-- Names, not "3 selected": being able to see which repositories
               are on the list is the whole point of the change. -->
          <template #value="{ values }">
            <span class="repo-values">
              <NbBadge
                v-for="repo in values"
                :key="String(repo)"
                size="sm"
                variant="grey"
              >
                {{ repo }}
              </NbBadge>
            </span>
          </template>
        </NbSelect>
      </NbField>
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
import LabelBadge from '@/components/LabelBadge.vue'

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
// Chips rather than a comma-separated string: the names are long, a
// single-line input hid everything but the tail, and one missed comma turned
// two repositories into one that matches nothing.
//
// This is a create-as-you-type list rather than a picker of your actual
// repositories, because listing those needs a GitHub token and this
// integration deliberately holds none: the webhook secret is the only
// credential involved, so there is nothing here that could touch a repo.
const repos = ref<string[]>([])
const knownRepos = ref<string[]>([])
const saving = ref(false)
const serverError = ref('')
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

const isDirty = computed(() => board.value !== '' || repos.value.length > 0)

const repoOptions = computed(() =>
  knownRepos.value.map((name) => ({ label: name, value: name })),
)

function addRepo(value: string): void {
  const name = value.trim().replace(/^https?:\/\/github\.com\//, '')
  if (!name) return
  if (!knownRepos.value.includes(name)) knownRepos.value.push(name)
  if (!repos.value.includes(name)) repos.value = [...repos.value, name]
}

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
      repos.value = []
      knownRepos.value = []
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
          repos: repos.value,
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

<style scoped lang="scss">
.repo-values {
  display: inline-flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  flex-wrap: wrap;
  min-inline-size: 0;
}
</style>

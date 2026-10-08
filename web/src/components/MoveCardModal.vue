<template>
  <NbModal
    :open="open"
    :title="`Move ${itemKey}`"
    size="sm"
    @close="emit('close')"
  >
    <NbForm id="move-card-form" class="move" @submit.prevent="submit">
      <NbBanner v-if="error" status="error" variant="inline" :title="error" />
      <NbSelect
        id="field-move-space"
        v-model="space"
        label="Space"
        :options="spaceOptions"
      />
      <NbSelect
        id="field-move-list"
        v-model="list"
        label="List"
        :options="listOptions"
      />
      <p v-if="space !== currentSpace" class="move__note">
        It becomes a {{ space }} card with a new key. {{ itemKey }} keeps
        working, so links and references to it still arrive here. Comments,
        labels, people and history go with it.
      </p>
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="move-card-form"
        variant="primary"
        :loading="saving"
        :disabled="!list"
      >
        Move card
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * Moving a card to another space, or another list of its own.
 *
 * The server could always do this (a cross-space move re-keys the card and
 * keeps the old key as an alias), but nothing in the interface offered it,
 * which is how Ivan's NU-134 ended up needing an agent to put it in Labs.
 */
import { computed, ref, watch } from 'vue'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{
  open: boolean
  itemKey: string
  /** The space and list the card is in now. */
  currentSpace: string
  currentList: string
}>()
const emit = defineEmits<{ close: []; moved: [key: string] }>()

const ws = useWorkspace()
const space = ref(props.currentSpace)
const list = ref(props.currentList)
const saving = ref(false)
const error = ref('')

const spaces = computed(() =>
  (ws.overview.value?.spaces ?? []).filter(
    (s) => !s.archived || s.key === props.currentSpace,
  ),
)

const spaceOptions = computed(() =>
  spaces.value.map((s) => ({ label: `${s.name} (${s.key})`, value: s.key })),
)

const listOptions = computed(() =>
  (spaces.value.find((s) => s.key === space.value)?.lists ?? []).map((l) => ({
    label: l.name,
    value: l.name,
  })),
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    space.value = props.currentSpace
    list.value = props.currentList
    error.value = ''
  },
)

/**
 * A different space has different lists. Keep a list of the same name when
 * there is one (most spaces share the six standard lists), and otherwise
 * land on the first, which is the backlog in every standard space.
 */
watch(space, (next, previous) => {
  if (next === previous) return
  const names = listOptions.value.map((o) => o.value)
  if (!names.includes(list.value)) list.value = names[0] ?? ''
})

async function submit(): Promise<void> {
  if (!list.value) return
  saving.value = true
  error.value = ''
  try {
    const { results } = await api.itemWrite([
      {
        op: 'move',
        op_id: newOpId(),
        key: props.itemKey,
        space: space.value === props.currentSpace ? undefined : space.value,
        list: list.value,
      },
    ])
    const result = results[0]
    if (!result.ok) {
      error.value = result.error
      return
    }
    await ws.refresh()
    emit('moved', result.key ?? props.itemKey)
  } catch (err) {
    error.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped lang="scss">
.move {
  display: grid;
  gap: var(--nb-spacing-16);

  &__note {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
  }
}
</style>

<template>
  <NbModal
    :open="open"
    title="Move page"
    size="sm"
    initial-focus="[role='combobox']"
    @close="emit('close')"
  >
    <NbForm id="move-doc-form" @submit.prevent="submit">
      <NbBanner
        v-if="serverError"
        status="error"
        variant="inline"
        :title="serverError"
      />
      <NbField v-slot="{ id }" label="New parent">
        <NbSelect :id="id" v-model="destination" :options="options">
          <template #option="{ option }">
            <span
              class="doc-move__option"
              :style="{ paddingInlineStart: indentOf(option.value) }"
            >
              {{ option.label }}
            </span>
          </template>
        </NbSelect>
      </NbField>
      <p class="doc-move__note">
        The page keeps its address, so links to it keep working. Its subpages
        move with it.
      </p>
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="move-doc-form"
        variant="primary"
        :loading="saving"
        :disabled="loading"
      >
        Move page
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * "Move page", the keyboard way to reorganise the tree.
 *
 * Dragging in the tree is pointer-only, so this offers the same move as a
 * form: pick a new parent, or the top level, and the page goes to the end of
 * that list. The page itself and everything under it are never offered, which
 * is the same rule the tree enforces while dragging.
 */
import { computed, ref, watch } from 'vue'
import { useToast } from '@nubisco/ui'
import { api, newOpId } from '@/api/client'
import { humanise } from '@/lib/state'
import {
  ancestorsOf,
  findTitle,
  moveTargets,
  nestDocs,
  planMove,
  type IMoveTarget,
} from '@/lib/docTreeMove'
import type { IDocTreeNode } from '@/types/docs'

const props = defineProps<{ open: boolean; slug: string }>()
const emit = defineEmits<{ close: []; moved: [slug: string] }>()

/** Not a slug: slugs never start with a colon. */
const TOP_LEVEL = ':top'

const toast = useToast()
const tree = ref<IDocTreeNode[]>([])
const targets = ref<IMoveTarget[]>([])
const destination = ref<string>(TOP_LEVEL)
const loading = ref(false)
const saving = ref(false)
const serverError = ref('')

const options = computed(() => [
  { label: 'Top level', value: TOP_LEVEL },
  ...targets.value.map((t) => ({ label: t.title, value: t.slug })),
])

function indentOf(value: string | number): string {
  const depth = targets.value.find((t) => t.slug === value)?.depth ?? -1
  return `calc(var(--nb-spacing-12) * ${depth + 1})`
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    serverError.value = ''
    loading.value = true
    try {
      const { docs } = await api.docTree()
      tree.value = nestDocs(docs)
      targets.value = moveTargets(tree.value, props.slug)
      destination.value =
        ancestorsOf(tree.value, props.slug).at(-1) ?? TOP_LEVEL
    } catch (err) {
      serverError.value = humanise(err)
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

async function submit(): Promise<void> {
  if (loading.value) return
  // Where it already is. Moving it to the end of its own siblings would be a
  // surprise nobody asked for.
  const current = ancestorsOf(tree.value, props.slug).at(-1) ?? TOP_LEVEL
  if (destination.value === current) {
    emit('close')
    return
  }
  const plan = planMove(
    tree.value,
    props.slug,
    destination.value === TOP_LEVEL
      ? { kind: 'root' }
      : { kind: 'inside', target: destination.value },
    newOpId(),
  )
  if (!plan) {
    emit('close')
    return
  }
  saving.value = true
  serverError.value = ''
  try {
    const { results } = await api.docWrite([plan.op])
    if (!results[0]?.ok) {
      serverError.value = String(results[0]?.error ?? 'The move was refused')
      return
    }
    const where =
      destination.value === TOP_LEVEL
        ? 'the top level'
        : `"${findTitle(tree.value, destination.value)}"`
    toast.success(`Moved "${findTitle(tree.value, props.slug)}" to ${where}`)
    emit('moved', props.slug)
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped lang="scss">
.doc-move__note {
  margin: 0;
  font-size: var(--nb-type-body-sm-size);
  color: var(--nb-c-text-muted);
}
</style>

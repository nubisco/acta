<template>
  <div class="docs">
    <component :is="topbarActions.Outlet">
      <template v-if="doc && !editing">
        <NbButton
          size="sm"
          variant="secondary"
          :aria-expanded="showHistory"
          @click="showHistory = !showHistory"
        >
          Version history (v{{ doc.rev }})
        </NbButton>
        <NbButton size="sm" variant="primary" @click="startEdit">Edit</NbButton>
      </template>
      <template v-else-if="doc && editing">
        <NbButton size="sm" variant="secondary" @click="cancelEdit">
          Cancel
        </NbButton>
        <NbButton size="sm" variant="primary" :loading="saving" @click="save">
          Save changes
        </NbButton>
      </template>
    </component>

    <div v-if="!slug" class="docs__placeholder">
      <NbEmptyState
        title="Select a document"
        description="Pick a page from the Documents panel, or create a new one."
      />
    </div>

    <div v-else-if="load.state.value === 'loading'" class="docs__loading">
      <NbSkeleton variant="heading" label="Loading document" />
      <NbSkeleton variant="text" :lines="8" />
    </div>

    <NbEmptyState
      v-else-if="load.state.value === 'forbidden'"
      kind="forbidden"
      title="You do not have access to this page"
      description="Ask a workspace admin if you think you should."
    />

    <NbEmptyState
      v-else-if="load.state.value === 'error' || !doc"
      kind="error"
      title="Could not load this page"
      :description="load.message.value"
    >
      <template #actions>
        <NbButton variant="secondary" @click="loadDoc">Retry</NbButton>
      </template>
    </NbEmptyState>

    <article v-else class="docs__doc">
      <h1>{{ doc.title }}</h1>

      <NbBanner
        v-if="conflict"
        status="error"
        variant="inline"
        title="This page changed while you were editing"
      >
        Your draft is kept below. Reload to see the newer version, then merge by
        hand.
        <template #action>
          <NbButton size="sm" variant="secondary" @click="reloadKeepDraft">
            Reload page
          </NbButton>
        </template>
      </NbBanner>

      <div v-if="showHistory && doc.versions" class="docs__history">
        <NbDataTable
          :columns="versionColumns"
          :rows="versionRows"
          row-key="rev"
          size="sm"
          aria-label="Version history"
          @row-click="viewVersion"
        />
        <NbButton
          v-if="viewedVersion !== doc.rev"
          size="sm"
          variant="primary"
          @click="restoreVersion"
        >
          Restore v{{ viewedVersion }}
        </NbButton>
      </div>

      <div v-if="editing" class="docs__editor">
        <NbForm id="doc-editor" aria-label="Edit document">
          <NbField orientation="stack" label="Markdown" v-slot="{ id }">
            <NbTextInput
              :id="id"
              v-model="draft"
              multiline
              :rows="24"
              size="sm"
            />
          </NbField>
        </NbForm>
        <MarkdownView
          class="docs__preview"
          :source="draft"
          :wide="doc.layout === 'wide'"
        />
      </div>
      <MarkdownView v-else :source="viewedBody" :wide="doc.layout === 'wide'" />

      <footer
        v-if="doc.backlinks && doc.backlinks.length > 0"
        class="docs__backlinks"
      >
        <h2>Referenced by</h2>
        <NbDefinitionList :items="backlinkFacts" layout="columns" />
      </footer>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import {
  NbBanner,
  NbButton,
  NbDataTable,
  NbDefinitionList,
  NbEmptyState,
  NbField,
  NbForm,
  NbSkeleton,
  NbTextInput,
  useConfirm,
  useShellSlot,
  useToast,
} from '@nubisco/ui'
import { api, newOpId, ApiHttpError } from '@/api/client'
import type { IDocDetail } from '@/types/api'
import { humanise, relativeTime, useLoadState } from '@/lib/state'
import MarkdownView from '@/components/MarkdownView.vue'

const props = defineProps<{ slug?: string }>()

const toast = useToast()
const confirm = useConfirm()
const load = useLoadState()
const topbarActions = useShellSlot('topbar-right')

const doc = ref<IDocDetail | null>(null)
const editing = ref(false)
const showHistory = ref(false)
const saving = ref(false)
const conflict = ref(false)
const draft = ref('')
const viewedVersion = ref(0)
const viewedBody = ref('')

const slug = computed(() => props.slug || undefined)
const isDirty = computed(
  () => editing.value && doc.value !== null && draft.value !== doc.value.body,
)

const versionColumns = [
  { key: 'version', header: 'Version' },
  { key: 'by', header: 'By' },
  { key: 'when', header: 'When' },
]

const versionRows = computed(() =>
  (doc.value?.versions ?? []).map((v) => ({
    rev: v.rev,
    version: `v${v.rev}`,
    by: `@${v.handle}`,
    when: relativeTime(v.created_at),
  })),
)

const backlinkFacts = computed(() =>
  (doc.value?.backlinks ?? []).map((link) => ({
    term: link.src_kind,
    value: link.src_id,
  })),
)

async function loadDoc(): Promise<void> {
  if (!slug.value) {
    doc.value = null
    return
  }
  try {
    load.state.value = 'loading'
    doc.value = await api.docGet(slug.value, ['backlinks', 'versions'])
    viewedVersion.value = doc.value.rev
    viewedBody.value = doc.value.body
    editing.value = false
    showHistory.value = false
    conflict.value = false
    load.state.value = 'ready'
  } catch (err) {
    doc.value = null
    load.state.value =
      err instanceof ApiHttpError && err.status === 403 ? 'forbidden' : 'error'
    load.message.value = humanise(err)
  }
}

watch(slug, loadDoc, { immediate: true })

function startEdit(): void {
  draft.value = doc.value?.body ?? ''
  editing.value = true
  conflict.value = false
}

function cancelEdit(): void {
  if (!isDirty.value) {
    editing.value = false
    return
  }
  void confirm({
    title: 'Discard changes',
    message: 'Your edits to this page will be lost.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    onConfirm: () => {
      editing.value = false
    },
  })
}

onBeforeRouteLeave(async () => {
  if (!isDirty.value) return true
  let leave = false
  await confirm({
    title: 'Discard changes',
    message: 'Your edits to this page will be lost.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    onConfirm: () => {
      leave = true
    },
  })
  return leave
})

async function save(): Promise<void> {
  if (!doc.value) return
  saving.value = true
  try {
    const { results } = await api.docWrite([
      {
        op: 'replace',
        op_id: newOpId(),
        ref: doc.value.slug,
        if_rev: doc.value.rev,
        body: draft.value,
      },
    ])
    if (!results[0].ok) {
      conflict.value = true
      return
    }
    await loadDoc()
  } catch {
    conflict.value = true
  } finally {
    saving.value = false
  }
}

async function reloadKeepDraft(): Promise<void> {
  const kept = draft.value
  await loadDoc()
  draft.value = kept
  editing.value = true
}

async function viewVersion(row: { rev: number }): Promise<void> {
  if (!doc.value) return
  const old = await api.docGet(doc.value.slug, undefined, row.rev)
  viewedVersion.value = row.rev
  viewedBody.value = old.body
}

async function restoreVersion(): Promise<void> {
  if (!doc.value) return
  try {
    const { results } = await api.docWrite([
      {
        op: 'replace',
        op_id: newOpId(),
        ref: doc.value.slug,
        if_rev: doc.value.rev,
        body: viewedBody.value,
      },
    ])
    if (!results[0].ok) throw new Error('conflict')
    toast.success(`Restored v${viewedVersion.value} as v${doc.value.rev + 1}`)
    await loadDoc()
  } catch (err) {
    toast.error(humanise(err), { title: 'Restore failed' })
  }
}
</script>

<style scoped lang="scss">
.docs {
  display: grid;
  gap: var(--nb-spacing-16);
  align-content: start;

  &__placeholder {
    min-height: 24rem;
    padding-block: var(--nb-spacing-24);
  }

  &__loading {
    display: grid;
    gap: var(--nb-spacing-12);
  }

  &__doc {
    display: grid;
    gap: var(--nb-spacing-16);

    h1 {
      margin: 0;
    }
  }

  &__history {
    display: grid;
    gap: var(--nb-spacing-8);
    justify-items: start;
  }

  &__editor {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: var(--nb-spacing-16);
    align-items: start;
  }

  &__backlinks {
    border-block-start: 1px solid var(--nb-c-border);
    padding-block-start: var(--nb-spacing-16);

    h2 {
      margin: 0 0 var(--nb-spacing-8);
      font-size: var(--nb-type-heading-01-size);
    }
  }
}
</style>

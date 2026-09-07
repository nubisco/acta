<template>
  <NbModal
    :open="slug !== null"
    size="lg"
    :title="doc?.title ?? slug ?? 'Document'"
    @close="preview.close()"
  >
    <div v-if="state === 'loading'" class="doc-preview__loading">
      <NbSkeleton variant="heading" label="Loading document" />
      <NbSkeleton variant="text" :lines="8" />
    </div>

    <NbEmptyState
      v-else-if="state === 'error'"
      kind="error"
      title="Could not load this document"
      :description="message"
    >
      <template #actions>
        <NbButton size="sm" variant="secondary" @click="load">Retry</NbButton>
      </template>
    </NbEmptyState>

    <div v-else-if="doc" class="doc-preview">
      <ProvenanceNote v-if="doc.imported" :imported="doc.imported" />
      <MarkdownView :source="doc.body" />
    </div>

    <template #footer>
      <NbButton size="sm" variant="secondary" @click="preview.close()">
        Close
      </NbButton>
      <NbButton size="sm" variant="primary" @click="openInDocs">
        Open in Docs
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
// The quick look Confluence gives smart links: a card mentions a page, the
// reader peeks without losing the board. The doc still lives in its space;
// "Open in Docs" is the door there.
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NbButton, NbEmptyState, NbModal, NbSkeleton } from '@nubisco/ui'
import { api } from '@/api/client'
import type { IDocDetail } from '@/types/api'
import { humanise } from '@/lib/state'
import { useDocPreview } from '@/stores/workspace'
import MarkdownView from '@/components/MarkdownView.vue'
import ProvenanceNote from '@/components/ProvenanceNote.vue'

const preview = useDocPreview()
const { slug } = preview
const router = useRouter()

const doc = ref<IDocDetail | null>(null)
const state = ref<'loading' | 'error' | 'ready'>('ready')
const message = ref('')

async function load(): Promise<void> {
  if (!slug.value) return
  state.value = 'loading'
  try {
    doc.value = (await api.docGet(slug.value)) as IDocDetail
    state.value = 'ready'
  } catch (err) {
    message.value = humanise(err)
    state.value = 'error'
  }
}

watch(slug, (next) => {
  doc.value = null
  if (next) void load()
})

function openInDocs(): void {
  const target = slug.value
  preview.close()
  if (target) void router.push(`/docs/${target}`)
}
</script>

<style scoped lang="scss">
.doc-preview {
  display: grid;
  gap: var(--nb-spacing-12);
}

.doc-preview__loading {
  display: grid;
  gap: var(--nb-spacing-12);
}
</style>

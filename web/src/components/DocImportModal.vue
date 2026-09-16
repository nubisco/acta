<template>
  <NbModal
    :open="open"
    title="Import pages"
    size="md"
    :busy="running"
    :close-disabled="running"
    :close-on-overlay="!running && files.length === 0"
    :close-on-escape="!running"
    @close="onClose"
  >
    <NbForm id="doc-import-form" class="doc-import" @submit.prevent="start">
      <NbBanner
        v-if="error"
        status="error"
        variant="inline"
        title="The import stopped"
      >
        {{ error }}
      </NbBanner>

      <template v-if="result">
        <NbBanner
          status="success"
          variant="inline"
          :title="`Imported ${result.pages.length} ${result.pages.length === 1 ? 'page' : 'pages'}`"
        />
        <NbBanner
          v-if="result.issues.length > 0"
          status="warning"
          variant="inline"
          title="Some content did not map cleanly"
        >
          <ul class="doc-import__issues">
            <li v-for="issue in result.issues" :key="issue">{{ issue }}</li>
          </ul>
        </NbBanner>
      </template>

      <template v-else>
        <NbRadio
          v-model="destination"
          name="doc-import-destination"
          label="Where the pages go"
          :options="destinations"
          :disabled="running"
        />

        <NbFileUploader
          :key="uploaderKey"
          heading="Files to import"
          description="Markdown, HTML and Word files, or a zip. Pictures a page refers to can come along in the same selection."
          :accept="ACCEPT"
          multiple
          :disabled="running"
          @change="picked = $event"
        />

        <div class="doc-import__folder">
          <NbButton
            type="button"
            variant="secondary"
            size="sm"
            icon="folder-open"
            :disabled="running"
            @click="folderInput?.click()"
          >
            Choose a folder
          </NbButton>
          <span v-if="folderFiles.length > 0" class="doc-import__hint">
            {{ folderName }}: {{ folderFiles.length }}
            {{ folderFiles.length === 1 ? 'file' : 'files' }}
          </span>
          <!-- The uploader takes files, not folders. A folder keeps its
               structure only through the browser's directory picker. -->
          <input
            ref="folderInput"
            class="doc-import__native"
            type="file"
            webkitdirectory
            multiple
            tabindex="-1"
            aria-hidden="true"
            @change="onFolder"
          />
        </div>

        <NbCheckbox
          v-model="split"
          label="Split HTML and Word documents into a page per heading"
          :disabled="running"
        />
        <NbSelect
          v-if="split"
          v-model="splitLevel"
          label="Start a new page at"
          :options="levels"
          :disabled="running"
        />

        <NbProgressBar
          v-if="running"
          :value="progress.done"
          :max="Math.max(progress.total, 1)"
          :label="
            progress.label ? `Importing ${progress.label}` : 'Reading files'
          "
        />
      </template>
    </NbForm>

    <template #footer>
      <template v-if="result">
        <NbButton type="button" variant="secondary" @click="reset">
          Import more
        </NbButton>
        <NbButton type="button" variant="primary" @click="finish">
          Open imported pages
        </NbButton>
      </template>
      <template v-else>
        <NbButton
          type="button"
          variant="secondary"
          :disabled="running"
          @click="onClose"
        >
          Cancel
        </NbButton>
        <NbButton
          type="submit"
          form="doc-import-form"
          variant="primary"
          :disabled="files.length === 0"
          :loading="running"
        >
          Import
        </NbButton>
      </template>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * Import files as pages, under the page it was opened from or at the top.
 *
 * Conversion runs here in the browser: see lib/transfer/sources.ts for why.
 */
import { computed, ref, watch } from 'vue'
import { humanise } from '@/lib/state'
import type { IImportProgress, IImportResult } from '@/lib/transfer/importer'

const props = defineProps<{
  open: boolean
  parent?: { slug: string; title: string }
}>()
const emit = defineEmits<{ close: []; imported: [slug: string] }>()

const ACCEPT = '.md,.markdown,.txt,.html,.htm,.docx,.zip,image/*,.pdf'

const destination = ref<'parent' | 'top'>('parent')
const picked = ref<File[]>([])
const folderFiles = ref<File[]>([])
const folderInput = ref<HTMLInputElement | null>(null)
const split = ref(false)
const splitLevel = ref<number>(2)
const running = ref(false)
const error = ref('')
const result = ref<IImportResult | null>(null)
const uploaderKey = ref(0)
const progress = ref<IImportProgress>({ done: 0, total: 0, label: '' })

const files = computed(() => [...picked.value, ...folderFiles.value])
const folderName = computed(
  () =>
    (
      folderFiles.value[0] as
        (File & { webkitRelativePath?: string }) | undefined
    )?.webkitRelativePath?.split('/')[0] ?? 'Folder',
)

const destinations = computed(() => [
  ...(props.parent
    ? [{ label: `Under "${props.parent.title}"`, value: 'parent' }]
    : []),
  { label: 'At the top level', value: 'top' },
])

const levels = [
  { label: 'Heading 1', value: 1 },
  { label: 'Heading 1 and 2', value: 2 },
  { label: 'Heading 1 to 3', value: 3 },
  { label: 'Heading 1 to 4', value: 4 },
]

function reset(): void {
  picked.value = []
  folderFiles.value = []
  if (folderInput.value) folderInput.value.value = ''
  error.value = ''
  result.value = null
  progress.value = { done: 0, total: 0, label: '' }
  uploaderKey.value++
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    reset()
    destination.value = props.parent ? 'parent' : 'top'
  },
)

function onFolder(event: Event): void {
  folderFiles.value = Array.from((event.target as HTMLInputElement).files ?? [])
}

async function start(): Promise<void> {
  if (files.value.length === 0 || running.value) return
  running.value = true
  error.value = ''
  try {
    const [{ readInputs, prepareImport }, importer, { api }] =
      await Promise.all([
        import('@/lib/transfer/sources'),
        import('@/lib/transfer/importer'),
        import('@/api/client'),
      ])
    const entries = await readInputs(files.value)
    const prepared = await prepareImport(entries, {
      splitLevel: split.value ? Number(splitLevel.value) : undefined,
    })
    result.value = await importer.runImport(
      prepared,
      {
        parent: destination.value === 'parent' ? props.parent?.slug : undefined,
      },
      {
        docTree: () => api.docTree(),
        docWrite: (ops) => api.docWrite(ops),
        attachmentUpload: (owner, file) => api.attachmentUpload(owner, file),
        fetchRemote: importer.fetchRemoteInBrowser,
        attachmentFetchRemote: (owner, url) =>
          api.attachmentFetchRemote(owner, url),
      },
      (next) => (progress.value = next),
    )
    if (result.value.pages.length === 0) {
      error.value = result.value.issues.at(-1) ?? 'Nothing was imported.'
      result.value = null
    }
  } catch (err) {
    error.value = humanise(err)
  } finally {
    running.value = false
  }
}

function finish(): void {
  const first = result.value?.pages[0]
  if (first) emit('imported', first.slug)
  else emit('close')
}

function onClose(): void {
  if (running.value) return
  if (result.value?.pages[0]) {
    finish()
    return
  }
  emit('close')
}
</script>

<style scoped lang="scss">
.doc-import {
  display: grid;
  gap: var(--nb-spacing-16);

  &__folder {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__hint {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__native {
    display: none;
  }

  &__issues {
    margin: 0;
    padding-inline-start: var(--nb-spacing-16);
  }
}
</style>

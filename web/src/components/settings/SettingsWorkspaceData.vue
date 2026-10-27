<template>
  <div class="workspace-data">
    <NbDataTable
      stack-on-phone
      :columns="exportColumns"
      :rows="exportRows"
      row-key="id"
      size="sm"
      title="Export everything"
      :description="exportDescription"
    >
      <template #toolbar-actions>
        <NbButton
          variant="secondary"
          :loading="requesting"
          :disabled="inProgress"
          @click="requestExport"
        >
          {{ inProgress ? 'Export in progress' : 'Export everything' }}
        </NbButton>
      </template>
      <template #cell-action="{ row }">
        <NbButton
          v-if="row.downloadUrl"
          variant="ghost"
          size="sm"
          :href="row.downloadUrl"
          download
        >
          Download
        </NbButton>
      </template>
      <template #empty>
        <NbEmptyState
          size="sm"
          title="No exports yet"
          description="Export the workspace and the download is listed here."
        />
      </template>
    </NbDataTable>

    <NbPanel class="workspace-data__section">
      <header class="workspace-data__head">
        <div>
          <h2 class="type-heading-01">Delete this workspace</h2>
          <p v-if="!deletion" class="workspace-data__lede">
            Everything in it goes: spaces, cards, pages, goals, files and
            members. It becomes read-only at once and is removed for good
            {{ GRACE_DAYS }} days later, so there is time to export it or change
            your mind.
          </p>
          <p v-else class="workspace-data__lede">
            This workspace will be deleted on
            <strong>{{ formatDate(deletion.purge_at) }}</strong
            >. Until then it is read-only. Cancelling brings it back exactly as
            it was.
          </p>
        </div>
        <NbButton v-if="!deletion" variant="danger" @click="confirmOpen = true">
          Delete workspace
        </NbButton>
        <NbButton
          v-else
          variant="secondary"
          :loading="cancelling"
          @click="cancelDeletion"
        >
          Cancel deletion
        </NbButton>
      </header>
    </NbPanel>

    <NbModal
      close-appearance="button"
      :open="confirmOpen"
      title="Delete this workspace"
      size="sm"
      @close="closeConfirm"
    >
      <NbForm id="delete-workspace-form" @submit.prevent="scheduleDeletion">
        <NbBanner
          v-if="serverError"
          status="error"
          variant="inline"
          :title="serverError"
        />
        <p class="workspace-data__lede">
          Type <strong>{{ slug }}</strong> to confirm. The workspace is
          read-only from now and removed for good in {{ GRACE_DAYS }} days.
        </p>
        <NbTextInput
          id="field-delete-confirm"
          v-model="typed"
          label="Workspace address"
          :placeholder="slug"
          autocomplete="off"
        />
      </NbForm>
      <template #footer>
        <NbButton type="button" variant="secondary" @click="closeConfirm">
          Keep it
        </NbButton>
        <NbButton
          type="submit"
          form="delete-workspace-form"
          variant="danger"
          :disabled="typed.trim() !== slug"
          :loading="deleting"
        >
          Delete workspace
        </NbButton>
      </template>
    </NbModal>
  </div>
</template>

<script setup lang="ts">
/**
 * The workspace's data, as a whole (LA-401): take a copy of it, or delete it.
 * Admin only, like the rest of the Workspace tab.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import {
  api,
  getWorkspaceSlug,
  type IWorkspaceDeletion,
  type IWorkspaceExport,
} from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import { humanise } from '@/lib/state'

const LINK_DAYS = 7
const GRACE_DAYS = 30

// The export table's description, which names how long a download link lasts.
const exportDescription = `One zip with every space, card, page, goal and uploaded file in this workspace, as JSON Lines and Markdown, so it can be read without Acta. Private pages are included only if they are yours. It takes a minute or two, and the download link is emailed to you and listed here for ${LINK_DAYS} days.`

const ws = useWorkspace()
const toast = useToast()

const exports = ref<IWorkspaceExport[]>([])
const deletion = ref<IWorkspaceDeletion | null>(null)
const requesting = ref(false)
const cancelling = ref(false)
const deleting = ref(false)
const confirmOpen = ref(false)
const typed = ref('')
const serverError = ref('')
const slug = computed(() => getWorkspaceSlug())

const inProgress = computed(() =>
  exports.value.some((e) => e.status === 'pending' || e.status === 'running'),
)

const exportColumns = [
  { key: 'created', header: 'Asked for' },
  { key: 'status', header: 'Status' },
  { key: 'size', header: 'Size' },
  { key: 'action', header: '' },
]

const STATUS: Record<IWorkspaceExport['status'], string> = {
  pending: 'Waiting',
  running: 'Being made',
  ready: 'Ready',
  failed: 'Failed',
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const exportRows = computed(() =>
  exports.value.map((e) => {
    const usable = e.status === 'ready' && (e.expires_at ?? 0) > Date.now()
    return {
      id: e.id,
      created: new Date(e.created_at).toLocaleString(),
      status:
        e.status === 'ready' && !usable
          ? 'Expired'
          : e.status === 'ready' && e.skipped_files > 0
            ? `Ready, ${e.skipped_files} files too large to include`
            : e.status === 'failed'
              ? `Failed: ${e.error ?? 'unknown error'}`
              : STATUS[e.status],
      size: formatSize(e.size),
      downloadUrl: usable ? api.exportDownloadUrl(e.id) : null,
    }
  }),
)

async function load(): Promise<void> {
  try {
    const [list, status] = await Promise.all([api.exports(), api.deletion()])
    exports.value = list.exports
    deletion.value = status.deletion
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not load' })
  }
}

/**
 * While an export is being made the list is polled, so the Download button
 * appears without a reload. Stopped once nothing is in progress.
 */
let poll: ReturnType<typeof setInterval> | null = null
function watchProgress(): void {
  if (poll) return
  poll = setInterval(async () => {
    try {
      exports.value = (await api.exports()).exports
    } catch {
      // The next tick tries again.
    }
    if (!inProgress.value && poll) {
      clearInterval(poll)
      poll = null
    }
  }, 5000)
}

async function requestExport(): Promise<void> {
  requesting.value = true
  try {
    await api.requestExport()
    exports.value = (await api.exports()).exports
    toast.success('The export is being made. We will email you the link.')
    watchProgress()
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not start the export' })
  } finally {
    requesting.value = false
  }
}

function closeConfirm(): void {
  confirmOpen.value = false
  typed.value = ''
  serverError.value = ''
}

async function scheduleDeletion(): Promise<void> {
  if (typed.value.trim() !== slug.value) return
  deleting.value = true
  serverError.value = ''
  try {
    deletion.value = (await api.scheduleDeletion(typed.value.trim())).deletion
    closeConfirm()
    await ws.refresh()
  } catch (err) {
    serverError.value = humanise(err)
  } finally {
    deleting.value = false
  }
}

async function cancelDeletion(): Promise<void> {
  cancelling.value = true
  try {
    await api.cancelDeletion()
    deletion.value = null
    await ws.refresh()
    toast.success('The workspace is no longer going to be deleted')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not cancel' })
  } finally {
    cancelling.value = false
  }
}

onMounted(async () => {
  await load()
  if (inProgress.value) watchProgress()
})

onUnmounted(() => {
  if (poll) clearInterval(poll)
})
</script>

<style scoped lang="scss">
.workspace-data {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);

  &__section {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
  }

  &__head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--nb-spacing-16);
  }

  &__lede {
    max-width: 68ch;
    margin-block-start: var(--nb-spacing-4);
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }
}

/* A phone: the action goes under the heading and its description, the same
   as the rest of the Workspace tab. */
@include variables.phone {
  .workspace-data__head {
    flex-wrap: wrap;
  }
}
</style>

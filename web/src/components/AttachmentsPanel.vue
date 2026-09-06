<template>
  <div class="attachments">
    <ul v-if="attachments.length > 0" class="attachments__list">
      <li v-for="att in attachments" :key="att.id" class="attachments__row">
        <NbIcon
          :name="att.kind === 'url' ? 'link-simple' : 'file'"
          :size="15"
          class="attachments__icon"
        />
        <a
          class="attachments__name"
          :href="att.kind === 'url' && att.url ? att.url : attachmentHref(att.id)"
          target="_blank"
          rel="noopener"
        >
          {{ att.filename }}
        </a>
        <span v-if="att.size" class="attachments__size">
          {{ formatBytes(att.size) }}
        </span>
        <NbButton
          size="xxs"
          variant="ghost"
          icon="trash-simple"
          :aria-label="`Remove ${att.filename}`"
          @click="remove(att)"
        />
      </li>
    </ul>

    <NbFileUploader
      ref="uploader"
      button-label="Add files"
      description="Up to 25 MB per file"
      multiple
      :max-size="25 * 1024 * 1024"
      @change="onFiles"
    />

    <form class="attachments__link" @submit.prevent="addLink">
      <NbTextInput
        :id="`field-attach-link-${uid}`"
        v-model="linkDraft"
        size="sm"
        placeholder="Or paste a link to attach..."
        aria-label="Link to attach"
      />
      <NbButton
        type="submit"
        size="sm"
        variant="secondary"
        :disabled="!linkDraft.trim()"
      >
        Attach link
      </NbButton>
    </form>
  </div>
</template>

<script setup lang="ts">
/**
 * Attachment list + upload surface for one item or doc. Owns its API calls
 * (the owner ref comes in as a prop) and asks the parent to reload via
 * `changed` after every mutation.
 */
import { ref, useId } from 'vue'
import {
  NbButton,
  NbFileUploader,
  NbIcon,
  NbTextInput,
  useConfirm,
  useToast,
} from '@nubisco/ui'
import { api, attachmentHref } from '@/api/client'
import { humanise } from '@/lib/state'

interface IAttachmentView {
  id: string
  kind: string
  filename: string
  url: string | null
  size: number | null
}

const props = defineProps<{
  owner: { item?: string; doc?: string }
  attachments: IAttachmentView[]
}>()

const emit = defineEmits<{ changed: [] }>()

const toast = useToast()
const confirm = useConfirm()
const uid = useId()
const uploader = ref<InstanceType<typeof NbFileUploader> | null>(null)
const linkDraft = ref('')

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function onFiles(files: File[]): Promise<void> {
  for (const [index, file] of files.entries()) {
    uploader.value?.setFileStatus(index, 'loading')
    try {
      await api.attachmentUpload(props.owner, file)
      uploader.value?.setFileStatus(index, 'success')
    } catch (err) {
      uploader.value?.setFileStatus(index, 'idle', humanise(err))
      toast.error(humanise(err), { title: `Could not upload ${file.name}` })
    }
  }
  // Uploaded files reappear in the list above; the picker resets.
  if (uploader.value) uploader.value.files = []
  emit('changed')
}

async function addLink(): Promise<void> {
  const url = linkDraft.value.trim()
  if (!url) return
  try {
    await api.attachmentAddUrl(props.owner, url)
    linkDraft.value = ''
    emit('changed')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not attach the link' })
  }
}

function remove(att: IAttachmentView): void {
  void confirm({
    title: 'Remove attachment',
    message: 'The file is deleted from storage as well.',
    subject: att.filename,
    confirmLabel: 'Remove attachment',
    cancelLabel: 'Keep it',
    onConfirm: async () => {
      try {
        await api.attachmentDelete(att.id)
        emit('changed')
      } catch (err) {
        toast.error(humanise(err), { title: 'Could not remove it' })
      }
    },
  })
}
</script>

<style scoped lang="scss">
.attachments {
  display: grid;
  gap: var(--nb-spacing-12);

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-4);
  }

  &__row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    font-size: var(--nb-type-body-sm-size);
  }

  &__icon {
    color: var(--nb-c-text-subtle);
    flex: none;
  }

  &__name {
    color: var(--nb-c-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  &__size {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-label-sm-size);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  &__link {
    display: flex;
    gap: var(--nb-spacing-8);

    > :first-child {
      flex: 1;
    }
  }
}
</style>

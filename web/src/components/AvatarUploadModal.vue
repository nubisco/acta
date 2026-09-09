<template>
  <NbModal
    :open="open"
    title="Change picture"
    size="sm"
    :close-on-overlay="!file"
    @close="emit('close')"
  >
    <NbForm id="avatar-form" @submit.prevent="save">
      <NbBanner v-if="error" status="error" variant="inline" :title="error" />

      <NbFileUploader
        v-if="!file"
        accept="image/*"
        :max-size="MAX_BYTES"
        @change="onPick"
      />

      <NbImageCropper
        v-else
        :image="file"
        crop-as-circle
        output-as-circle
        lock-aspect-ratio
        show-preview
        @crop="onCrop"
      />

      <p v-if="file" class="avatar-upload__hint">
        Drag to reposition, then save. Pictures are cropped to a circle, because
        that is how they appear everywhere in Acta.
      </p>
    </NbForm>

    <template #footer>
      <NbButton
        v-if="canRemove"
        variant="danger"
        outlined
        :loading="removing"
        @click="remove"
      >
        Remove picture
      </NbButton>
      <NbButton type="button" variant="secondary" @click="emit('close')">
        Cancel
      </NbButton>
      <NbButton
        type="submit"
        form="avatar-form"
        variant="primary"
        :disabled="!cropped"
        :loading="saving"
      >
        Save picture
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * Uploading a picture, in Acta itself.
 *
 * Deliberately not a hosted-only feature: anything only the hosted product can
 * do is something a self-hosted workspace can never do, which would leave the
 * initials fallback as the ceiling rather than a graceful default. An identity
 * provider can still seed an avatar, but it writes the same field through the
 * same public endpoint.
 *
 * Cropping happens in the browser, so the server stores exactly what was
 * approved and never has to resize or guess a focal point.
 */
import { computed, ref, watch } from 'vue'
import { api } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

const MAX_BYTES = 2 * 1024 * 1024

const props = defineProps<{
  open: boolean
  actorId: string
  hasAvatar: boolean
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const ws = useWorkspace()

const file = ref<File | null>(null)
const cropped = ref<Blob | null>(null)
const saving = ref(false)
const removing = ref(false)
const error = ref('')

const canRemove = computed(() => props.hasAvatar && !file.value)

watch(
  () => props.open,
  (open) => {
    if (open) {
      file.value = null
      cropped.value = null
      error.value = ''
    }
  },
)

function onPick(payload: unknown): void {
  const files = payload as File[] | FileList | { files?: File[] } | null
  const first = Array.isArray(files)
    ? files[0]
    : files instanceof FileList
      ? files[0]
      : files?.files?.[0]
  if (first) file.value = first
}

function onCrop(payload: { blob: Blob }): void {
  cropped.value = payload.blob
}

async function save(): Promise<void> {
  if (!cropped.value) return
  saving.value = true
  error.value = ''
  try {
    await api.uploadAvatar(props.actorId, cropped.value)
    await ws.refresh()
    emit('saved')
  } catch (err) {
    error.value = humanise(err)
  } finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  removing.value = true
  error.value = ''
  try {
    await api.removeAvatar(props.actorId)
    await ws.refresh()
    emit('saved')
  } catch (err) {
    error.value = humanise(err)
  } finally {
    removing.value = false
  }
}
</script>

<style scoped lang="scss">
.avatar-upload {
  &__hint {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
  }
}
</style>

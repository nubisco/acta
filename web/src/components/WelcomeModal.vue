<template>
  <NbModal
    :open="open"
    :title="`Welcome to Acta, ${firstName}`"
    size="md"
    :close-on-overlay="false"
    @close="finish('dismiss')"
  >
    <div class="welcome">
      <p class="welcome__lede">
        Two things worth setting now. Both can be changed later in Settings.
      </p>

      <NbBanner v-if="error" status="error" variant="inline" :title="error" />

      <section class="welcome__group">
        <h3 class="welcome__title">Appearance</h3>
        <NbRadio
          name="welcome-theme"
          direction="horizontal"
          :options="themeOptions"
          :model-value="theme.theme.value"
          @update:model-value="theme.setTheme($event as TTheme)"
        />
        <p class="welcome__hint">
          Applied as you choose it, so you can see it before you commit.
        </p>
      </section>

      <section class="welcome__group">
        <h3 class="welcome__title">Your picture</h3>
        <div class="welcome__avatar">
          <ActorAvatar :handle="handle" :size="56" />
          <div class="welcome__avatar-copy">
            <p class="welcome__hint">
              Your initials work fine. A picture makes you easier to pick out on
              a busy space.
            </p>
            <NbFileUploader
              v-if="!file"
              accept="image/*"
              :max-size="MAX_BYTES"
              @change="onPick"
            />
          </div>
        </div>

        <NbImageCropper
          v-if="file"
          :image="file"
          crop-as-circle
          output-as-circle
          lock-aspect-ratio
          show-preview
          @crop="onCrop"
        />
      </section>
    </div>

    <template #footer>
      <NbButton type="button" variant="ghost" @click="finish('dismiss')">
        Skip for now
      </NbButton>
      <!-- The tour is the point of the welcome, so it is the primary action.
           Someone who wants neither still leaves through "Skip for now", and
           either way we record that they were asked. -->
      <NbButton
        type="button"
        variant="primary"
        :loading="saving"
        @click="finish('tour')"
      >
        {{ file ? 'Save and show me around' : 'Show me around' }}
      </NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * The first thing a new person sees, once.
 *
 * Kept to what genuinely cannot wait: how the app looks, and who they are on
 * a space. Everything else a workspace needs is discoverable, and a welcome
 * that collects settings nobody has an opinion on yet is a form standing
 * between someone and the product.
 *
 * "Onspaceed" is recorded on the actor rather than in the browser, so this
 * greets a person once rather than once per device.
 */
import { computed, ref } from 'vue'
import { useTheme, type TTheme } from '@nubisco/ui'
import { api, auth } from '@/api/client'
import { humanise } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'

const MAX_BYTES = 2 * 1024 * 1024

const props = defineProps<{
  open: boolean
  actorId: string
  handle: string
  name?: string
}>()

const emit = defineEmits<{
  /** Closed, with whether they asked to be shown around. */
  done: [startTour: boolean]
}>()

const ws = useWorkspace()
const theme = useTheme()

const file = ref<File | null>(null)
const cropped = ref<Blob | null>(null)
const saving = ref(false)
const error = ref('')

const themeOptions = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'Match my system', value: 'system' },
]

const firstName = computed(
  () => (props.name ?? props.handle).split(' ')[0] || props.handle,
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

async function finish(how: 'tour' | 'dismiss'): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    if (cropped.value) {
      await api.uploadAvatar(props.actorId, cropped.value)
      await ws.refresh()
    }
    // Recorded even when they changed nothing: the fact worth keeping is that
    // they were asked, so we do not ask again.
    await auth.markOnspaceed()
    emit('done', how === 'tour')
  } catch (err) {
    // A failed picture upload must not trap someone in the welcome. Say what
    // went wrong, and let the button through on the next press.
    error.value = humanise(err)
    cropped.value = null
    file.value = null
  } finally {
    saving.value = false
  }
}
</script>

<style scoped lang="scss">
.welcome {
  display: grid;
  gap: var(--nb-spacing-24);

  &__lede {
    margin: 0;
    color: var(--nb-c-text-subtle);
  }

  &__group {
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__title {
    margin: 0;
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-sm-weight);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--nb-c-text-subtle);
  }

  &__avatar {
    display: flex;
    align-items: flex-start;
    gap: var(--nb-spacing-16);
  }

  &__avatar-copy {
    display: grid;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
    flex: 1;
  }

  &__hint {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }
}
</style>

<template>
  <span
    v-nb-tooltip="{
      header: displayName,
      body: handleLabel,
      tip: kindLabel,
      aria: 'label',
      focusable: true,
    }"
    class="avatar"
    :style="{
      background: color,
      inlineSize: `${size}px`,
      blockSize: `${size}px`,
      fontSize: `${Math.round(size * 0.45)}px`,
    }"
  >
    <!-- The image (uploaded or SSO-synced) rides on top of the initials, so
         a broken or slow URL degrades to the deterministic fallback. -->
    <img
      v-if="avatarUrl"
      class="avatar__img"
      :src="avatarUrl"
      alt=""
      loading="lazy"
      @error="imageFailed = true"
    />
    {{ initials }}
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { chartColorFor } from '@/lib/colors'
import { useWorkspace } from '@/stores/workspace'

// A generic avatar belongs in @nubisco/ui eventually (no NbAvatar exists
// yet); this is the minimal domain stand-in: initials on a deterministic
// chart-token color, with the user info hint (name, handle, kind) on hover.
const props = withDefaults(
  defineProps<{
    handle: string
    size?: number
    /**
     * Display name for someone who is not a member of this workspace, which
     * is how an imported comment's author arrives: a name from another system
     * with no handle behind it. Used for the initials and the tooltip so they
     * do not read as a handle that does not exist.
     */
    name?: string
  }>(),
  { size: 20, name: undefined },
)

const ws = useWorkspace()

const actor = computed(() =>
  ws.overview.value?.actors.find((a) => a.handle === props.handle),
)

const displayName = computed(
  () => actor.value?.name ?? props.name ?? `@${props.handle}`,
)

/** Only members have a handle worth showing; a foreign author has none. */
const handleLabel = computed(() =>
  actor.value || !props.name ? `@${props.handle}` : undefined,
)

const kindLabel = computed(() => {
  switch (actor.value?.kind) {
    case 'agent':
      return 'AI agent'
    case 'system':
      return 'System account'
    case 'human':
      return 'Member'
    default:
      return undefined
  }
})

const initials = computed(() => {
  const name = actor.value?.name ?? props.name ?? props.handle
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
})

const color = computed(() => chartColorFor(props.handle))

const imageFailed = ref(false)
const avatarUrl = computed(() =>
  imageFailed.value ? null : (actor.value?.avatar_url ?? null),
)
</script>

<style scoped lang="scss">
.avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-weight: var(--nb-type-label-lg-weight, 600);
  color: var(--nb-c-bg);
  flex: none;
  overflow: hidden;
}

.avatar__img {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  object-fit: cover;
}
</style>

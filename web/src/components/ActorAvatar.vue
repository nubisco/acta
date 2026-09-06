<template>
  <span
    v-nb-tooltip="{
      header: displayName,
      body: `@${props.handle}`,
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
    {{ initials }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspace } from '@/stores/workspace'

// A generic avatar belongs in @nubisco/ui eventually (no NbAvatar exists
// yet); this is the minimal domain stand-in: initials on a deterministic
// chart-token color, with the user info hint (name, handle, kind) on hover.
const props = withDefaults(defineProps<{ handle: string; size?: number }>(), {
  size: 20,
})

const ws = useWorkspace()

const actor = computed(() =>
  ws.overview.value?.actors.find((a) => a.handle === props.handle),
)

const displayName = computed(() => actor.value?.name ?? `@${props.handle}`)

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
  const name = actor.value?.name ?? props.handle
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
})

const color = computed(() => {
  let hash = 0
  for (const ch of props.handle) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `var(--nb-c-chart-${(hash % 8) + 1})`
})
</script>

<style scoped lang="scss">
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-weight: var(--nb-type-label-lg-weight, 600);
  color: var(--nb-c-bg);
  flex: none;
}
</style>

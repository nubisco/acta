<template>
  <span
    v-nb-tooltip="{ body: displayName, aria: 'label' }"
    class="avatar"
    :style="{ background: color }"
  >
    {{ initials }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspace } from '@/stores/workspace'

// A generic avatar belongs in @nubisco/ui eventually (no NbAvatar exists
// yet); this is the minimal domain stand-in: initials on a deterministic
// chart-token color, named for assistive tech via the tooltip directive.
const props = defineProps<{ handle: string }>()

const ws = useWorkspace()

const actor = computed(() =>
  ws.overview.value?.actors.find((a) => a.handle === props.handle),
)

const displayName = computed(() => actor.value?.name ?? `@${props.handle}`)

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
  inline-size: 20px;
  block-size: 20px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: var(--nb-type-label-lg-weight, 600);
  color: var(--nb-c-bg);
  flex: none;
}
</style>

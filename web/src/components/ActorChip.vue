<template>
  <span class="actor-chip">
    <ActorAvatar :handle="handle" :size="size" />
    <span class="actor-chip__name">{{ displayName }}</span>
  </span>
</template>

<script setup lang="ts">
// The law of people-rendering: wherever a person appears, it is avatar +
// display name. The @handle stays the storage format, never the visible one.
import { computed } from 'vue'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'

const props = withDefaults(defineProps<{ handle: string; size?: number }>(), {
  size: 16,
})

const ws = useWorkspace()
const displayName = computed(
  () =>
    ws.overview.value?.actors.find((a) => a.handle === props.handle)?.name ??
    `@${props.handle}`,
)
</script>

<style scoped lang="scss">
.actor-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-inline-size: 0;

  &__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>

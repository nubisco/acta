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
/**
 * A handle the directory cannot answer for still reads as a person: the pill
 * keeps its shape and shows `@handle`. Somebody who has left the workspace,
 * or a mention typed before the directory arrived, was still a mention, and
 * falling back to raw text in the middle of a sentence reads as a rendering
 * fault rather than as a name.
 */
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

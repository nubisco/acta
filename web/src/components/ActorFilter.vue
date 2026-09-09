<template>
  <div class="people" role="group" :aria-label="label">
    <button
      v-for="actor in actors"
      :key="actor.handle"
      v-nb-tooltip="{ body: actor.name }"
      type="button"
      class="people__one"
      :class="{ 'people__one--on': selected.includes(actor.handle) }"
      :aria-pressed="selected.includes(actor.handle)"
      :aria-label="`${selected.includes(actor.handle) ? 'Stop showing' : 'Show'} ${actor.name}`"
      @click="toggle(actor.handle)"
    >
      <ActorAvatar :handle="actor.handle" :size="26" />
    </button>
    <NbButton
      v-if="selected.length > 0"
      size="xs"
      variant="ghost"
      @click="emit('update:modelValue', [])"
    >
      Everyone
    </NbButton>
  </div>
</template>

<script setup lang="ts">
/**
 * People as a filter, rather than a dropdown that can only hold one of them.
 *
 * An empty selection means everyone, which is the same thing a "Everyone"
 * option would say while also being the state you land in. The clear button
 * only appears once there is something to clear.
 */
import { computed } from 'vue'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'

const props = defineProps<{ modelValue: string[]; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const ws = useWorkspace()
const label = computed(() => props.label ?? 'Filter by person')
const selected = computed(() => props.modelValue)

const actors = computed(() =>
  (ws.overview.value?.actors ?? []).filter((a) => a.kind !== 'system'),
)

function toggle(handle: string): void {
  const next = selected.value.includes(handle)
    ? selected.value.filter((h) => h !== handle)
    : [...selected.value, handle]
  emit('update:modelValue', next)
}
</script>

<style scoped lang="scss">
.people {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  flex-wrap: wrap;

  &__one {
    background: none;
    border: 0;
    padding: 2px;
    border-radius: 50%;
    cursor: pointer;
    line-height: 0;
    /* Unselected faces are dimmed rather than hidden, so the row reads as a
     * set of choices instead of a set of results. */
    opacity: 0.45;
    outline: 2px solid transparent;
    transition: opacity 120ms ease;

    &:hover {
      opacity: 0.8;
    }

    &--on {
      opacity: 1;
      outline-color: var(--nb-c-primary);
    }

    &:focus-visible {
      outline-color: var(--nb-c-focus-ring, var(--nb-c-primary));
    }
  }
}
</style>

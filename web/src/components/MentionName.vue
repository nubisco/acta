<template>
  <span
    v-nb-tooltip="{
      header: displayName,
      body: handleLabel,
      tip: kindLabel,
      aria: 'label',
      focusable: true,
    }"
    class="mention-name"
    >@{{ name }}</span
  >
</template>

<script setup lang="ts">
// A person named inside a sentence: `@Name`, with no face.
//
// Everywhere else a person is avatar plus name (ActorChip). A mention is the
// exception, because in a comment thread a face means "who wrote this", and
// a second face inside the text reads as a second author (Jose, 2026-10-10).
// The `@` is what marks it as a person once the avatar is gone, and the hover
// hint is the avatar's, so who it is stays one hover away.
import { computed } from 'vue'
import { useActorLabel } from '@/composables/useActorLabel'

const props = defineProps<{ handle: string }>()

const { actor, displayName, handleLabel, kindLabel } = useActorLabel(
  () => props.handle,
)

/** A handle nobody answers to still reads as a mention: `@ghost`. */
const name = computed(() => actor.value?.name ?? props.handle)
</script>

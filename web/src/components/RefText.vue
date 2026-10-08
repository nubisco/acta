<template>
  <span class="ref-text">
    <template v-for="(part, i) in parts" :key="i">
      <button
        v-if="'key' in part"
        type="button"
        class="md__ref md__ref--bare"
        :title="titleOf(part.key)"
        @click.stop.prevent="inspector.open(part.key)"
      >
        {{ part.key }}</button
      ><template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useInspector, useWorkspace } from '@/stores/workspace'
import { useRefCards } from '@/stores/refs'
import { splitCardKeys } from '@/lib/cardKeys'

/**
 * Plain text with every card key in it made openable: a checklist entry, a
 * history line, anything that is not markdown. The markdown surfaces do the
 * same through lib/cardKeys.ts, so a key reads and behaves alike in both.
 * `.stop.prevent` because the text often sits in a label or a row that has
 * a click of its own, and opening a card must not also tick a checkbox.
 */
const props = defineProps<{ text: string }>()

const ws = useWorkspace()
const inspector = useInspector()
const refCards = useRefCards()

const parts = computed(() =>
  splitCardKeys(
    props.text,
    new Set((ws.overview.value?.spaces ?? []).map((s) => s.key)),
  ),
)

watchEffect(() => {
  for (const part of parts.value) if ('key' in part) refCards.request(part.key)
})

function titleOf(key: string): string {
  const card = refCards.cards.get(key)
  return card ? `${key} ${card.title}` : `Open ${key}`
}
</script>

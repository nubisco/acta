<template>
  <span class="ref-text">
    <template v-for="(part, i) in parts" :key="i">
      <CardKeyLink
        v-if="'key' in part"
        :card-key="part.key"
        :title="titleOf(part.key)"
        @open="inspector.open"
      /><template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useInspector, useWorkspace } from '@/stores/workspace'
import { useRefCards } from '@/stores/refs'
import { splitCardKeys } from '@/lib/cardKeys'
import CardKeyLink from '@/components/CardKeyLink.vue'

/**
 * Plain text with every card key in it made openable: a checklist entry, a
 * history line, anything that is not markdown. The markdown surfaces do the
 * same through lib/cardKeys.ts, so a key reads and behaves alike in both.
 * CardKeyLink keeps the click from reaching a label or row around the text.
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

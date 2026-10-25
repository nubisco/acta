<template>
  <!-- A card key in running text: the library's link button, so it has the
       focus ring, the keyboard and the hover of every other link, and a real
       href, so a middle or modified click opens the card in a new tab the way
       any link does. A plain click stays in the page and opens the card
       here. The default slot replaces the key with a label, a card's title
       in a list of them. -->
  <NbButton
    variant="link"
    class="card-key-link"
    :class="{ 'card-key-link--key': !$slots.default }"
    :href="cardPath(cardKey)"
    @click="onClick"
  >
    <slot>{{ cardKey }}</slot>
  </NbButton>
</template>

<script setup lang="ts">
import { cardPath, wantsNewTab } from '@/lib/paths'

const props = defineProps<{ cardKey: string }>()

const emit = defineEmits<{ open: [key: string] }>()

/**
 * `stopPropagation` because a key often sits in a label or a row with a click
 * of its own, and opening a card must not also tick a checkbox.
 */
function onClick(event: MouseEvent): void {
  event.stopPropagation()
  if (wantsNewTab(event)) return
  event.preventDefault()
  emit('open', props.cardKey)
}
</script>

<style scoped lang="scss">
/* Mono, because a key is an address, and sized to the text around it. */
.card-key-link--key {
  font-family: var(--nb-font-family-mono);
  font-size: 0.9em;
  white-space: nowrap;
}
</style>

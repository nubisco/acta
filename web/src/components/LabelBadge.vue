<template>
  <NbBadge :size="size" :variant="variant">{{ name }}</NbBadge>
</template>

<script setup lang="ts">
/**
 * A label as it actually looks. Labels carry a colour and that colour is how
 * people recognise them at a glance, so a select that renders one as plain
 * text is showing a different thing to the one on the card.
 *
 * The colour is resolved here from the workspace rather than passed in, so
 * every caller gets the same answer without threading a variants map through.
 */
import { computed } from 'vue'
import { labelVariants } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'

const props = withDefaults(
  defineProps<{
    name: string
    /**
     * `sm` on a card, where labels sit in a dense meta row beside the key.
     * `md` wherever the label IS the content: a select's value and its
     * options have the full width of the field and were rendering the
     * smallest pill in the set into it.
     */
    size?: 'sm' | 'md'
  }>(),
  { size: 'sm' },
)

const ws = useWorkspace()
const variant = computed(
  () => labelVariants(ws.overview.value).get(props.name) ?? 'grey',
)
</script>

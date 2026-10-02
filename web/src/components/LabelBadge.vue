<template>
  <NbBadge :size="size" :variant="variant">{{ text }}</NbBadge>
</template>

<script setup lang="ts">
/**
 * A label as it actually looks. Labels carry a colour and that colour is how
 * people recognise them at a glance, so a select that renders one as plain
 * text is showing a different thing to the one on the card.
 *
 * The colour is resolved here from the workspace rather than passed in, so
 * every caller gets the same answer without threading a variants map through.
 *
 * Pass `id` wherever the card gave one. A name is no longer enough to find a
 * label: "Affects version" and "Fixes version" both list 1.12.0, and only the
 * id says which of them this is. `name` stays for the places that genuinely
 * only have a name, the board filter and the table among them.
 */
import { computed } from 'vue'
import { colorVariant, labelVariants, labelsById } from '@/lib/labels'
import { useWorkspace } from '@/stores/workspace'

const props = withDefaults(
  defineProps<{
    /** The label's id, which resolves it exactly, group included. */
    id?: string
    /** Its name, for callers that have nothing better. */
    name?: string
    /**
     * Name the group this value answers, where the group names a single
     * answer: "Fixes version: 1.12.0" rather than a loose chip saying
     * 1.12.0. For the places where the label stands on its own, a card's
     * label row above all. Off inside a picker, where the options already
     * sit under their group's heading and repeating it is noise.
     */
    qualify?: boolean
    /**
     * `sm` on a card, where labels sit in a dense meta row beside the key.
     * `md` wherever the label IS the content: a select's value and its
     * options have the full width of the field and were rendering the
     * smallest pill in the set into it.
     */
    size?: 'sm' | 'md'
  }>(),
  { id: undefined, name: undefined, qualify: false, size: 'sm' },
)

const ws = useWorkspace()
const entry = computed(() =>
  props.id ? labelsById(ws.overview.value).get(props.id) : undefined,
)

/**
 * A group that names a single answer reads as a field, so its value is shown
 * as one. Groups that hold several values are ordinary tags and stay bare,
 * which keeps the common case quiet.
 */
const text = computed(() => {
  const label = entry.value
  if (!label) return props.name ?? ''
  return props.qualify && label.exclusive
    ? `${label.group}: ${label.name}`
    : label.name
})

// By id where there is one: two groups holding the same value name may well
// have given it different colours, and the by-name map can only answer with
// one of them.
const variant = computed(() =>
  entry.value
    ? colorVariant(entry.value.color)
    : (labelVariants(ws.overview.value).get(props.name ?? '') ?? 'grey'),
)
</script>

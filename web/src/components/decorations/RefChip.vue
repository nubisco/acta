<template>
  <NodeViewWrapper
    as="span"
    class="md__ref"
    :class="chipClasses"
    :title="tooltip"
    :data-ref-type="target.kind"
    :data-ref="target.value"
  >
    <!-- A mention is a person: avatar and display name, never the handle,
         which is storage rather than presentation. -->
    <template v-if="target.kind === 'actor'">
      <ActorAvatar :handle="target.value" :size="16" />
      <span class="md__chip-title">{{ actorName }}</span>
    </template>

    <template v-else-if="chip">
      <span v-if="!chip.gone" class="md__chip-dot" aria-hidden="true" />
      <span class="md__chip-key">{{ chip.key }}</span>
      <span v-if="chip.label" class="md__chip-title">{{ chip.label }}</span>
    </template>

    <!-- Doc and space references are links rather than live cards, so they
         need no lookup and can render immediately. -->
    <template v-else-if="target.kind !== 'item'">
      <NbIcon :name="glyph" :size="13" />
      <span class="md__chip-title">{{ label }}</span>
    </template>

    <!-- A card whose lookup has not landed yet. The key is already correct,
         so it is shown rather than a spinner that would reflow the line. -->
    <span v-else class="md__chip-key">{{ target.value }}</span>
  </NodeViewWrapper>
</template>

<script setup lang="ts">
/**
 * A `[[reference]]` inside the editor, as the same chip the reader shows.
 *
 * The editor used to leave these as literal `[[SU-12]]` text, so the two
 * surfaces disagreed about what a reference is and you could put the caret
 * inside a card key and break it.
 */
import { computed } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import ActorAvatar from '@/components/ActorAvatar.vue'
import { useRefCards } from '@/stores/refs'
import { useWorkspace } from '@/stores/workspace'
import { classifyRef, itemChip } from '@/components/decorations/refs'

/* eslint-disable-next-line vue/prop-name-casing --
   NodeViewProps is Tiptap's type and carries `HTMLAttributes`. Renaming it
   would mean the node view no longer matches what Tiptap passes. */
const props = defineProps<NodeViewProps>()

const refCards = useRefCards()
const ws = useWorkspace()

const target = computed(() =>
  classifyRef(String(props.node.attrs.target ?? '')),
)
const alias = computed(() => props.node.attrs.alias as string | null)

const chip = computed(() => {
  if (target.value.kind !== 'item') return null
  // Requesting inside a computed is deliberate: the store batches and
  // de-duplicates, and this is the point at which we know the key is needed.
  refCards.request(target.value.value)
  void refCards.version.value
  return itemChip(
    target.value.value,
    refCards.cards.get(target.value.value),
    alias.value,
  )
})

const actorName = computed(
  () =>
    ws.overview.value?.actors.find((a) => a.handle === target.value.value)
      ?.name ?? `@${target.value.value}`,
)

const label = computed(() => alias.value?.trim() || target.value.value)

const glyph = computed(() =>
  target.value.kind === 'doc' ? 'file-text' : 'kanban',
)

const chipClasses = computed(() => {
  if (target.value.kind === 'actor') return ['md__mention']
  return chip.value?.classes ?? []
})

const tooltip = computed(() => {
  if (target.value.kind === 'actor') return `@${target.value.value}`
  return chip.value?.title ?? ''
})
</script>

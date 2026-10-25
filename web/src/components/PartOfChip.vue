<template>
  <div class="part-of">
    <div class="part-of__ref">
      <NbIcon name="arrow-bend-left-up" :size="13" aria-hidden="true" />
      <span class="part-of__lead">Part of</span>
      <span class="part-of__key">{{ parent.key }}</span>
      <CardKeyLink
        :card-key="parent.key"
        class="part-of__title"
        :aria-label="`Open ${parent.key}: ${parent.title}, which this card is part of`"
        @open="emit('open', $event)"
      >
        <span class="part-of__title-text">{{ parent.title }}</span>
      </CardKeyLink>
      <!-- Only when the parent is somewhere else. A board name on every chip
           is noise; on the ones that leave this board it is the whole point. -->
      <NbBadge v-if="parent.space !== space" size="sm" variant="grey">
        {{ parent.space }}
      </NbBadge>
    </div>
    <NbButton
      v-nb-tooltip="{ body: `Detach from ${parent.key}. Both cards stay.` }"
      size="sm"
      variant="ghost"
      icon="link-break"
      :aria-label="`Detach ${itemKey} from ${parent.key}. Neither card is deleted.`"
      @click="detach"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Where this card sits in something larger, said once and quietly.
 *
 * Near the top because it is context for everything below it: reading a card
 * without knowing it is one fifth of something else is reading it wrong. One
 * line, no panel, because a card has exactly one parent and a section heading
 * over a single fact is heavier than the fact.
 */
import { api, newOpId } from '@/api/client'
import CardKeyLink from '@/components/CardKeyLink.vue'
import type { IPartRef } from '@/types/api'

const props = defineProps<{
  itemKey: string
  /** The space this card is on, which decides whether the parent is elsewhere. */
  space: string
  parent: IPartRef
}>()

const emit = defineEmits<{ changed: []; open: [key: string] }>()

/** No confirm: detaching writes one link to null and both cards survive it,
 *  and it is undone by picking the parent's Parts panel back up. */
async function detach(): Promise<void> {
  await api.itemWrite([
    {
      op: 'set_parent',
      op_id: newOpId(),
      key: props.itemKey,
      parent: null,
    },
  ])
  emit('changed')
}
</script>

<style scoped lang="scss">
.part-of {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  min-inline-size: 0;

  &__ref {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    /* Shrinks, never grows. Stretched to the full column the detach button
       was flung out to the panel's right edge, directly under the panel's own
       close button, which is the one click nobody meant to make. */
    flex: 0 1 auto;
    min-inline-size: 0;
    padding-block: var(--nb-spacing-2);
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__lead {
    flex: none;
  }

  &__key {
    flex: none;
    white-space: nowrap;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
  }

  /* The title is the link. It gives way before anything else in the line. */
  &__title {
    min-inline-size: 0;
  }

  &__title-text {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>

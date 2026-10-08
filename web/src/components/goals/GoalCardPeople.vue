<template>
  <span v-if="faces.length > 0" class="goal-card-people">
    <ActorAvatar
      v-for="handle in faces"
      :key="handle"
      :handle="handle"
      :size="22"
    />
    <span
      v-if="extra.length > 0"
      v-nb-tooltip="{ body: extra.map((h) => `@${h}`).join(', ') }"
      class="goal-card-people__more"
    >
      +{{ extra.length }}
    </span>
  </span>
  <NbBadge v-else size="sm" placeholder icon="user">Unassigned</NbBadge>
</template>

<script setup lang="ts">
/**
 * Who is on one of a goal's cards, as the board card draws them: up to three
 * faces, then "+N". Each face names its person on hover and on focus. People
 * have no page of their own, so the name is the whole of what a face can
 * offer.
 *
 * Nobody on it reads as a dimmed "Unassigned" rather than a gap, because a
 * free card is exactly what somebody scanning a goal for their next job is
 * looking for, and a blank cell says nothing.
 */
import { computed } from 'vue'
import { CARD_FACES } from '@/lib/cards'
import ActorAvatar from '@/components/ActorAvatar.vue'

const props = defineProps<{ assignees?: string[] }>()

const faces = computed(() => (props.assignees ?? []).slice(0, CARD_FACES))
const extra = computed(() => (props.assignees ?? []).slice(CARD_FACES))
</script>

<style scoped lang="scss">
.goal-card-people {
  display: inline-flex;
  align-items: center;
  gap: var(--nb-spacing-2);

  &__more {
    flex: none;
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-md-weight);
    color: var(--nb-c-text-muted);
    padding-inline: var(--nb-spacing-4);
  }
}
</style>

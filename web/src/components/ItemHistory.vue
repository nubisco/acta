<template>
  <div class="history">
    <NbDefinitionList class="history__facts" layout="columns">
      <NbDefinitionListItem term="Created">
        <span class="history__fact">
          <ActorChip v-if="createdBy" :handle="createdBy" />
          <span :title="absoluteTime(created)">{{
            relativeTime(created)
          }}</span>
        </span>
      </NbDefinitionListItem>
      <NbDefinitionListItem term="Last changed">
        <span :title="absoluteTime(updated)">{{ relativeTime(updated) }}</span>
      </NbDefinitionListItem>
    </NbDefinitionList>

    <ol v-if="shown.length > 0" class="history__list">
      <li v-for="event in shown" :key="event.id" class="history__row">
        <ActorAvatar v-if="event.by" :handle="event.by" :size="20" />
        <p class="history__line">
          <span class="history__who">{{ nameOf(event.by) }}</span>
          {{ ' ' }}
          <template v-for="(part, i) in describe(event)" :key="i">
            <ActorChip
              v-if="part.kind === 'person'"
              :handle="part.handle"
              class="history__inline"
            />
            <NbBadge
              v-else-if="part.kind === 'label'"
              v-nb-tooltip="{ body: part.name }"
              size="sm"
              variant="grey"
            >
              {{ part.name.split('/').pop() }}
            </NbBadge>
            <button
              v-else-if="part.kind === 'item'"
              type="button"
              class="md__ref md__ref--bare"
              @click="emit('open', part.key)"
            >
              {{ part.key }}
            </button>
            <RouterLink
              v-else-if="part.kind === 'goal'"
              class="md__ref"
              :to="wpath(`/goals/${part.number}`)"
            >
              G-{{ part.number }}
            </RouterLink>
            <RefText v-else :text="part.text" />
          </template>
          <span v-if="event.automated" class="history__muted">
            (automation)
          </span>
        </p>
        <time
          class="history__when"
          :datetime="new Date(event.ts).toISOString()"
          :title="absoluteTime(event.ts)"
        >
          {{ relativeTime(event.ts) }}
        </time>
      </li>
    </ol>
    <p v-else class="history__muted">Nothing has happened to this card yet.</p>

    <NbButton
      v-if="events.length > shown.length"
      size="xs"
      variant="ghost"
      @click="expanded = true"
    >
      Show all {{ events.length }}
    </NbButton>
  </div>
</template>

<script setup lang="ts">
/**
 * What happened to a card, and who did it.
 *
 * Asked for by Jose on 2026-10-08: when it was created and by whom, when it
 * changed, when its people changed. People are drawn as people, cards and
 * goals as links. Older events recorded less than new ones, so some early
 * rows read more vaguely ("changed the labels") and nothing can recover
 * what they did not write down.
 */
import { computed, ref, watch } from 'vue'
import RefText from '@/components/RefText.vue'
import { RouterLink } from 'vue-router'
import type { IItemEvent } from '@/types/api'
import { describe, shownInHistory } from '@/lib/history'
import { absoluteTime, relativeTime } from '@/lib/state'
import { wpath } from '@/lib/paths'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'
import ActorChip from '@/components/ActorChip.vue'

const props = defineProps<{
  itemKey: string
  events: IItemEvent[]
  created: number
  updated: number
  createdBy?: string
}>()
const emit = defineEmits<{ open: [key: string] }>()

const ws = useWorkspace()
const expanded = ref(false)

/** Twenty is enough to answer "what happened lately" without a wall. */
const FIRST = 20

const visible = computed(() => props.events.filter(shownInHistory))
const shown = computed(() =>
  expanded.value ? visible.value : visible.value.slice(0, FIRST),
)

watch(
  () => props.itemKey,
  () => (expanded.value = false),
)

function nameOf(handle: string | undefined): string {
  if (!handle) return 'Somebody'
  return (
    ws.overview.value?.actors.find((a) => a.handle === handle)?.name ??
    `@${handle}`
  )
}
</script>

<style scoped lang="scss">
.history {
  display: grid;
  gap: var(--nb-spacing-12);

  &__fact {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    flex-wrap: wrap;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__row {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) auto;
    gap: var(--nb-spacing-8);
    align-items: start;
  }

  &__line {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    line-height: 1.5;
    color: var(--nb-c-text-muted);
  }

  &__who {
    color: var(--nb-c-text);
    font-weight: var(--nb-type-label-md-weight);
  }

  &__inline {
    vertical-align: middle;
  }

  &__when {
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-subtle);
    white-space: nowrap;
  }

  &__muted {
    margin: 0;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-subtle);
  }
}
</style>

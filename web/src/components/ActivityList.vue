<template>
  <div class="activity" aria-label="Activity">
    <template v-for="group in groups" :key="group.label">
      <h3 class="activity__day type-label-md">{{ group.label }}</h3>
      <ul class="activity__list">
        <li v-for="event in group.events" :key="event.id" class="activity__row">
          <ActorAvatar
            v-if="handleFor(event)"
            :handle="handleFor(event)!"
            :size="24"
          />
          <span v-else class="activity__mark">
            <NbIcon
              :name="event.actor_kind === 'agent' ? 'robot' : 'gear'"
              :size="14"
            />
          </span>

          <span class="activity__body">
            <span class="activity__actor">{{ actorName(event) }}</span>
            {{ event.summary }}
            <NbAiLabel
              v-if="event.actor_kind === 'agent'"
              class="activity__ai"
            />
            <NbBadge v-if="event.caused_by" size="sm" variant="purple">
              Rule
            </NbBadge>
          </span>

          <time
            v-nb-tooltip="{ body: absoluteTime(event.ts) }"
            :datetime="new Date(event.ts).toISOString()"
            class="activity__time"
          >
            {{ relativeTime(event.ts) }}
          </time>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NbAiLabel, NbBadge, NbIcon } from '@nubisco/ui'
import type { IEventRow } from '@/types/api'
import { relativeTime } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'
import ActorAvatar from '@/components/ActorAvatar.vue'

const props = defineProps<{ events: IEventRow[] }>()

const ws = useWorkspace()

const actorsById = computed(
  () => new Map((ws.overview.value?.actors ?? []).map((a) => [a.id, a])),
)

function handleFor(event: IEventRow): string | undefined {
  return actorsById.value.get(event.actor_id)?.handle
}

function actorName(event: IEventRow): string {
  const actor = actorsById.value.get(event.actor_id)
  if (actor) return actor.name || `@${actor.handle}`
  return event.actor_kind === 'system' ? 'Acta' : 'Someone'
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

interface IDayGroup {
  label: string
  events: IEventRow[]
}

const groups = computed<IDayGroup[]>(() => {
  const out: IDayGroup[] = []
  for (const event of props.events) {
    const label = dayLabel(event.ts)
    const last = out[out.length - 1]
    if (last && last.label === label) last.events.push(event)
    else out.push({ label, events: [event] })
  }
  return out
})

function dayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}
</script>

<style scoped lang="scss">
.activity {
  display: grid;
  gap: var(--nb-spacing-8);

  &__day {
    margin: 0;
    padding-block-start: var(--nb-spacing-8);
    color: var(--nb-c-text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
  }

  &__row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    padding-block: var(--nb-spacing-4);
    font-size: var(--nb-type-body-sm-size);
    line-height: var(--nb-type-body-sm-line-height);

    & + & {
      border-block-start: 1px solid var(--nb-c-border);
    }
  }

  &__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 24px;
    block-size: 24px;
    border-radius: 50%;
    background: var(--nb-c-surface-hover);
    color: var(--nb-c-text-muted);
    flex: none;
  }

  &__body {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    flex-wrap: wrap;
  }

  &__actor {
    font-weight: var(--nb-type-label-lg-weight, 600);
  }

  &__ai {
    flex: none;
  }

  &__time {
    color: var(--nb-c-text-subtle);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
}
</style>

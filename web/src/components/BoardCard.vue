<template>
  <article
    class="board-card"
    :class="{
      'board-card--open': open,
      'board-card--done': row.done,
      'board-card--arrived': arrived,
    }"
    :data-card-key="row.key"
    :data-nb-tour-step="tourStep"
  >
    <!-- The whole card opens it. One button stretched under the content
         rather than a button around it, because the card holds buttons of
         its own (the empty slots) and a button cannot hold a button. -->
    <button
      class="board-card__open"
      type="button"
      :aria-label="`${row.key}: ${row.title}`"
      :aria-current="open ? 'true' : undefined"
      @click="emit('open', row.key)"
      @dblclick="emit('expand', row.key)"
      @contextmenu.prevent="emit('menu', $event, row.key)"
    />

    <div class="board-card__body">
      <div class="board-card__row board-card__head">
        <span class="board-card__key">{{ row.key }}</span>
        <span
          v-if="row.parent_key"
          class="board-card__chip"
          :aria-label="`Part of ${row.parent_key}`"
        >
          <NbIcon name="arrow-bend-left-up" /> {{ row.parent_key }}
        </span>
        <span class="board-card__grow" />
        <span
          v-if="blockers.length > 0"
          v-nb-tooltip="{ body: `Waits on ${blockers.join(', ')}` }"
          class="board-card__live"
        >
          <NbBadge size="sm" variant="red">
            Blocked by {{ blockers[0]
            }}{{ blockers.length > 1 ? ` +${blockers.length - 1}` : '' }}
          </NbBadge>
        </span>
        <NbBadge v-if="row.done" size="sm" variant="green">Done</NbBadge>
        <span
          v-if="size"
          v-nb-tooltip="{ body: `Size ${size}` }"
          class="board-card__live"
        >
          <NbBadge size="sm" variant="grey">{{ size }}</NbBadge>
        </span>
        <NbBadge
          v-else
          class="board-card__slot"
          size="sm"
          placeholder
          interactive
          aria-label="Set a size"
          @click="edit('size', $event)"
        >
          –
        </NbBadge>
      </div>

      <span class="board-card__title">{{ row.title }}</span>

      <span
        class="board-card__summary"
        :class="{ 'board-card__summary--empty': !row.summary }"
      >
        {{ row.summary || 'No description' }}
      </span>

      <div class="board-card__row">
        <template v-if="goals.length > 0">
          <RouterLink
            v-nb-tooltip="{
              header: `${goals[0].key} ${goals[0].title}`,
              body: goalStatus(goals[0].status).label,
            }"
            class="board-card__goal board-card__live"
            :to="wpath(`/goals/${goals[0].number}`)"
          >
            <NbIcon name="target" class="board-card__goal-icon" />
            <span class="board-card__goal-key">{{ goals[0].key }}</span>
            <span class="board-card__goal-title">{{ goals[0].title }}</span>
            <span
              class="board-card__goal-dot"
              :style="{ background: goalStatus(goals[0].status).color }"
              :aria-label="goalStatus(goals[0].status).label"
            />
          </RouterLink>
          <span
            v-if="goals.length > 1"
            v-nb-tooltip="{
              body: goals
                .slice(1)
                .map((g) => `${g.key} ${g.title}`)
                .join('\n'),
            }"
            class="board-card__more board-card__live"
          >
            +{{ goals.length - 1 }}
          </span>
        </template>
        <NbBadge
          v-else
          class="board-card__slot"
          size="sm"
          placeholder
          interactive
          icon="target"
          @click="edit('goal', $event)"
        >
          No goal
        </NbBadge>
      </div>

      <div class="board-card__row board-card__labels">
        <template v-if="labels.length > 0">
          <LabelBadge
            v-for="label in labels"
            :id="label.id"
            :key="label.key"
            :name="label.name"
            size="sm"
            qualify
          />
        </template>
        <NbBadge
          v-else
          class="board-card__slot"
          size="sm"
          placeholder
          interactive
          icon="tag"
          @click="edit('labels', $event)"
        >
          No labels
        </NbBadge>
      </div>

      <div class="board-card__row board-card__foot">
        <span
          class="board-card__count"
          :class="`board-card__count--${checklist.tone}`"
          :aria-label="checklistLabel"
        >
          <NbIcon name="check-square" /> {{ checklist.text }}
        </span>
        <span
          class="board-card__count"
          :class="`board-card__count--${comments.tone}`"
          :aria-label="`${comments.text} comments`"
        >
          <NbIcon name="chat-circle" /> {{ comments.text }}
        </span>
        <span
          class="board-card__count"
          :class="`board-card__count--${attachments.tone}`"
          :aria-label="`${attachments.text} attachments`"
        >
          <NbIcon name="paperclip" /> {{ attachments.text }}
        </span>
        <span
          class="board-card__count"
          :class="`board-card__count--${parts.tone}`"
          :aria-label="partsLabel"
        >
          <NbIcon name="tree-structure" /> {{ parts.text }}
        </span>
        <span class="board-card__grow" />
        <span
          v-if="due.tone !== 'none'"
          v-nb-tooltip="{ body: due.full }"
          class="board-card__live"
        >
          <NbBadge
            size="sm"
            :variant="DUE_VARIANT[due.tone]"
            icon="calendar-blank"
          >
            {{ due.text }}
          </NbBadge>
        </span>
        <NbBadge
          v-else
          class="board-card__slot"
          size="sm"
          placeholder
          interactive
          icon="calendar-blank"
          aria-label="Set a due date"
          @click="edit('due', $event)"
        />
        <span
          v-if="people.length > 0"
          class="board-card__people board-card__live"
        >
          <ActorAvatar
            v-for="handle in people"
            :key="handle"
            :handle="handle"
            :size="22"
          />
          <span
            v-if="extraPeople.length > 0"
            v-nb-tooltip="{ body: extraPeople.map((h) => `@${h}`).join(', ') }"
            class="board-card__more"
          >
            +{{ extraPeople.length }}
          </span>
        </span>
        <NbBadge
          v-else
          class="board-card__slot"
          size="sm"
          placeholder
          interactive
          icon="user-plus"
          aria-label="Assign someone"
          @click="edit('people', $event)"
        />
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
/**
 * One card on a board, in the one shape every card keeps.
 *
 * Jose, 2026-10-08: cards were "all over the place", a title and then
 * whatever happened to be filled in. Now there are six rows, always in this
 * order: header, title, summary, goal, labels, footer. An empty row keeps
 * its place and says so ("No goal"), so the same fact is in the same spot on
 * every card. Those empty slots are buttons that set the field right there.
 * Mocked up first, with Trello, Jira and ClickUp as the references:
 * https://claude.ai/artifact/XWeKVRWD8wxRLKwsQYMMmA
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { ISpaceItemRow } from '@/types/api'
import {
  CARD_FACES,
  countView,
  dueView,
  parseProgress,
  sizeText,
  type TDueTone,
} from '@/lib/cards'
import { goalStatus } from '@/lib/goals'
import { rowLabels } from '@/lib/labels'
import { wpath } from '@/lib/paths'
import ActorAvatar from '@/components/ActorAvatar.vue'
import LabelBadge from '@/components/LabelBadge.vue'

export type TCardField = 'size' | 'goal' | 'labels' | 'due' | 'people'

const props = defineProps<{
  row: ISpaceItemRow
  /** The card the details panel is showing. */
  open?: boolean
  /** Just arrived at from elsewhere: ringed for a moment so it is found. */
  arrived?: boolean
  tourStep?: string | null
}>()

const emit = defineEmits<{
  open: [key: string]
  expand: [key: string]
  menu: [event: MouseEvent, key: string]
  /** An empty slot was clicked: set this field, anchored to that slot. */
  edit: [field: TCardField, key: string, anchor: HTMLElement]
}>()

const DUE_VARIANT: Record<
  Exclude<TDueTone, 'none'>,
  'grey' | 'orange' | 'red' | 'green'
> = { later: 'grey', soon: 'orange', late: 'red', met: 'green' }

const blockers = computed(() => props.row.blocked_by ?? [])
const size = computed(() => sizeText(props.row.size))
const goals = computed(() => props.row.goals ?? [])
const labels = computed(() => rowLabels(props.row))
const due = computed(() => dueView(props.row.due, props.row.done))
const checklist = computed(() => {
  const [done, total] = parseProgress(props.row.chk)
  return countView(done, total)
})
const comments = computed(() => countView(props.row.cmts ?? 0))
const attachments = computed(() => countView(props.row.atts ?? 0))
const parts = computed(() =>
  countView(props.row.parts_done ?? 0, props.row.parts_total ?? 0),
)
const partsLabel = computed(() =>
  props.row.parts_total
    ? `${props.row.parts_done ?? 0} of ${props.row.parts_total} parts done`
    : 'No parts',
)
const checklistLabel = computed(() =>
  checklist.value.tone === 'zero'
    ? 'No checklist'
    : `Checklist ${checklist.value.text} done`,
)
const people = computed(() => (props.row.assignees ?? []).slice(0, CARD_FACES))
const extraPeople = computed(() =>
  (props.row.assignees ?? []).slice(CARD_FACES),
)

function edit(field: TCardField, event: MouseEvent): void {
  emit('edit', field, props.row.key, event.currentTarget as HTMLElement)
}
</script>

<style scoped lang="scss">
@keyframes board-card-arrived {
  0%,
  60% {
    opacity: 1;
  }

  100% {
    opacity: 0;
  }
}

.board-card {
  position: relative;
  display: grid;
  gap: var(--nb-spacing-8);
  /* A grid item's default min-width is auto, so a long title would push
     the card wider than its column instead of wrapping inside it. */
  min-inline-size: 0;
  color: var(--nb-c-text);

  /* Which card the details panel is showing. A bar at the inline start
     rather than a tint, because cards already carry label colour. */
  /* Just arrived at from elsewhere: a ring that fades, so the eye finds the
     card on a full board, and then gets out of the way. */
  &--arrived::after {
    content: '';
    position: absolute;
    inset: calc(var(--nb-spacing-8) * -1);
    border-radius: var(--nb-radius-md);
    box-shadow: 0 0 0 2px var(--nb-c-primary);
    pointer-events: none;
    animation: board-card-arrived 2.4s ease-out forwards;
  }

  @media (prefers-reduced-motion: reduce) {
    &--arrived::after {
      animation-duration: 0.01s;
      animation-delay: 2.4s;
    }
  }

  &--open::before {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline-start: calc(var(--nb-spacing-8) * -1);
    inline-size: 2px;
    border-radius: 1px;
    background: var(--nb-c-primary);
  }

  &__open {
    position: absolute;
    inset: 0;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
    border-radius: var(--nb-radius-sm);

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 4px;
    }
  }

  /* The content sits over the open button and lets clicks fall through to
     it, except for the parts that do something of their own. */
  &__body {
    position: relative;
    display: grid;
    gap: var(--nb-spacing-8);
    min-inline-size: 0;
    pointer-events: none;
  }

  &__slot,
  &__live {
    pointer-events: auto;
  }

  &__row {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    min-block-size: 22px;
    min-inline-size: 0;
  }

  &__grow {
    flex: 1 1 auto;
  }

  &__key {
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-subtle);
  }

  &__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-2);
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-muted);
  }

  /* Up to three lines. The only row that changes a card's height on its
     own, and it stops at three so one long title cannot. */
  &__title {
    font-size: var(--nb-type-body-md-size);
    font-weight: var(--nb-type-label-lg-weight);
    line-height: 1.4;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
  }

  &--done &__title {
    color: var(--nb-c-text-muted);
  }

  &__summary {
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    &--empty {
      font-style: italic;
      color: var(--nb-c-text-subtle);
    }
  }

  /* A goal is not a label: outlined, tinted with the primary colour and
     carrying the target icon, so the two never read as the same thing. */
  &__goal {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    block-size: 22px;
    padding-inline: var(--nb-spacing-8);
    min-inline-size: 0;
    max-inline-size: 100%;
    border: 1px solid color-mix(in srgb, var(--nb-c-primary) 30%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--nb-c-primary) 8%, transparent);
    color: var(--nb-c-text);
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-md-weight);
    text-decoration: none;

    &:hover {
      background: color-mix(in srgb, var(--nb-c-primary) 14%, transparent);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 1px;
    }
  }

  &__goal-icon {
    flex: none;
    color: var(--nb-c-primary);
  }

  &__goal-key {
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-primary);
  }

  &__goal-title {
    min-inline-size: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &__goal-dot {
    flex: none;
    inline-size: 8px;
    block-size: 8px;
    border-radius: 50%;
  }

  &__more {
    flex: none;
    font-size: var(--nb-type-label-sm-size);
    font-weight: var(--nb-type-label-md-weight);
    color: var(--nb-c-text-muted);
    padding-inline: var(--nb-spacing-4);
  }

  /* Labels wrap to a second line only when one is not enough. */
  &__labels {
    flex-wrap: wrap;
  }

  &__foot {
    gap: var(--nb-spacing-8);
    padding-block-start: var(--nb-spacing-8);
    border-block-start: 1px solid var(--nb-c-border);
    /* The row minimum counts the border box, so the padding and the rule
       come on top of it here. Without that an empty footer (placeholders
       only) sat 6px shorter than one with faces in it. */
    min-block-size: calc(22px + var(--nb-spacing-8) + 1px);
  }

  &__count {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-2);
    font-size: var(--nb-type-label-sm-size);
    color: var(--nb-c-text-muted);

    &--zero {
      color: var(--nb-c-text-subtle);
    }

    &--full {
      color: var(--nb-c-status-valid);
    }
  }

  &__people {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-2);
  }
}
</style>

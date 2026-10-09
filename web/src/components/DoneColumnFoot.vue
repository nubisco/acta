<template>
  <!-- What the Done column is not showing, said where the cards would be.
       Hiding them silently is the most common complaint about every tool
       that does this (UX research, 2026-10-09). -->
  <div class="done-foot">
    <p class="done-foot__line">
      <template v-if="showingAll">Showing every done card</template>
      <template v-else-if="hidden > 0">
        {{ plural(hidden, 'older done card') }} hidden
      </template>
      <template v-else-if="windowDays">
        Showing the last {{ plural(windowDays, 'day') }}
      </template>
      <template v-else>Showing every done card</template>
      <NbInfoHint
        :size="14"
        label="About done cards"
        title="Done cards leave the board"
        :text="hint"
      />
    </p>
    <NbButton
      ref="trigger"
      v-nb-tooltip="{ body: 'Done column options' }"
      size="xs"
      variant="ghost"
      icon="dots-three"
      aria-label="Done column options"
      @click="toggle"
    />
    <NbMenu
      ref="menu"
      v-model:open="open"
      size="sm"
      :min-width="240"
      @close="open = false"
    >
      <!-- Literal icon names: the library links artwork at build time. -->
      <NbMenuItem
        v-if="showingAll"
        icon="eye-slash"
        label="Hide older done cards"
        @select="pick(() => emit('toggle-all'))"
      />
      <NbMenuItem
        v-else-if="hidden > 0"
        icon="eye"
        label="Show older done cards"
        @select="pick(() => emit('toggle-all'))"
      />
      <NbMenuItem
        icon="broom"
        label="Clear done now"
        @select="pick(() => emit('clear'))"
      />
      <NbMenuDivider />
      <template v-for="option in WINDOWS" :key="String(option.days)">
        <NbMenuItem
          v-if="option.days === windowDays"
          icon="check"
          :label="option.label"
          @select="pick(() => emit('set-window', option.days))"
        />
        <NbMenuItem
          v-else
          icon="calendar-blank"
          :label="option.label"
          @select="pick(() => emit('set-window', option.days))"
        />
      </template>
    </NbMenu>
  </div>
</template>

<script setup lang="ts">
/**
 * The foot of a board's Done column: how many done cards the space's window
 * is leaving out, and the controls for it. A done card leaves the board a
 * set number of days after it became done (14 by default), or at once with
 * "Clear done now". Nothing is archived, and the cards stay in search, in the
 * table under "Done cards" and in every goal's progress (Jose, 2026-10-09).
 */
import { computed, ref } from 'vue'
import type { NbMenu } from '@nubisco/ui'

const props = defineProps<{
  hidden: number
  /** The space's window in days. Null: done cards stay. */
  windowDays: number | null
  /** The reader asked to see the older ones, for now. */
  showingAll: boolean
}>()

const emit = defineEmits<{
  'set-window': [days: number | null]
  'toggle-all': []
  clear: []
}>()

/** The choices Jira settled on, plus never. */
const WINDOWS: { days: number | null; label: string }[] = [
  { days: 1, label: 'Keep done cards for 1 day' },
  { days: 7, label: 'Keep done cards for 7 days' },
  { days: 14, label: 'Keep done cards for 14 days' },
  { days: 30, label: 'Keep done cards for 30 days' },
  { days: 60, label: 'Keep done cards for 60 days' },
  { days: null, label: 'Keep every done card' },
]

const open = ref(false)
const menu = ref<InstanceType<typeof NbMenu> | null>(null)
const trigger = ref<{ $el: HTMLElement } | null>(null)

function toggle(): void {
  const rect = trigger.value?.$el?.getBoundingClientRect()
  if (rect) menu.value?.setPositionXY(rect.left, rect.bottom + 4)
  open.value = !open.value
}

function pick(run: () => void): void {
  open.value = false
  run()
}

const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : `${word}s`}`

const hint = computed(() =>
  props.windowDays
    ? `A card leaves this board ${plural(props.windowDays, 'day')} after it is done, counted from when it became done, not from its last change. Nothing is archived: it stays in search, in the Table view under "Done cards" and in its goals' progress. Change the window, show the older cards for now, or clear the column from the menu.`
    : 'Every done card stays on this board. Pick a window from the menu to let old ones leave on their own, or clear the column now.',
)
</script>

<style scoped lang="scss">
.done-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-spacing-8);
  inline-size: 100%;
  padding-inline: var(--nb-spacing-8);
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-type-body-sm-size);

  &__line {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    margin: 0;
  }
}
</style>

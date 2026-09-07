<template>
  <div class="sug" role="listbox" aria-label="Suggestions">
    <p v-if="items.length === 0" class="sug__empty">No matches</p>
    <button
      v-for="(item, index) in items"
      :key="item.id"
      type="button"
      class="sug__item"
      :class="{ 'sug__item--active': index === active }"
      role="option"
      :aria-selected="index === active"
      @mouseenter="active = index"
      @click="select(index)"
    >
      <NbIcon :name="item.icon" :size="14" class="sug__icon" />
      <span class="sug__label">{{ item.label }}</span>
      <span v-if="item.hint" class="sug__hint">{{ item.hint }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
// Shared popover body for both editor typeaheads (the / insert menu and the
// [[ reference search). Keyboard handling is driven by the suggestion
// plugin through onKeyDown, exposed here for the VueRenderer bridge.
import { ref, watch } from 'vue'
import { NbIcon } from '@nubisco/ui'
import type { ISuggestionItem } from '@/components/editor/suggestions'

const props = defineProps<{
  items: ISuggestionItem[]
  command: (item: ISuggestionItem) => void
}>()
const active = ref(0)

watch(
  () => props.items,
  () => (active.value = 0),
)

function select(index: number): void {
  const item = props.items[index]
  if (item) props.command(item)
}

function onKeyDown(event: KeyboardEvent): boolean {
  // An empty list owns no keys: Enter and arrows keep their editor meaning.
  if (props.items.length === 0) return false
  if (event.key === 'ArrowDown') {
    active.value = (active.value + 1) % props.items.length
    return true
  }
  if (event.key === 'ArrowUp') {
    active.value = (active.value - 1 + props.items.length) % props.items.length
    return true
  }
  if (event.key === 'Enter') {
    select(active.value)
    return true
  }
  return false
}

defineExpose({ onKeyDown })
</script>

<style scoped lang="scss">
.sug {
  display: flex;
  flex-direction: column;
  min-inline-size: 240px;
  max-inline-size: 340px;
  max-block-size: 280px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--nb-c-border);
  border-radius: var(--nb-radius-sm, 8px);
  background: var(--nb-c-bg-raised, var(--nb-c-bg));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);

  &__empty {
    margin: 0;
    padding: 8px 10px;
    font-size: var(--nb-font-size-13, 13px);
    color: var(--nb-c-text-muted);
  }

  &__item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--nb-c-text);
    font: inherit;
    font-size: var(--nb-font-size-13, 13px);
    text-align: start;
    cursor: pointer;

    &--active {
      background: var(--nb-c-bg-soft);
    }
  }

  &__icon {
    flex: none;
    color: var(--nb-c-text-muted);
  }

  &__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__hint {
    margin-inline-start: auto;
    flex: none;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
    color: var(--nb-c-text-muted);
  }
}
</style>

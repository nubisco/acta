<template>
  <div class="clist">
    <ul class="clist__items">
      <li v-for="entry in items" :key="entry.text">
        <NbCheckbox
          :model-value="entry.done"
          :label="entry.text"
          @update:model-value="(done: boolean) => emit('toggle', entry.text, done)"
        />
        <NbButton
          size="xxs"
          variant="ghost"
          icon="x"
          class="clist__remove"
          :aria-label="`Remove ${entry.text}`"
          @click="emit('remove', entry.text)"
        />
      </li>
    </ul>
    <form class="clist__add" @submit.prevent="submit">
      <NbTextInput
        :id="`field-clist-add-${uid}`"
        v-model="draft"
        size="sm"
        placeholder="Add an entry..."
        aria-label="New checklist entry"
      />
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue'
import { NbButton, NbCheckbox, NbTextInput } from '@nubisco/ui'

defineProps<{ items: { text: string; done: boolean }[] }>()

const emit = defineEmits<{
  toggle: [text: string, done: boolean]
  add: [text: string]
  remove: [text: string]
}>()

const uid = useId()
const draft = ref('')

function submit(): void {
  const text = draft.value.trim()
  if (!text) return
  emit('add', text)
  draft.value = ''
}
</script>

<style scoped lang="scss">
.clist {
  display: grid;
  gap: var(--nb-spacing-8);

  &__items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__items li {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
  }

  &__items li > :first-child {
    flex: 1;
    min-width: 0;
  }

  &__remove {
    opacity: 0;
    transition: opacity 100ms ease;
  }

  &__items li:hover .clist__remove,
  .clist__remove:focus-visible {
    opacity: 1;
  }
}
</style>

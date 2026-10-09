<template>
  <!-- Where "back" goes, said in words. An arrow alone gave no hint of which
       card it returns to, so after following two parts nobody knew where
       they would land. Shared by the side panel and the full-size view, so
       the way back reads the same in both. -->
  <span class="card-trail">
    <template v-if="previousKey">
      <NbButton
        v-nb-tooltip="{ body: `Back to ${previousLabel}` }"
        size="sm"
        variant="ghost"
        icon="arrow-left"
        :aria-label="`Back to ${previousKey}`"
        @click="inspector.back()"
      />
      <NbBreadcrumbs class="card-trail__crumbs">
        <NbButton
          v-nb-tooltip="{ body: `Back to ${previousLabel}` }"
          size="xs"
          variant="ghost"
          class="card-trail__crumb"
          @click="inspector.back()"
        >
          {{ previousKey }}
        </NbButton>
        <span class="card-trail__key" aria-current="page">{{ cardKey }}</span>
      </NbBreadcrumbs>
    </template>
    <span v-else class="card-trail__key">{{ cardKey }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useInspector } from '@/stores/workspace'
import { useRefCards } from '@/stores/refs'

defineProps<{ cardKey: string }>()

const inspector = useInspector()
const refCards = useRefCards()

/** The card "back" returns to, by key and, once known, by title. */
const previousKey = computed(() => inspector.trail.value.at(-1) ?? null)
const previousLabel = computed(() => {
  const key = previousKey.value
  if (!key) return ''
  const card = refCards.cards.get(key)
  return card ? `${key} ${card.title}` : key
})
watch(previousKey, (key) => key && refCards.request(key), { immediate: true })
</script>

<style scoped lang="scss">
.card-trail {
  display: inline-flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  min-inline-size: 0;
}

.card-trail__crumbs {
  min-inline-size: 0;
}

.card-trail__crumb {
  font-family: var(--nb-font-family-mono);
}

.card-trail__key {
  font-family: var(--nb-font-family-mono);
  font-size: var(--nb-type-code-sm-size);
  color: var(--nb-c-text-subtle);
  white-space: nowrap;
}
</style>

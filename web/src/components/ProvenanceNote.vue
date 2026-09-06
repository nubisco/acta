<template>
  <p class="provenance">
    <NbIcon name="download-simple" :size="13" />
    <span>
      Imported from {{ sourceName }}<template v-if="imported.author">
        · originally by {{ imported.author }}</template
      ><template v-if="createdLabel"> · {{ createdLabel }}</template
      ><template v-if="imported.versions && imported.versions > 1">
        · {{ imported.versions }} revisions at the source</template
      >
    </span>
    <a
      v-if="imported.url"
      :href="imported.url"
      target="_blank"
      rel="noopener"
      class="provenance__link"
    >
      original
    </a>
  </p>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NbIcon } from '@nubisco/ui'
import type { IImportedMeta } from '@/types/api'

const props = defineProps<{ imported: IImportedMeta }>()

const sourceName = computed(() => {
  const known: Record<string, string> = {
    trello: 'Trello',
    confluence: 'Confluence',
  }
  return known[props.imported.source] ?? props.imported.source
})

const createdLabel = computed(() => {
  const iso = props.imported.created_at
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
})
</script>

<style scoped lang="scss">
.provenance {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  margin: 0;
  font-size: var(--nb-type-label-sm-size);
  color: var(--nb-c-text-subtle);

  &__link {
    color: var(--nb-c-primary);
  }
}
</style>

<template>
  <NbBadge :variant="meta.badge" :size="size" dot>{{ meta.label }}</NbBadge>
</template>

<script setup lang="ts">
/**
 * A goal's status, always as words with a dot. The colour helps a scan; the
 * label is what carries it, so nobody has to tell amber from red to know a
 * goal is off track.
 */
import { computed } from 'vue'
import { goalStatus } from '@/lib/goals'

const props = withDefaults(
  defineProps<{ status: string; size?: 'sm' | 'md' }>(),
  { size: 'sm' },
)

const meta = computed(() => goalStatus(props.status))
</script>

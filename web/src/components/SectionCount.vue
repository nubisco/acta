<template>
  <NbBadge
    v-nb-tooltip="{ body: tip }"
    size="sm"
    variant="grey"
    class="section-count"
    :class="{ 'section-count--empty': empty }"
    :aria-label="tip"
  >
    {{ text }}
  </NbBadge>
</template>

<script setup lang="ts">
/**
 * The count beside a section's name, in a pill that says what it counts.
 * A bare number next to "Plan" read as nothing at all (Jose, 2026-10-08), so
 * every count is a pill, and hovering one says what the number is.
 */
defineProps<{
  text: string
  /** What the number means, in words. Also the accessible name. */
  tip: string
  /** Nothing counted: drawn dimmed, still in its place. */
  empty?: boolean
}>()
</script>

<style scoped lang="scss">
.section-count {
  font-variant-numeric: tabular-nums;
}

.section-count--empty {
  opacity: 0.6;
}
</style>

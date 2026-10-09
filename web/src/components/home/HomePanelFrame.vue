<template>
  <!-- One frame for every Home panel, so each has a title, says what it is
       for, and loads and empties the same way. -->
  <NbPanel class="home-panel">
    <header class="home-panel__head">
      <h2 class="type-heading-02">{{ title }}</h2>
      <NbInfoHint
        :size="16"
        :label="`About ${title}`"
        :title="title"
        :text="info"
      />
      <span class="home-panel__grow" />
      <slot name="actions" />
    </header>
    <NbSkeleton
      v-if="loading"
      variant="block"
      height="7rem"
      :label="`Loading ${title}`"
    />
    <NbEmptyState
      v-else-if="empty"
      size="sm"
      :title="emptyTitle"
      :description="emptyText"
    />
    <slot v-else />
  </NbPanel>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  /** What the panel shows and why, for its (i). */
  info: string
  loading: boolean
  empty: boolean
  emptyTitle: string
  emptyText?: string
}>()
</script>

<style scoped lang="scss">
.home-panel {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-12);
  min-inline-size: 0;

  &__head {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);

    h2 {
      margin: 0;
    }
  }

  &__grow {
    flex: 1;
  }
}
</style>

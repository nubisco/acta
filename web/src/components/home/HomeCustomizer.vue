<template>
  <div class="home-customizer">
    <header class="home-customizer__head">
      <h2 class="type-heading-02">Customize Home</h2>
      <NbButton
        size="sm"
        variant="primary"
        @click="layout.editing.value = false"
      >
        Done
      </NbButton>
    </header>
    <p class="home-customizer__lede">
      Drag the panels into the order you want, or pick one up with Space and
      move it with the arrow keys. Switch off what you do not need, and make a
      panel wide to give it the whole row. Your layout is saved on your account,
      so it is the same in every browser.
    </p>

    <NbReorderList
      :model-value="layout.panels.value"
      item-key="id"
      label="Home panels"
      handle
      @update:model-value="layout.setPanels($event as IHomePanelPlace[])"
    >
      <template #default="{ item }">
        <div
          class="home-customizer__row"
          :class="{ 'home-customizer__row--off': item.hidden }"
        >
          <span class="home-customizer__what">
            <span class="home-customizer__title">{{
              defOf(item.id)?.title
            }}</span>
            <span class="home-customizer__desc">{{
              defOf(item.id)?.description
            }}</span>
          </span>
          <NbButton
            v-nb-tooltip="{
              body: item.wide ? 'Make it half width' : 'Give it the whole row',
            }"
            size="xs"
            :variant="item.wide ? 'secondary' : 'ghost'"
            icon="arrows-out-line-horizontal"
            :aria-pressed="item.wide"
            :aria-label="`${defOf(item.id)?.title}: wide`"
            :disabled="item.hidden"
            @click="layout.update(item.id, { wide: !item.wide })"
          />
          <NbSwitch
            v-nb-tooltip="{
              body: defOf(item.id)?.required
                ? 'Next up is what Home is for, so it stays. Move it anywhere.'
                : item.hidden
                  ? 'Show it on Home'
                  : 'Hide it from Home',
            }"
            :name="`home-panel-${item.id}`"
            :label="`Show ${defOf(item.id)?.title}`"
            hide-label
            size="sm"
            :model-value="!item.hidden"
            :disabled="defOf(item.id)?.required"
            @update:model-value="layout.update(item.id, { hidden: !$event })"
          />
        </div>
      </template>
    </NbReorderList>

    <NbButton
      size="sm"
      variant="ghost"
      icon="arrow-counter-clockwise"
      :disabled="!layout.custom.value"
      @click="confirmReset"
    >
      Reset to the default layout
    </NbButton>
  </div>
</template>

<script setup lang="ts">
/**
 * Arranging Home, in the inspector beside it (Jose, 2026-10-09). Changes show
 * on the page as they are made and are saved a moment later.
 */
import { useConfirm } from '@nubisco/ui'
import { useHomeLayout } from '@/composables/useHomeLayout'
import { HOME_PANELS, type IHomePanelPlace } from '@/lib/homePanels'

const layout = useHomeLayout()
const confirm = useConfirm()

const defOf = (id: string) => HOME_PANELS.find((p) => p.id === id)

async function confirmReset(): Promise<void> {
  await confirm({
    title: 'Reset Home?',
    message:
      'Home goes back to the default panels, in the default order. Your own arrangement is forgotten.',
    confirmLabel: 'Reset Home',
    cancelLabel: 'Keep it',
    tone: 'neutral',
    onConfirm: () => layout.reset(),
  })
}
</script>

<style scoped lang="scss">
.home-customizer {
  display: grid;
  gap: var(--nb-spacing-16);
  padding: var(--nb-spacing-12);
  align-content: start;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-8);

    h2 {
      margin: 0;
    }
  }

  &__lede {
    margin: 0;
    color: var(--nb-c-text-muted);
    font-size: var(--nb-type-body-sm-size);
  }

  &__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--nb-spacing-8);
    inline-size: 100%;

    &--off .home-customizer__what {
      opacity: 0.55;
    }
  }

  &__what {
    display: grid;
    min-inline-size: 0;
  }

  &__title {
    font-size: var(--nb-type-label-lg-size);
    font-weight: var(--nb-type-label-lg-weight);
  }

  &__desc {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }
}
</style>

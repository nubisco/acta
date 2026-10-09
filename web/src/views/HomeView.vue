<template>
  <div class="home">
    <!-- Good morning first, then the one line that says what is waiting:
         the question people open Home with (Jose, 2026-10-09). Fixed: the
         panels below move, the greeting does not. -->
    <header class="home__greeting">
      <h1 class="type-heading-03">{{ greeting }}</h1>
      <p class="home__summary">{{ nextUp.summary.value }}</p>
    </header>

    <component :is="actions.Outlet">
      <NbButton
        v-nb-tooltip="{
          body: layout.editing.value
            ? 'Close the customizer'
            : 'Choose and arrange what Home shows',
        }"
        size="sm"
        :variant="layout.editing.value ? 'secondary' : 'ghost'"
        icon="sliders-horizontal"
        :aria-pressed="layout.editing.value"
        @click="layout.editing.value = !layout.editing.value"
      >
        Customize
      </NbButton>
      <NbButton
        size="sm"
        variant="primary"
        icon="plus"
        @click="ui.newSpaceOpen.value = true"
      >
        Create space
      </NbButton>
    </component>

    <!-- The panels, in the order this person chose. Wide ones take the full
         row, the rest sit two to a row on a wide screen. -->
    <div
      class="home__panels"
      :class="{ 'home__panels--editing': layout.editing.value }"
    >
      <div
        v-for="panel in shown"
        :key="panel.id"
        class="home__panel"
        :class="{ 'home__panel--wide': panel.wide }"
        :data-panel="panel.id"
      >
        <component :is="PANEL_COMPONENTS[panel.id]" />
      </div>
    </div>

    <p class="home__activity">
      <NbButton
        size="sm"
        variant="ghost"
        icon="pulse"
        :href="wpath('/activity')"
      >
        See everything happening in this workspace
      </NbButton>
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * Home: a greeting, then the panels this person arranged it into (see
 * lib/homePanels.ts and the customizer in the inspector).
 */
import { computed, onBeforeUnmount, onMounted, type Component } from 'vue'
import { useShellSlot } from '@nubisco/ui'
import { useUiState, useWorkspace } from '@/stores/workspace'
import { useHomeLayout } from '@/composables/useHomeLayout'
import { useNextUp } from '@/composables/useNextUp'
import { wpath } from '@/lib/paths'
import NextUpPanel from '@/components/NextUpPanel.vue'
import HomeGoalsPanel from '@/components/goals/HomeGoalsPanel.vue'
import HomeBehindPanel from '@/components/home/HomeBehindPanel.vue'
import HomeAttentionPanel from '@/components/home/HomeAttentionPanel.vue'
import HomeDocsPanel from '@/components/home/HomeDocsPanel.vue'
import HomeRecentPanel from '@/components/home/HomeRecentPanel.vue'
import HomeSpacesPanel from '@/components/home/HomeSpacesPanel.vue'

const PANEL_COMPONENTS: Record<string, Component> = {
  'next-up': NextUpPanel,
  goals: HomeGoalsPanel,
  behind: HomeBehindPanel,
  attention: HomeAttentionPanel,
  docs: HomeDocsPanel,
  recent: HomeRecentPanel,
  spaces: HomeSpacesPanel,
}

const ws = useWorkspace()
const ui = useUiState()
const actions = useShellSlot('topbar-right')
const layout = useHomeLayout()
const nextUp = useNextUp()

const shown = computed(() =>
  layout.panels.value.filter((p) => !p.hidden && PANEL_COMPONENTS[p.id]),
)

const greeting = computed(() => {
  const hour = new Date().getHours()
  const part =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const name = ws.me.value?.name?.split(/\s+/)[0]
  return name ? `${part}, ${name}` : part
})

onMounted(() => void layout.load())
// Customizing belongs to Home: leaving it closes the customizer.
onBeforeUnmount(() => (layout.editing.value = false))
</script>

<style scoped lang="scss">
.home {
  display: grid;
  gap: var(--nb-spacing-24);
  align-content: start;

  &__greeting {
    display: grid;
    gap: var(--nb-spacing-4);

    h1 {
      margin: 0;
    }
  }

  &__summary {
    margin: 0;
    color: var(--nb-c-text-muted);
  }

  &__panels {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--nb-spacing-24);
    align-items: start;

    @media (max-width: 64rem) {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  &__panel {
    min-inline-size: 0;

    &--wide {
      grid-column: 1 / -1;
    }
  }

  /* While customizing, each panel is outlined so the arrangement reads at a
     glance, and nothing inside it can be clicked by accident. */
  &__panels--editing &__panel {
    outline: 1px dashed var(--nb-c-border-strong, var(--nb-c-border));
    outline-offset: 4px;
    border-radius: var(--nb-radius-panel, 4px);

    > :deep(*) {
      pointer-events: none;
    }
  }

  &__activity {
    display: grid;
    justify-items: start;
    margin: 0;
  }
}
</style>

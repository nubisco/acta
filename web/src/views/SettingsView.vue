<template>
  <div class="settings">
    <h1 class="type-heading-03">Settings</h1>

    <component :is="filterBar.Outlet">
      <NbTabs
        v-model="tab"
        :items="tabs"
        aria-label="Settings sections"
        variant="line"
      />
    </component>

    <SettingsPeople v-if="tab === 'people'" />
    <SettingsLabels v-else-if="tab === 'labels'" />
    <SettingsAutomation v-else-if="tab === 'automation'" />
    <SettingsAccount v-else-if="tab === 'account'" />
  </div>
</template>

<script setup lang="ts">
/**
 * Settings, grouped by what someone is trying to do.
 *
 * The seven tabs this replaces were named after mechanisms (Members, Labels,
 * Connections, Webhooks, Rules, Ingest, Access tokens), which left four
 * different credentials scattered across four tabs with nothing explaining
 * how they differ, and put contact-form bots in a list headed "Members".
 *
 * Four groups now, by intent: who can sign in, how work is labelled, what
 * runs without a person, and what belongs to you alone. Your account is last
 * and is the only one a non-admin can act in.
 *
 * Each section owns its own data and dialogs. This view is only the switch,
 * which is why it is short: the old one had grown past a thousand lines with
 * every section's state interleaved in a single script block.
 */
import { ref } from 'vue'
import { useShellSlot } from '@nubisco/ui'
import SettingsPeople from '@/components/settings/SettingsPeople.vue'
import SettingsLabels from '@/components/settings/SettingsLabels.vue'
import SettingsAutomation from '@/components/settings/SettingsAutomation.vue'
import SettingsAccount from '@/components/settings/SettingsAccount.vue'

const filterBar = useShellSlot('fixedbar')

const tab = ref('people')
const tabs = [
  { id: 'people', label: 'People' },
  { id: 'labels', label: 'Labels' },
  { id: 'automation', label: 'Automation' },
  { id: 'account', label: 'Your account' },
]
</script>

<style scoped lang="scss">
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);
  padding-block-end: var(--nb-spacing-32);
}
</style>

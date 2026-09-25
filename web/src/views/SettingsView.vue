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
    <SettingsWorkspace v-else-if="tab === 'workspace' && ws.isAdmin.value" />
    <SettingsLabels v-else-if="tab === 'labels'" />
    <SettingsAutomation v-else-if="tab === 'automation'" />
    <SettingsNotifications v-else-if="tab === 'notifications'" />
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
 * Six groups now, by intent: who can sign in, what the whole workspace is
 * ruled by, how work is labelled, what runs without a person, what reaches
 * you, and what belongs to you alone. The last two are the ones a non-admin
 * can act in.
 *
 * Workspace is the sixth, and admin-only, so it is not offered to anyone who
 * would only be told no. It exists because a workspace-wide rule is not a
 * rule about people, labels or automation, and putting the first one
 * (who may delete a comment) into People would have meant filing a policy
 * under a list of members. It is the home for the ones that follow.
 *
 * Notifications are a personal setting and could have sat inside Your
 * account, which is where tokens and connected apps live. They have a tab of
 * their own because that is the word somebody uses when they go looking:
 * nobody hunting for "stop emailing me" opens a page headed Access tokens.
 *
 * Each section owns its own data and dialogs. This view is only the switch,
 * which is why it is short: the old one had grown past a thousand lines with
 * every section's state interleaved in a single script block.
 */
import { computed, ref } from 'vue'
import { useShellSlot } from '@nubisco/ui'
import { useWorkspace } from '@/stores/workspace'
import SettingsPeople from '@/components/settings/SettingsPeople.vue'
import SettingsWorkspace from '@/components/settings/SettingsWorkspace.vue'
import SettingsLabels from '@/components/settings/SettingsLabels.vue'
import SettingsAutomation from '@/components/settings/SettingsAutomation.vue'
import SettingsNotifications from '@/components/settings/SettingsNotifications.vue'
import SettingsAccount from '@/components/settings/SettingsAccount.vue'

const filterBar = useShellSlot('fixedbar')
const ws = useWorkspace()

const tab = ref('people')
const tabs = computed(() => [
  { id: 'people', label: 'People' },
  ...(ws.isAdmin.value ? [{ id: 'workspace', label: 'Workspace' }] : []),
  { id: 'labels', label: 'Labels' },
  { id: 'automation', label: 'Automation' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'account', label: 'Your account' },
])
</script>

<style scoped lang="scss">
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);
  padding-block-end: var(--nb-spacing-32);
}
</style>

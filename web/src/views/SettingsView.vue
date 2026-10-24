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
    <SettingsAiBriefings
      v-else-if="tab === 'ai-briefings' && ws.isAdmin.value"
    />
    <SettingsBilling
      v-else-if="tab === 'billing' && ws.isAdmin.value && ws.plansEnabled.value"
    />
    <SettingsLabels v-else-if="tab === 'labels'" />
    <SettingsAutomation v-else-if="tab === 'automation'" />
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
 * Grouped by intent: who can sign in, what the whole workspace is ruled
 * by, how work is labelled, and what runs without a person.
 *
 * Workspace is admin-only, so it is not offered to anyone who
 * would only be told no. It exists because a workspace-wide rule is not a
 * rule about people, labels or automation, and putting the first one
 * (who may delete a comment) into People would have meant filing a policy
 * under a list of members. It is the home for the ones that follow.
 *
 * What is yours alone (notifications, walkthroughs, your account) is not
 * here. It is in the user menu, under Your settings, because the fleet keeps
 * each level of settings in one place: the person in the user menu, the
 * workspace under the gear. The router sends an old link to one of those
 * tabs to its new page.
 *
 * Each section owns its own data and dialogs. This view is only the switch,
 * which is why it is short: the old one had grown past a thousand lines with
 * every section's state interleaved in a single script block.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useShellSlot } from '@nubisco/ui'
import { useWorkspace } from '@/stores/workspace'
import SettingsPeople from '@/components/settings/SettingsPeople.vue'
import SettingsWorkspace from '@/components/settings/SettingsWorkspace.vue'
import SettingsLabels from '@/components/settings/SettingsLabels.vue'
import SettingsAutomation from '@/components/settings/SettingsAutomation.vue'
import SettingsAiBriefings from '@/components/settings/SettingsAiBriefings.vue'
import SettingsBilling from '@/components/settings/SettingsBilling.vue'

const filterBar = useShellSlot('fixedbar')
const ws = useWorkspace()

const route = useRoute()
const router = useRouter()

const tabs = computed(() => [
  { id: 'people', label: 'People' },
  ...(ws.isAdmin.value
    ? [
        { id: 'workspace', label: 'Workspace' },
        { id: 'ai-briefings', label: 'AI briefings' },
        // Only where workspaces have plans (the hosted service, LA-399).
        ...(ws.plansEnabled.value
          ? [{ id: 'billing', label: 'Plan and billing' }]
          : []),
      ]
    : []),
  { id: 'labels', label: 'Labels' },
  { id: 'automation', label: 'Automation' },
])

/**
 * The tab is in the URL, so a link (the bell's settings button, a
 * walkthrough that ends here) can land on the right one, and a reload stays
 * where it was.
 */
/** Tabs folded into another, so an old link still lands on the right one. */
const MOVED_TABS: Record<string, string> = { 'daily-report': 'ai-briefings' }

function tabFrom(raw: unknown): string {
  if (typeof raw === 'string' && raw in MOVED_TABS) raw = MOVED_TABS[raw]
  return typeof raw === 'string' && tabs.value.some((t) => t.id === raw)
    ? raw
    : 'people'
}

const tab = ref(tabFrom(route.query.tab))
// Tabs that depend on the instance (Plan and billing) arrive with its config,
// which may land after this view: a link to one of them waits for it.
watch([() => route.query.tab, tabs], ([raw]) => (tab.value = tabFrom(raw)))
watch(tab, (id) => {
  if (route.query.tab === id) return
  void router.replace({ query: { ...route.query, tab: id } })
})
</script>

<style scoped lang="scss">
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);
  padding-block-end: var(--nb-spacing-32);
}
</style>

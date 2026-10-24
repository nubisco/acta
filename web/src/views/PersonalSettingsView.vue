<template>
  <div class="settings">
    <h1 class="type-heading-03">Your settings</h1>

    <component :is="filterBar.Outlet">
      <NbTabs
        v-model="tab"
        :items="tabs"
        aria-label="Your settings sections"
        variant="line"
      />
    </component>

    <SettingsNotifications v-if="tab === 'notifications'" />
    <SettingsWalkthroughs v-else-if="tab === 'walkthroughs'" />
    <SettingsAccount v-else-if="tab === 'account'" />
  </div>
</template>

<script setup lang="ts">
/**
 * What belongs to the person alone, reached from the user menu.
 *
 * These tabs used to sit under the workspace's Settings, beside People and
 * Automation. The fleet keeps three levels of settings, each in one place:
 * the person in the user menu, the tenant under the gear at the foot of the
 * rail, the child on the child. A person looking for "stop emailing me"
 * opens their own menu, not the page that manages everybody else.
 *
 * Notifications come first because that is the word somebody uses when they
 * go looking, and the bell's own settings button lands here. Theme stays in
 * the user menu itself, one click away.
 *
 * The router redirects `/settings?tab=notifications` (and the other two) to
 * this page, so a bookmark from before the move still lands.
 */
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useShellSlot } from '@nubisco/ui'
import SettingsNotifications from '@/components/settings/SettingsNotifications.vue'
import SettingsAccount from '@/components/settings/SettingsAccount.vue'
import SettingsWalkthroughs from '@/components/settings/SettingsWalkthroughs.vue'

const filterBar = useShellSlot('fixedbar')
const route = useRoute()
const router = useRouter()

const tabs = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'walkthroughs', label: 'Walkthroughs' },
  { id: 'account', label: 'Your account' },
]

/**
 * The tab is in the URL, so a link (the bell's settings button, a
 * walkthrough that ends here) can land on the right one, and a reload stays
 * where it was.
 */
function tabFrom(raw: unknown): string {
  return typeof raw === 'string' && tabs.some((t) => t.id === raw)
    ? raw
    : 'notifications'
}

const tab = ref(tabFrom(route.query.tab))
watch(
  () => route.query.tab,
  (raw) => (tab.value = tabFrom(raw)),
)
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

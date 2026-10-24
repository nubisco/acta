<template>
  <RouterView v-if="frameless" />

  <NbShell
    v-else
    ref="shell"
    v-model:inspector-visible="inspectorVisible"
    :sidebar-variant="sidebarVariant"
    sidebar-header-action-position="start"
    sidebar-header-action-compact="swap"
    sidebar-label="Acta sections"
    inspector-size="md"
    inspector-label="Item"
    contextbar-label="Documents"
    collapse-at="md"
    :topbar="docChrome.frameHidden.value ? 'never' : 'auto'"
    resizable
  >
    <!-- Page focus mode on a document takes the rail and the topbar away. -->
    <template v-if="!docChrome.frameHidden.value" #sidebar-logo>
      <!-- The brand is only the brand. Switching workspace is the first
           entry in the rail, because with the toggle swapped onto the
           collapsed brand under the pointer, the brand cannot also open a
           menu. -->
      <NbSidebarBrand title="Acta">
        <template #icon>
          <img class="brand-mark" src="/acta-icon.svg" alt="" />
        </template>
      </NbSidebarBrand>
    </template>

    <!-- The rail collapses from the top, beside the brand (the fleet
         standard). The shell drops this on a phone, where the topbar's nav
         button opens the drawer instead. -->
    <template v-if="!docChrome.frameHidden.value" #sidebar-header-action>
      <NbSidebarHeaderToggle @toggle="nav.toggle" />
    </template>

    <template v-if="!docChrome.frameHidden.value" #sidebar-nav>
      <RailNav :compact="sidebarVariant === 'compact'" />
    </template>

    <!-- The foot of the rail in the fleet's order: Documentation,
         Notifications, the workspace's Settings, then the person. -->
    <template v-if="!docChrome.frameHidden.value" #sidebar-bottom>
      <!-- Acta's docs are public, so this is a link out rather than a route.
           The menu item has no `target`, so the new tab is opened here:
           stepping out to read the docs must not lose the card open here. -->
      <NbSidebarMenu density="compact">
        <NbSidebarMenuItem
          label="Documentation"
          icon="book"
          :href="DOCS_URL"
          @click.prevent="openDocs"
        />
      </NbSidebarMenu>
      <NotificationBell v-nb-tour-step="'notifications'" />
      <NbSidebarMenu density="compact">
        <NbSidebarMenuItem
          label="Settings"
          icon="gear"
          :to="wpath('/settings')"
          :active="route.name === 'settings'"
        />
      </NbSidebarMenu>
      <NbUserMenu
        v-if="ws.me.value"
        :user="{
          email: ws.me.value.email ?? ws.me.value.handle,
          name: ws.me.value.name,
          picture: ws.me.value.picture,
        }"
        :brand="ws.signsInThroughNubisco.value ? 'footer' : 'none'"
        :accounts="accounts.accounts.value"
        :accounts-unknown="accounts.accountsUnknown.value"
        :show-account-actions="ws.signsInThroughNubisco.value"
        :show-profile="ws.platformUrl.value !== null"
        :placement="phone ? 'top-start' : 'right-end'"
        trigger="identity"
        show-theme
        @open="loadAccounts"
        @switch="accounts.switchTo"
        @switch-account="accounts.chooseAccount"
        @add-account="accounts.addAccount"
        @remove="removeAccount"
        @profile="openProfile"
        @sign-out="signOut"
      >
        <template #default="{ close }">
          <!-- The design system's slot for product rows, and the person's
             level of the fleet's three settings levels: notifications,
             walkthroughs, tokens and connected apps. -->
          <NbMenuItem
            icon="user-gear"
            label="Your settings"
            @select="openPersonalSettings(close)"
          />
        </template>
      </NbUserMenu>
    </template>

    <template #notification>
      <NbBanner
        v-if="ws.connectionDown.value"
        status="warning"
        variant="callout"
        flush
        title="Reconnecting"
      >
        Live updates are interrupted; changes still save.
      </NbBanner>
    </template>

    <template #topbar-left>
      <!-- The workspace leads every trail, the way an org does on GitHub, so
           you can always see which one you are looking at. -->
      <NbBreadcrumbs
        v-if="trail.length > 0"
        :title="namespace"
        collapse="phone"
      >
        <RouterLink
          v-for="crumb in trail.slice(0, -1)"
          :key="crumb.to ?? crumb.text"
          :to="crumb.to ?? wpath('/')"
        >
          {{ crumb.text }}
        </RouterLink>
        <span aria-current="page">{{ trail[trail.length - 1].text }}</span>
      </NbBreadcrumbs>
    </template>

    <template #topbar-right>
      <GlobalSearch v-nb-tour-step="'topbar-search'" />
    </template>

    <RouterView />

    <template #inspector>
      <ItemInspector
        v-if="inspector.itemKey.value"
        :item-key="inspector.itemKey.value"
      />
      <HomeCustomizer v-else-if="homeLayout.editing.value" />
    </template>
  </NbShell>

  <NewSpaceModal
    :open="ui.newSpaceOpen.value"
    @close="ui.newSpaceOpen.value = false"
    @created="onSpaceCreated"
  />
  <GoalFormModal
    :open="ui.newGoal.value !== null"
    :parent="ui.newGoal.value?.parent ?? null"
    @close="ui.newGoal.value = null"
    @saved="onGoalCreated"
  />
  <!-- A phone has one size for a card: the sheet already fills the screen,
       so ?full=1 opens the same sheet rather than a dialog inside it. -->
  <ItemModal
    v-if="inspector.full.value && inspector.itemKey.value && !phone"
    :open="true"
    :item-key="inspector.itemKey.value"
    @close="inspector.dismiss()"
  />
  <DocPreviewModal />
  <!-- One overlay for both questions: what can I do, and where is that
       thing. The suggester is asked as you type, debounced and race-guarded
       by the component itself. -->
  <NbCommandPalette
    placeholder="Search Acta, or type a command..."
    :suggest="suggestFromWorkspace"
  />
  <WelcomeModal
    v-if="welcomeOpen && ws.me.value"
    :open="welcomeOpen"
    :actor-id="ws.me.value.id"
    :handle="ws.me.value.handle"
    :name="ws.me.value.name"
    @done="onWelcomeDone"
  />
  <!-- Controlled rather than auto-start: the welcome has to have been
       answered first, or the tour spotlights the shell through a modal
       covering it. -->
  <template v-if="!frameless">
    <NbWalkthrough
      :walkthrough="introTour"
      :controller="tour"
      :labels="tourLabels"
    />
    <NbWalkthrough
      :walkthrough="goalsTour"
      :controller="tours.controllers.goals"
      :labels="tourLabels"
    />
    <NbWalkthrough
      :walkthrough="notificationsTour"
      :controller="tours.controllers.notifications"
      :labels="tourLabels"
    />
  </template>
  <NbToaster />
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useCommandPalette,
  usePhoneLayout,
  useSidebarVariant,
  useTheme,
} from '@nubisco/ui'
import type { IUserMenuAccount, NbShell } from '@nubisco/ui'
import { useAccounts } from '@/stores/accounts'
import { goalsTour, introTour, notificationsTour, tourLabels } from '@/lib/tour'
import { setTourNavigator, useTours } from '@/lib/tours'
import {
  historyPosition,
  useInspector,
  useUiState,
  useWorkspace,
} from '@/stores/workspace'
import ItemInspector from '@/components/ItemInspector.vue'
import HomeCustomizer from '@/components/home/HomeCustomizer.vue'
import { useHomeLayout } from '@/composables/useHomeLayout'
import ItemModal from '@/components/ItemModal.vue'
import DocPreviewModal from '@/components/DocPreviewModal.vue'
import GlobalSearch from '@/components/GlobalSearch.vue'
import NewSpaceModal from '@/components/NewSpaceModal.vue'
import GoalFormModal from '@/components/goals/GoalFormModal.vue'
import NotificationBell from '@/components/NotificationBell.vue'
import RailNav from '@/components/RailNav.vue'
import WelcomeModal from '@/components/WelcomeModal.vue'
import { wpath } from '@/lib/paths'
import { createPaletteSuggester } from '@/lib/paletteSearch'
import { useDocChrome } from '@/lib/docChrome'

const route = useRoute()
const router = useRouter()
const ws = useWorkspace()
const inspector = useInspector()
const homeLayout = useHomeLayout()
const ui = useUiState()
const palette = useCommandPalette()
const docChrome = useDocChrome()
const suggestFromWorkspace = createPaletteSuggester({
  router,
  openItem: (key) => inspector.open(key),
})
const theme = useTheme()
const accounts = useAccounts()

// Read when the menu opens rather than at boot: the list changes whenever the
// person signs an account in or out on another Nubisco app.
function loadAccounts(): void {
  if (!ws.signsInThroughNubisco.value) return
  void accounts.load(ws.platformUrl.value, ws.me.value)
}

function removeAccount(account: IUserMenuAccount): void {
  void accounts.remove(account, ws.platformUrl.value, ws.me.value)
}

// The profile lives on the provider, one page for every app that signs in
// through it. A new tab, so leaving to change a picture does not lose the
// work open here.
function openProfile(): void {
  const base = ws.platformUrl.value
  if (!base) return
  window.open(new URL('/profile', base).toString(), '_blank', 'noopener')
}

// One subdomain, one prefix per project (see "Documentation sites" in the
// workspace AGENTS.md).
const DOCS_URL = 'https://docs.nubisco.io/acta/'
function openDocs(): void {
  window.open(DOCS_URL, '_blank', 'noopener')
}

function openPersonalSettings(close: () => void): void {
  close()
  void router.push(wpath('/me'))
}

const shell = ref<InstanceType<typeof NbShell> | null>(null)
const tours = useTours()
const tour = tours.controllers.intro
setTourNavigator((to) => router.push(wpath(to)))

const welcomeOpen = ref(false)
// The welcome has the screen while it is open, so no walkthrough starts
// under it.
watch(welcomeOpen, (open) => (tours.held.value = open), { immediate: true })

/**
 * The welcome comes first and the tour second, never both at once: a tour
 * spotlighting the shell through a modal covering it shows nothing.
 *
 * Someone who has already been welcomed can still meet the tour, because it
 * is version-gated: bumping the tour shows it once to everyone, which is how
 * an existing workspace hears about a shell that has changed under them.
 */
watch(
  () => ws.me.value,
  (me) => {
    if (!me) return
    if (me.onboarded === false) welcomeOpen.value = true
    else void tour.maybeAutoStart()
  },
  { immediate: true },
)

/**
 * Put the person somewhere the tour can point at before starting it. Several
 * steps live on a space, and a step whose target is not on screen is dropped,
 * so a tour started from the home page would silently be half a tour.
 */
async function goToATour(): Promise<void> {
  if (route.name !== 'space' && spaces.value[0]) {
    await router.push(wpath(`/s/${spaces.value[0].key}`))
  }
  await nextTick()
}

async function startTour(): Promise<void> {
  await goToATour()
  await tour.restart()
}

async function onWelcomeDone(wantsTour: boolean): Promise<void> {
  welcomeOpen.value = false
  if (!wantsTour) {
    // Recorded as skipped rather than left untouched, or the tour would
    // ambush them on the next page load having just been declined.
    await tour.skip()
    return
  }
  await goToATour()
  tour.start()
}

router.afterEach(() => {
  requestAnimationFrame(() => shell.value?.focusMain())
})

// Expanded or collapsed is the person's choice, remembered across visits and
// never derived from the route (the fleet standard).
// On a phone the sidebar is a drawer over the page, and a drawer of bare
// icons whose names live in hover tooltips cannot be read by touch, so it is
// always the labelled one there.
const { phone } = usePhoneLayout()
const nav = useSidebarVariant({ storageKey: 'acta.sidebar' })
const sidebarVariant = computed(() =>
  phone.value ? 'verbose' : nav.variant.value,
)
// A drawer that stays open after you chose where to go covers the place you
// went. The shell closes it when a link inside it is used; this catches the
// rest (a notification, a card's link to its board, Back).
watch(
  () => route.fullPath,
  () => {
    if (!phone.value) return
    shell.value?.setSidebarOpen(false)
    shell.value?.setContextbarOpen?.(false)
  },
)

/**
 * The workspace list is the app's entry point, frameless, while no workspace
 * has been entered. Reached from the rail once one has, it is a page in the
 * frame like any other, so the rail stays put and the way back is one click.
 * WorkspacesView reads the same condition.
 */
const frameless = computed(
  () =>
    route.meta.frameless === true &&
    !(route.name === 'workspaces' && ws.workspaceSlug.value !== ''),
)

const spaces = computed(() =>
  (ws.overview.value?.spaces ?? []).filter((b) => !b.archived),
)

interface ICrumb {
  text: string
  to?: string
}

/**
 * A slug segment as a heading. App.vue does not hold the docs tree, so the
 * real title is not reachable here; turning "release-notes" into "Release
 * notes" is honest and reads far better than the raw slug.
 */
function humaniseSlug(part: string): string {
  const words = part.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The workspace name, which leads the breadcrumb trail on every route. Not on
 * the workspace list, which is above any one workspace.
 */
const namespace = computed(() =>
  route.name === 'workspaces'
    ? 'Acta'
    : (ws.overview.value?.workspace.name ?? 'Acta'),
)

const trail = computed<ICrumb[]>(() => {
  if (route.meta.crumb === 'space') {
    const key = String(route.params.spaceKey ?? '')
    const space = spaces.value.find((b) => b.key === key)
    return [{ text: 'Spaces', to: wpath('/') }, { text: space?.name ?? key }]
  }
  if (route.meta.crumb === 'space-settings') {
    const key = String(route.params.spaceKey ?? '')
    const space = ws.overview.value?.spaces.find((b) => b.key === key)
    return [
      { text: 'Spaces', to: wpath('/') },
      { text: space?.name ?? key, to: wpath(`/s/${key}`) },
      { text: 'Settings' },
    ]
  }
  if (route.meta.crumb === 'goal') {
    const number = Number(String(route.params.goal ?? '').replace(/^G-/i, ''))
    const goal = ws.overview.value?.goals?.find((g) => g.number === number)
    return [
      { text: 'Goals', to: wpath('/goals') },
      { text: goal ? `${goal.key} ${goal.title}` : `G-${number}` },
    ]
  }
  if (route.meta.crumb === 'docs') {
    const slug = String(route.params.slug ?? '')
    const crumbs: ICrumb[] = [{ text: 'Docs', to: wpath('/docs') }]
    const parts = slug ? slug.split('/') : []
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/')
      crumbs.push({
        text: humaniseSlug(part),
        to: index < parts.length - 1 ? wpath(`/docs/${path}`) : undefined,
      })
    })
    return crumbs
  }
  // Every other route is one level deep, and still needs the namespace in
  // front of it: Settings, Activity and Docs previously rendered no trail at
  // all, so the topbar was simply empty.
  const named: Record<string, string> = {
    home: 'Home',
    workspaces: 'Workspaces',
    settings: 'Settings',
    activity: 'Activity',
    goals: 'Goals',
    search: 'Search',
  }
  const name = String(route.name ?? '')
  return named[name] ? [{ text: named[name] }] : []
})

const inspectorVisible = ref(false)
// The side panel shows a card and nothing else. Filters used to share it,
// which meant the two could never be open together and the shell had to be
// told which one it was holding; they live in the space's own toolbar now.
// The panel shows the card at its side size. At full size the same card is
// on view, in the dialog, so the panel steps aside without closing it.
watch(
  [inspector.itemKey, inspector.full, homeLayout.editing, phone],
  ([key, full, editing, onPhone]) => {
    inspectorVisible.value = (key !== null && (!full || onPhone)) || editing
  },
)
watch(
  () => route.name,
  () => {
    if (!inspector.itemKey.value) inspectorVisible.value = false
  },
  { immediate: true },
)
watch(inspectorVisible, (visible) => {
  if (visible) return
  // Closing the panel closes whatever it held: a card, or the customizer.
  if (homeLayout.editing.value && !inspector.itemKey.value)
    homeLayout.editing.value = false
  if (!inspector.full.value || phone.value) inspector.dismiss()
})

async function signOut(): Promise<void> {
  await ws.logout()
  void router.push({ name: 'login' })
}

function onGoalCreated(number: number): void {
  ui.newGoal.value = null
  ui.goalsVersion.value += 1
  void router.push(wpath(`/goals/${number}`))
}

function onSpaceCreated(key: string): void {
  ui.newSpaceOpen.value = false
  void router.push(wpath(`/s/${key}`))
}

// Deep-linkable card view: the open card lives in the URL as ?item=KEY, and
// its full size as &full=1, so what you are looking at is what you share and
// what a reload brings back. Both directions sync with an equality guard so
// neither watcher re-triggers the other.
watch(
  () => [route.query.item, route.query.full] as const,
  ([raw, fullRaw]) => {
    const target = typeof raw === 'string' && raw ? raw : null
    const full = target !== null && fullRaw === '1'
    if (target !== inspector.itemKey.value || full !== inspector.full.value) {
      if (target) inspector.restore(target, full)
      else inspector.close()
    }
  },
  { immediate: true },
)
watch([inspector.itemKey, inspector.full], ([key, full]) => {
  const current = typeof route.query.item === 'string' ? route.query.item : null
  const currentFull = route.query.full === '1'
  if ((key ?? null) === current && (Boolean(key) && full) === currentFull)
    return
  // Forward hops PUSH so browser Back walks the chain the reader followed.
  // Size changes, trail-backs and closes REPLACE so none of them duplicates
  // the history or resurrects a closed card.
  const navigate =
    key && inspector.navMode.value === 'push' ? router.push : router.replace
  inspector.navMode.value = 'push'
  void navigate({
    query: {
      ...route.query,
      item: key ?? undefined,
      full: key && full ? '1' : undefined,
    },
  })
})
// "Back" in the card's trail. When the entry right behind this one is the
// trail's tail, it IS that step in history, so take it: replacing instead left
// a duplicate behind, and the next browser Back appeared to do nothing. The
// route watcher above then pops the trail.
// Closing a card opened right here (no hops since) steps back to the entry
// it was opened from, so Back afterwards leaves the page instead of landing
// on a copy of it. Anything else closes in place.
watch(inspector.dismissRequest, () => {
  const base = inspector.baseAt.value
  if (
    base >= 0 &&
    inspector.trail.value.length === 0 &&
    historyPosition() === base + 1
  )
    router.back()
  else inspector.close()
})
watch(inspector.backRequest, () => {
  const tailAt = inspector.trailAt.value.at(-1)
  if (tailAt !== undefined && tailAt >= 0 && tailAt === historyPosition() - 1)
    router.back()
  else inspector.backInPlace()
})

// Views register their own actions under a context (lib/commands.ts); the
// route name IS the context, so the palette stays contextualized for free.
watch(
  () => route.name,
  (name) => palette.setContext(name ? String(name) : undefined),
  { immediate: true },
)

// Command palette: navigation + create + view controls. Registrations are
// diffed so removed spaces unregister (commands are global).
let registered = new Set<string>()
watch(
  () => ws.overview.value,
  (overview) => {
    if (!overview) return
    const next = new Map(
      [
        ...overview.spaces
          .filter((b) => !b.archived)
          .map((b) => ({
            id: `space:${b.key}`,
            label: `Space: ${b.name}`,
            icon: 'kanban',
            namespace: 'Go',
            handler: () => void router.push(wpath(`/s/${b.key}`)),
          })),
        {
          id: 'go:goals',
          label: 'Goals',
          icon: 'target',
          namespace: 'Go',
          handler: () => void router.push(wpath('/goals')),
        },
        // Each goal by name, so "go to the licensing goal" is a few
        // keystrokes from anywhere, like a space is.
        ...(overview.goals ?? [])
          .filter((g) => !g.archived)
          .map((g) => ({
            id: `goal:${g.number}`,
            label: `Goal: ${g.key} ${g.title}`,
            icon: 'target',
            namespace: 'Go',
            handler: () => void router.push(wpath(`/goals/${g.number}`)),
          })),
        {
          id: 'go:docs',
          label: 'Docs',
          icon: 'file-text',
          namespace: 'Go',
          handler: () => void router.push(wpath('/docs')),
        },
        {
          id: 'go:activity',
          label: 'Activity',
          icon: 'pulse',
          namespace: 'Go',
          handler: () => void router.push(wpath('/activity')),
        },
        {
          id: 'go:search',
          label: 'Search',
          icon: 'magnifying-glass',
          namespace: 'Go',
          handler: () => void router.push(wpath('/search')),
        },
        {
          id: 'create:space',
          label: 'Create space',
          icon: 'plus',
          namespace: 'Create',
          handler: () => (ui.newSpaceOpen.value = true),
        },
        {
          id: 'create:goal',
          label: 'Create goal',
          icon: 'target',
          namespace: 'Create',
          handler: () => (ui.newGoal.value = {}),
        },
        {
          id: 'sidebar:toggle',
          label: 'Toggle sidebar',
          icon: 'sidebar-simple',
          namespace: 'View',
          handler: nav.toggle,
        },
        {
          id: 'theme:toggle',
          label: 'Toggle theme',
          icon: 'moon',
          namespace: 'View',
          handler: () =>
            theme.setTheme(theme.resolved.value === 'dark' ? 'light' : 'dark'),
        },
        {
          id: 'help:tour',
          label: 'Show me around',
          icon: 'info',
          namespace: 'Help',
          // restart() rather than start(): it clears the stored record first,
          // so asking for the tour a second time is not silently refused by
          // the version gate that keeps it from re-appearing on its own.
          handler: () => void startTour(),
        },
      ].map((command) => [command.id, command]),
    )
    for (const id of registered) {
      if (!next.has(id)) palette.unregister(id)
    }
    palette.registerMany([...next.values()])
    registered = new Set(next.keys())
  },
  { immediate: true },
)
</script>

<style scoped lang="scss">
.brand-mark {
  display: block;
  width: 28px;
  height: 28px;
  border-radius: var(--nb-radius-sm);
}
</style>

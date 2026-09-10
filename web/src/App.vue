<template>
  <RouterView v-if="route.meta.frameless" />

  <NbShell
    v-else
    ref="shell"
    v-model:inspector-visible="inspectorVisible"
    :sidebar-variant="sidebarVariant"
    sidebar-label="Acta sections"
    inspector-size="md"
    inspector-label="Item"
    contextbar-label="Documents"
    collapse-at="md"
    resizable
  >
    <template #sidebar-logo>
      <!-- The brand doubles as the workspace switcher, which is where a
           person looks for it: the name they are trying to change is already
           printed there. Only interactive when there is somewhere to go. -->
      <button
        v-if="otherWorkspaces.length > 0"
        ref="workspaceTrigger"
        type="button"
        class="brand-switch"
        :aria-expanded="workspaceMenuOpen"
        aria-haspopup="menu"
        @click="toggleWorkspaceMenu"
      >
        <NbSidebarBrand
          title="Acta"
          :subtitle="ws.overview.value?.workspace.name"
        >
          <template #icon>
            <img class="brand-mark" src="/acta-icon.svg" alt="" />
          </template>
        </NbSidebarBrand>
      </button>
      <NbSidebarBrand
        v-else
        title="Acta"
        :subtitle="ws.overview.value?.workspace.name"
      >
        <template #icon>
          <img class="brand-mark" src="/acta-icon.svg" alt="" />
        </template>
      </NbSidebarBrand>
      <NbMenu
        ref="workspaceMenu"
        v-model:open="workspaceMenuOpen"
        size="sm"
        :min-width="220"
        @close="workspaceMenuOpen = false"
      >
        <NbMenuItem
          v-for="workspace in ws.workspaces.value"
          :key="workspace.id"
          :label="workspace.name"
          :selected="workspace.slug === ws.workspaceSlug.value"
          @select="goToWorkspace(workspace.slug)"
        />
      </NbMenu>
    </template>

    <template #sidebar-nav>
      <template v-if="sidebarVariant === 'compact'">
        <NbSidebarLink
          v-for="entry in navEntries"
          :key="entry.to"
          v-nb-tooltip="{ body: entry.label }"
          v-nb-tour-step="entry.tour"
          :to="entry.to"
          :active="entry.active"
          @click.prevent="router.push(entry.to)"
        >
          <NbIcon :name="entry.icon" :size="18" />
        </NbSidebarLink>
        <!-- The rail cannot afford a row per space (a dozen two-letter codes
             read as noise), so spaces fold behind one icon whose menu carries
             what the rail cannot: full names and open counts. -->
        <NbSidebarLink
          ref="spacesRailTrigger"
          v-nb-tooltip="{ body: 'Spaces' }"
          :active="route.name === 'space'"
          aria-label="Spaces"
          aria-haspopup="menu"
          :aria-expanded="spacesMenuOpen"
          @click.prevent="toggleSpacesMenu"
        >
          <NbIcon name="kanban" :size="18" />
        </NbSidebarLink>
        <NbMenu
          ref="spacesMenu"
          v-model:open="spacesMenuOpen"
          size="sm"
          :min-width="220"
          @close="spacesMenuOpen = false"
        >
          <NbMenuItem
            v-for="space in spaces"
            :key="space.key"
            :label="space.name"
            :shortcut="String(openCount(space) ?? '')"
            @select="openSpaceFromMenu(space.key)"
          />
        </NbMenu>
      </template>
      <NbSidebarMenu v-else density="compact">
        <NbSidebarMenuItem
          v-for="entry in navEntries"
          :key="entry.to"
          v-nb-tour-step="entry.tour"
          :label="entry.label"
          :icon="entry.icon"
          :to="entry.to"
          :active="entry.active"
        />
        <NbSidebarMenuGroup v-if="spaces.length > 0" label="Spaces">
          <NbSidebarMenuItem
            v-for="space in spaces"
            :key="space.key"
            :label="space.name"
            :badge="openCount(space)"
            badge-variant="neutral"
            :to="wpath(`/s/${space.key}`)"
            :active="
              route.name === 'space' && route.params.spaceKey === space.key
            "
          />
        </NbSidebarMenuGroup>
      </NbSidebarMenu>
    </template>

    <template #sidebar-bottom>
      <NotificationBell
        v-nb-tour-step="'notifications'"
        :compact="sidebarVariant === 'compact'"
      />
      <template v-if="sidebarVariant === 'compact'">
        <NbSidebarLink
          v-nb-tooltip="{ body: 'Settings' }"
          :to="wpath('/settings')"
          :active="route.name === 'settings'"
          @click.prevent="router.push(wpath('/settings'))"
        >
          <NbIcon name="gear" :size="18" />
        </NbSidebarLink>
        <NbSidebarLink
          v-nb-tooltip="{ body: 'Expand sidebar' }"
          @click.prevent="toggleSidebar"
        >
          <NbIcon name="caret-line-right" :size="18" />
        </NbSidebarLink>
      </template>
      <NbSidebarMenu v-else density="compact">
        <NbSidebarMenuItem
          label="Settings"
          icon="gear"
          :to="wpath('/settings')"
          :active="route.name === 'settings'"
        />
        <NbSidebarMenuItem
          label="Collapse sidebar"
          icon="caret-line-left"
          @click="toggleSidebar"
        />
      </NbSidebarMenu>
      <NbUserMenu
        v-if="ws.me.value"
        :user="{
          email: ws.me.value.email ?? ws.me.value.handle,
          name: ws.me.value.name,
        }"
        :show-account-actions="false"
        :show-profile="false"
        placement="right-end"
        @sign-out="signOut"
      />
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
      <NbBreadcrumbs v-if="trail.length > 0" :title="namespace">
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
    </template>
  </NbShell>

  <NewSpaceModal
    :open="ui.newSpaceOpen.value"
    @close="ui.newSpaceOpen.value = false"
    @created="onSpaceCreated"
  />
  <ItemModal
    v-if="ui.itemModalKey.value"
    :open="ui.itemModalKey.value !== null"
    :item-key="ui.itemModalKey.value"
    @close="ui.itemModalKey.value = null"
  />
  <DocPreviewModal />
  <NbCommandPalette placeholder="Search Acta..." />
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
  <NbWalkthrough
    v-if="!route.meta.frameless"
    :walkthrough="introTour"
    :controller="tour"
    :labels="tourLabels"
  />
  <NbToaster />
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCommandPalette, useTheme, useWalkthrough } from '@nubisco/ui'
import type { NbMenu, NbShell } from '@nubisco/ui'
import { introTour, tourLabels } from '@/lib/tour'
import {
  sidebarDefaultFor,
  useInspector,
  useUiState,
  useWorkspace,
} from '@/stores/workspace'
import ItemInspector from '@/components/ItemInspector.vue'
import ItemModal from '@/components/ItemModal.vue'
import DocPreviewModal from '@/components/DocPreviewModal.vue'
import GlobalSearch from '@/components/GlobalSearch.vue'
import NewSpaceModal from '@/components/NewSpaceModal.vue'
import NotificationBell from '@/components/NotificationBell.vue'
import WelcomeModal from '@/components/WelcomeModal.vue'
import { wpath } from '@/lib/paths'

const route = useRoute()
const router = useRouter()
const ws = useWorkspace()
const inspector = useInspector()
const ui = useUiState()
const palette = useCommandPalette()
const theme = useTheme()
const shell = ref<InstanceType<typeof NbShell> | null>(null)
const tour = useWalkthrough(introTour)

const welcomeOpen = ref(false)

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

// Dual-flavor sidebar: route density decides; the user's toggle overrides
// until the next navigation.
const sidebarVariant = computed(
  () => ui.sidebarChoice.value ?? sidebarDefaultFor(route.name),
)
watch(
  () => route.name,
  () => {
    ui.sidebarChoice.value = null
  },
)
function toggleSidebar(): void {
  ui.sidebarChoice.value =
    sidebarVariant.value === 'compact' ? 'verbose' : 'compact'
}

const spaces = computed(() =>
  (ws.overview.value?.spaces ?? []).filter((b) => !b.archived),
)

// Collapsed-rail spaces menu: opens to the right of its rail icon.
const spacesRailTrigger = ref<{ $el: HTMLElement } | null>(null)
const workspaceMenu = ref<InstanceType<typeof NbMenu> | null>(null)
const workspaceTrigger = ref<HTMLElement | null>(null)
const workspaceMenuOpen = ref(false)

/** Whether switching is even possible; one workspace needs no switcher. */
const otherWorkspaces = computed(() =>
  ws.workspaces.value.filter((w) => w.slug !== ws.workspaceSlug.value),
)

function toggleWorkspaceMenu(): void {
  if (workspaceMenuOpen.value) {
    workspaceMenuOpen.value = false
    return
  }
  const rect = workspaceTrigger.value?.getBoundingClientRect()
  if (rect && workspaceMenu.value) {
    workspaceMenu.value.setPositionXY(rect.left, rect.bottom + 4)
  }
  workspaceMenuOpen.value = true
}

function goToWorkspace(slug: string): void {
  workspaceMenuOpen.value = false
  if (slug !== ws.workspaceSlug.value) void router.push(`/${slug}`)
}

const spacesMenu = ref<InstanceType<typeof NbMenu> | null>(null)
const spacesMenuOpen = ref(false)

function toggleSpacesMenu(): void {
  if (spacesMenuOpen.value) {
    spacesMenuOpen.value = false
    return
  }
  const el = spacesRailTrigger.value?.$el
  if (el && spacesMenu.value) {
    const rect = el.getBoundingClientRect()
    spacesMenu.value.setPositionXY(rect.right + 8, rect.top)
  }
  spacesMenuOpen.value = true
}

function openSpaceFromMenu(key: string): void {
  spacesMenuOpen.value = false
  void router.push(wpath(`/s/${key}`))
}

const navEntries = computed(() => [
  {
    to: '/',
    label: 'Home',
    icon: 'house',
    tour: 'nav-home',
    active: route.name === 'home',
  },
  {
    to: '/docs',
    label: 'Docs',
    icon: 'book-open',
    tour: 'nav-docs',
    active: route.name === 'docs',
  },
  {
    to: '/activity',
    label: 'Activity',
    icon: 'pulse',
    tour: 'nav-activity',
    active: route.name === 'activity',
  },
])

function openCount(space: {
  lists: { role?: string; items: number }[]
}): number | undefined {
  const n = space.lists
    .filter((l) => l.role !== 'done')
    .reduce((sum, l) => sum + l.items, 0)
  return n > 0 ? n : undefined
}

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

/** The workspace name, which leads the breadcrumb trail on every route. */
// Loaded once so the switcher knows whether it has anywhere to go.
void ws.listWorkspaces().catch(() => undefined)

const namespace = computed(() => ws.overview.value?.workspace.name ?? 'Acta')

const trail = computed<ICrumb[]>(() => {
  if (route.meta.crumb === 'space') {
    const key = String(route.params.spaceKey ?? '')
    const space = spaces.value.find((b) => b.key === key)
    return [{ text: 'Spaces', to: wpath('/') }, { text: space?.name ?? key }]
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
    settings: 'Settings',
    activity: 'Activity',
    search: 'Search',
  }
  const name = String(route.name ?? '')
  return named[name] ? [{ text: named[name] }] : []
})

const inspectorVisible = ref(false)
// The inspector only stays open while it has an item; an empty-but-open
// inspector is dead space. The docs tree lives in the docs view itself.
watch(inspector.itemKey, (key) => {
  inspectorVisible.value = key !== null
})
watch(
  () => route.name,
  () => {
    if (!inspector.itemKey.value) inspectorVisible.value = false
  },
  { immediate: true },
)
watch(inspectorVisible, (visible) => {
  if (!visible) inspector.close()
})

async function signOut(): Promise<void> {
  await ws.logout()
  void router.push({ name: 'login' })
}

function onSpaceCreated(key: string): void {
  ui.newSpaceOpen.value = false
  void router.push(wpath(`/s/${key}`))
}

// Deep-linkable inspector: the open card lives in the URL as ?item=KEY, so
// what you are looking at is what you share. Both directions sync with an
// equality guard so neither watcher re-triggers the other.
watch(
  () => route.query.item,
  (raw) => {
    const target = typeof raw === 'string' && raw ? raw : null
    if (target !== inspector.itemKey.value) {
      if (target) inspector.restore(target)
      else inspector.close()
    }
  },
  { immediate: true },
)
watch(inspector.itemKey, (key) => {
  const current = typeof route.query.item === 'string' ? route.query.item : null
  if ((key ?? null) === current) return
  // Forward hops PUSH so browser Back walks the chain the reader followed;
  // trail-backs and closes REPLACE so neither duplicates the history nor
  // resurrects a closed inspector.
  const navigate =
    key && inspector.navMode.value === 'push' ? router.push : router.replace
  inspector.navMode.value = 'push'
  void navigate({
    query: { ...route.query, item: key ?? undefined },
  })
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
          id: 'go:docs',
          label: 'Docs',
          icon: 'book-open',
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
          id: 'sidebar:toggle',
          label: 'Toggle sidebar',
          icon: 'sidebar-simple',
          namespace: 'View',
          handler: toggleSidebar,
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
.brand-switch {
  display: block;
  inline-size: 100%;
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
  border-radius: var(--nb-radius-sm, 8px);

  &:hover {
    background: var(--nb-c-surface-hover, rgba(255, 255, 255, 0.06));
  }

  &:focus-visible {
    outline: 2px solid var(--nb-c-focus-ring, var(--nb-c-primary));
    outline-offset: 2px;
  }
}

.brand-mark {
  display: block;
  width: 28px;
  height: 28px;
  border-radius: var(--nb-radius-sm);
}
</style>

<template>
  <RouterView v-if="route.meta.frameless" />

  <NbShell
    v-else
    ref="shell"
    v-model:inspector-visible="inspectorVisible"
    :sidebar-variant="sidebarVariant"
    sidebar-label="Acta sections"
    inspector-size="sm"
    inspector-label="Item"
    collapse-at="md"
    resizable
  >
    <template #sidebar-logo>
      <WorkspaceSwitcher :compact="sidebarVariant === 'compact'" />
    </template>

    <template #sidebar-nav>
      <template v-if="sidebarVariant === 'compact'">
        <NbSidebarLink
          v-for="entry in navEntries"
          :key="entry.to"
          v-nb-tooltip="{ body: entry.label }"
          :to="entry.to"
          :active="entry.active"
          @click.prevent="router.push(entry.to)"
        >
          <NbIcon :name="entry.icon" :size="18" />
        </NbSidebarLink>
        <NbSidebarLink
          v-for="board in boards"
          :key="board.key"
          v-nb-tooltip="{ body: board.name }"
          :to="`/b/${board.key}`"
          :active="
            route.name === 'board' && route.params.boardKey === board.key
          "
          @click.prevent="router.push(`/b/${board.key}`)"
        >
          <span class="rail-key">{{ board.key.slice(0, 2) }}</span>
        </NbSidebarLink>
      </template>
      <NbSidebarMenu v-else density="compact">
        <NbSidebarMenuItem
          v-for="entry in navEntries"
          :key="entry.to"
          :label="entry.label"
          :icon="entry.icon"
          :to="entry.to"
          :active="entry.active"
        />
        <NbSidebarMenuGroup v-if="boards.length > 0" label="Boards">
          <NbSidebarMenuItem
            v-for="board in boards"
            :key="board.key"
            :label="board.name"
            :badge="openCount(board)"
            badge-variant="neutral"
            :to="`/b/${board.key}`"
            :active="
              route.name === 'board' && route.params.boardKey === board.key
            "
          />
        </NbSidebarMenuGroup>
      </NbSidebarMenu>
    </template>

    <template #sidebar-bottom>
      <NotificationBell :compact="sidebarVariant === 'compact'" />
      <template v-if="sidebarVariant === 'compact'">
        <NbSidebarLink
          v-nb-tooltip="{ body: 'Settings' }"
          to="/settings"
          :active="route.name === 'settings'"
          @click.prevent="router.push('/settings')"
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
          to="/settings"
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
      <NbBreadcrumbs v-if="trail.length > 1" title="Acta">
        <RouterLink
          v-for="crumb in trail.slice(0, -1)"
          :key="crumb.to ?? crumb.text"
          :to="crumb.to ?? '/'"
        >
          {{ crumb.text }}
        </RouterLink>
        <span aria-current="page">{{ trail[trail.length - 1].text }}</span>
      </NbBreadcrumbs>
    </template>

    <template #topbar-right>
      <form
        class="topbar-search"
        role="search"
        aria-label="Search Acta"
        @submit.prevent="submitSearch"
      >
        <NbTextInput
          id="field-topbar-search"
          v-model="searchQuery"
          size="sm"
          placeholder="Search..."
          aria-label="Search Acta"
        />
      </form>
    </template>

    <RouterView />

    <template #inspector>
      <DocsTreePanel v-if="route.name === 'docs' && !inspector.itemKey.value" />
      <ItemInspector
        v-else-if="inspector.itemKey.value"
        :item-key="inspector.itemKey.value"
      />
      <NbEmptyState
        v-else
        size="sm"
        :icon="null"
        title="No item selected"
        description="Select a card to see its details here."
      />
    </template>
  </NbShell>

  <NewBoardModal
    :open="ui.newBoardOpen.value"
    @close="ui.newBoardOpen.value = false"
    @created="onBoardCreated"
  />
  <ItemModal
    v-if="ui.itemModalKey.value"
    :open="ui.itemModalKey.value !== null"
    :item-key="ui.itemModalKey.value"
    @close="ui.itemModalKey.value = null"
  />
  <NbCommandPalette placeholder="Search Acta..." />
  <NbToaster />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NbBanner,
  NbBreadcrumbs,
  NbCommandPalette,
  NbEmptyState,
  NbIcon,
  NbShell,
  NbSidebarLink,
  NbSidebarMenu,
  NbSidebarMenuGroup,
  NbSidebarMenuItem,
  NbTextInput,
  NbToaster,
  NbUserMenu,
  useCommandPalette,
  useTheme,
} from '@nubisco/ui'
import {
  sidebarDefaultFor,
  useInspector,
  useUiState,
  useWorkspace,
} from '@/stores/workspace'
import DocsTreePanel from '@/components/DocsTreePanel.vue'
import ItemInspector from '@/components/ItemInspector.vue'
import ItemModal from '@/components/ItemModal.vue'
import NewBoardModal from '@/components/NewBoardModal.vue'
import NotificationBell from '@/components/NotificationBell.vue'
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher.vue'

const route = useRoute()
const router = useRouter()
const ws = useWorkspace()
const inspector = useInspector()
const ui = useUiState()
const palette = useCommandPalette()
const theme = useTheme()
const shell = ref<InstanceType<typeof NbShell> | null>(null)

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

const boards = computed(() =>
  (ws.overview.value?.boards ?? []).filter((b) => !b.archived),
)

const navEntries = computed(() => [
  { to: '/', label: 'Home', icon: 'house', active: route.name === 'home' },
  {
    to: '/docs',
    label: 'Docs',
    icon: 'book-open',
    active: route.name === 'docs',
  },
  {
    to: '/activity',
    label: 'Activity',
    icon: 'pulse',
    active: route.name === 'activity',
  },
])

function openCount(board: {
  lists: { role?: string; items: number }[]
}): number | undefined {
  const n = board.lists
    .filter((l) => l.role !== 'done')
    .reduce((sum, l) => sum + l.items, 0)
  return n > 0 ? n : undefined
}

interface ICrumb {
  text: string
  to?: string
}

const trail = computed<ICrumb[]>(() => {
  if (route.meta.crumb === 'board') {
    const key = String(route.params.boardKey ?? '')
    const board = boards.value.find((b) => b.key === key)
    return [{ text: 'Home', to: '/' }, { text: board?.name ?? key }]
  }
  if (route.meta.crumb === 'docs') {
    const slug = String(route.params.slug ?? '')
    const crumbs: ICrumb[] = [{ text: 'Docs', to: '/docs' }]
    if (slug) {
      const parts = slug.split('/')
      parts.forEach((part, index) => {
        const path = parts.slice(0, index + 1).join('/')
        crumbs.push({
          text: part,
          to: index < parts.length - 1 ? `/docs/${path}` : undefined,
        })
      })
    }
    return crumbs.length > 1 ? crumbs : []
  }
  return []
})

const inspectorVisible = ref(false)
watch(inspector.itemKey, (key) => {
  if (key !== null) inspectorVisible.value = true
})
watch(
  () => route.name,
  (name) => {
    if (name === 'docs') inspectorVisible.value = true
    else if (!inspector.itemKey.value) inspectorVisible.value = false
  },
  { immediate: true },
)
watch(inspectorVisible, (visible) => {
  if (!visible) inspector.close()
})

const searchQuery = ref('')
function submitSearch(): void {
  const q = searchQuery.value.trim()
  void router.push({ name: 'search', query: q ? { q } : undefined })
}

async function signOut(): Promise<void> {
  await ws.logout()
  void router.push({ name: 'login' })
}

function onBoardCreated(key: string): void {
  ui.newBoardOpen.value = false
  void router.push(`/b/${key}`)
}

// Command palette: navigation + create + view controls. Registrations are
// diffed so removed boards unregister (commands are global).
let registered = new Set<string>()
watch(
  () => ws.overview.value,
  (overview) => {
    if (!overview) return
    const next = new Map(
      [
        ...overview.boards
          .filter((b) => !b.archived)
          .map((b) => ({
            id: `board:${b.key}`,
            label: `Board: ${b.name}`,
            icon: 'kanban',
            namespace: 'Go',
            handler: () => void router.push(`/b/${b.key}`),
          })),
        {
          id: 'go:docs',
          label: 'Docs',
          icon: 'book-open',
          namespace: 'Go',
          handler: () => void router.push('/docs'),
        },
        {
          id: 'go:activity',
          label: 'Activity',
          icon: 'pulse',
          namespace: 'Go',
          handler: () => void router.push('/activity'),
        },
        {
          id: 'go:search',
          label: 'Search',
          icon: 'magnifying-glass',
          namespace: 'Go',
          handler: () => void router.push('/search'),
        },
        {
          id: 'create:board',
          label: 'Create board',
          icon: 'plus',
          namespace: 'Create',
          handler: () => (ui.newBoardOpen.value = true),
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
.topbar-search {
  display: flex;
  align-items: center;
}

.rail-key {
  font-family: var(--nb-font-family-mono);
  font-size: var(--nb-type-label-sm-size);
  font-weight: var(--nb-type-label-lg-weight, 600);
}
</style>

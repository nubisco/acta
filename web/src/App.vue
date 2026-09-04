<template>
  <RouterView v-if="route.meta.frameless" />

  <NbShell
    v-else
    ref="shell"
    v-model:inspector-visible="inspectorVisible"
    sidebar-variant="verbose"
    sidebar-label="Acta sections"
    inspector-size="sm"
    inspector-label="Item"
    collapse-at="md"
    resizable
  >
    <template #sidebar-logo>
      <NbSidebarBrand title="Acta" subtitle="boards + docs" icon="kanban" />
    </template>

    <template #sidebar-nav>
      <NbSidebarMenu density="compact">
        <NbSidebarMenuItem
          label="Home"
          icon="house"
          to="/"
          :active="route.name === 'home'"
        />
        <NbSidebarMenuItem
          label="Docs"
          icon="book-open"
          to="/docs"
          :active="route.name === 'docs'"
        />
        <NbSidebarMenuItem
          label="Search"
          icon="magnifying-glass"
          to="/search"
          :active="route.name === 'search'"
        />
        <NbSidebarMenuItem
          label="Activity"
          icon="pulse"
          to="/activity"
          :active="route.name === 'activity'"
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
      <NbSidebarMenu density="compact">
        <NbSidebarMenuItem
          label="Settings"
          icon="gear"
          to="/settings"
          :active="route.name === 'settings'"
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
        <template v-for="(crumb, index) in trail" :key="crumb.to ?? crumb.text">
          <RouterLink
            v-if="index < trail.length - 1 && crumb.to"
            :to="crumb.to"
          >
            {{ crumb.text }}
          </RouterLink>
          <span v-else aria-current="page">{{ crumb.text }}</span>
        </template>
      </NbBreadcrumbs>
    </template>

    <template #topbar-right>
      <NbNotificationCenter
        :items="notificationItems"
        align="end"
        @mark-all-read="ws.markAllRead"
      />
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
  NbNotificationCenter,
  NbShell,
  NbSidebarBrand,
  NbSidebarMenu,
  NbSidebarMenuGroup,
  NbSidebarMenuItem,
  NbToaster,
  NbUserMenu,
  useCommandPalette,
  useTheme,
} from '@nubisco/ui'
import { useInspector, useUiState, useWorkspace } from '@/stores/workspace'
import DocsTreePanel from '@/components/DocsTreePanel.vue'
import ItemInspector from '@/components/ItemInspector.vue'
import NewBoardModal from '@/components/NewBoardModal.vue'

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

const boards = computed(() =>
  (ws.overview.value?.boards ?? []).filter((b) => !b.archived),
)

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

const notificationItems = computed(() =>
  ws.notifications.value.map((n) => ({
    id: n.id,
    title: n.title,
    time: n.timestamp,
    read: n.read,
  })),
)

async function signOut(): Promise<void> {
  await ws.logout()
  void router.push({ name: 'login' })
}

function onBoardCreated(key: string): void {
  ui.newBoardOpen.value = false
  void router.push(`/b/${key}`)
}

// Command palette: navigation + create + theme. Registrations are diffed so
// removed boards unregister (commands are global).
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

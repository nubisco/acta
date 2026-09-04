<template>
  <NbShell
    v-model:inspector-visible="inspectorVisible"
    inspector-size="md"
    resizable
  >
    <template #sidebar-logo>
      <NbSidebarBrand title="Acta" subtitle="boards + docs" icon="kanban" />
    </template>
    <template #sidebar-nav>
      <NbSidebarMenu density="compact">
        <NbSidebarMenuGroup label="Workspace">
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
            label="Activity"
            icon="pulse"
            to="/activity"
            :active="route.name === 'activity'"
          />
        </NbSidebarMenuGroup>
        <NbSidebarMenuGroup v-if="boards.length > 0" label="Boards">
          <NbSidebarMenuItem
            v-for="board in boards"
            :key="board.key"
            :label="board.name"
            :badge="openCount(board)"
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
        <NbSidebarMenuItem
          v-if="ws.me.value"
          label="Sign out"
          icon="sign-out"
          @click="signOut"
        />
      </NbSidebarMenu>
    </template>

    <router-view />

    <template #inspector>
      <ItemPanel
        v-if="inspector.itemKey.value"
        :item-key="inspector.itemKey.value"
        @close="closeInspector"
      />
    </template>
  </NbShell>

  <NbCommandPalette placeholder="Search Acta..." />
  <NbToaster :queue="toast" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NbCommandPalette,
  NbShell,
  NbSidebarBrand,
  NbSidebarMenu,
  NbSidebarMenuGroup,
  NbSidebarMenuItem,
  NbToaster,
  useCommandPalette,
  useToast,
} from '@nubisco/ui'
import { api } from '@/api/client'
import { useInspector, useWorkspace } from '@/stores/workspace'
import ItemPanel from '@/components/ItemPanel.vue'

const route = useRoute()
const router = useRouter()
const ws = useWorkspace()
const inspector = useInspector()
const toast = useToast()
const palette = useCommandPalette()

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

const inspectorVisible = ref(false)
watch(inspector.itemKey, (key) => (inspectorVisible.value = key !== null))
watch(inspectorVisible, (visible) => {
  if (!visible) inspector.close()
})

function closeInspector(): void {
  inspector.close()
}

async function signOut(): Promise<void> {
  await ws.logout()
  void router.push({ name: 'login' })
}

// Command palette: navigation + free-text search.
watch(
  () => ws.overview.value,
  (overview) => {
    if (!overview) return
    palette.registerMany([
      ...overview.boards.map((b) => ({
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
        id: 'search:items',
        label: 'Search items and docs...',
        icon: 'magnifying-glass',
        namespace: 'Search',
        handler: async () => {
          const q = window.prompt('Search:')
          if (!q) return
          const { results } = await api.search(q)
          if (results.length === 0) {
            toast.info('No results')
            return
          }
          const top = results[0]
          if (top.type === 'doc') void router.push(`/docs/${top.ref}`)
          else if (top.type === 'item') inspector.open(top.ref)
          else if (top.type === 'comment') inspector.open(top.title)
        },
      },
    ])
  },
  { immediate: true },
)
</script>

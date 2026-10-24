<template>
  <!-- One element per destination, which the library renders as a labelled
       row expanded and an icon collapsed (the fleet rail standard), so there
       is no second set of links to keep in step for the collapsed state. -->
  <NbSidebarMenu density="compact">
    <!-- Switching workspace is a destination of its own, first in the rail,
         the way Verba leads with Home. The brand used to double as the
         switcher, but with the toggle swapped onto it under the pointer it
         can no longer be anything but the brand. -->
    <NbSidebarMenuItem
      label="Workspaces"
      icon="buildings"
      to="/"
      :active="route.name === 'workspaces'"
    />

    <!-- The workspace you are in, named once above its own destinations.
         Collapsed, the heading becomes a divider and keeps its name for
         assistive tech. -->
    <NbSidebarMenuGroup v-if="workspaceName" :label="workspaceName">
      <NbSidebarMenuItem
        v-for="entry in navEntries"
        :key="entry.to"
        v-nb-tour-step="entry.tour"
        :label="entry.label"
        :icon="entry.icon"
        :to="entry.to"
        :active="entry.active"
      />
      <!-- The way to another space, from anywhere. Expanded it opens in
           place, collapsed its flyout carries what the rail cannot: full
           names and open counts. Home lists the spaces too, with more. -->
      <NbSidebarMenuItem
        v-if="spaces.length > 0"
        label="Spaces"
        icon="squares-four"
      >
        <NbSidebarMenuItem
          v-for="space in spaces"
          :key="space.key"
          :label="space.name"
          :badge="openCount(space)"
          badge-variant="neutral"
          :to="wpath(`/s/${space.key}`)"
          :active="space.key === chosen?.key"
        />
      </NbSidebarMenuItem>
    </NbSidebarMenuGroup>

    <!-- The space you are in, as its own group headed with its name (the
         fleet rail anatomy): its views, then its Settings, always last. -->
    <NbSidebarMenuGroup v-if="chosen" :label="chosen.name">
      <NbSidebarMenuItem
        v-for="entry in spaceEntries"
        :key="entry.id"
        :label="entry.label"
        :icon="entry.icon"
        :to="entry.to"
        :active="entry.active"
      />
      <NbSidebarMenuItem
        label="Settings"
        icon="sliders-horizontal"
        :to="wpath(`/s/${chosen.key}/settings`)"
        :active="route.name === 'space-settings'"
      />
    </NbSidebarMenuGroup>
  </NbSidebarMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useWorkspace } from '@/stores/workspace'
import { wpath } from '@/lib/paths'
import { SPACE_VIEWS, spaceViewOf, spaceViewPath } from '@/lib/spaceViews'

defineProps<{
  /** Whether the rail is collapsed to icons. */
  compact: boolean
}>()

const route = useRoute()
const ws = useWorkspace()

const workspaceName = computed(() => ws.overview.value?.workspace.name ?? '')

const spaces = computed(() =>
  (ws.overview.value?.spaces ?? []).filter((b) => !b.archived),
)

/**
 * The space the route is in, board or settings. Looked up among every space,
 * archived ones too, so an archived space opened from Home still gets its
 * group and the way to its Settings, where it can be brought back.
 */
const chosen = computed(() => {
  const key = route.params?.spaceKey
  if (typeof key !== 'string' || !key) return null
  return (ws.overview.value?.spaces ?? []).find((s) => s.key === key) ?? null
})

const spaceEntries = computed(() => {
  const space = chosen.value
  if (!space) return []
  void ws.workspaceSlug.value
  const current = route.name === 'space' ? spaceViewOf(route.query?.view) : ''
  return SPACE_VIEWS.map((view) => ({
    ...view,
    to: wpath(spaceViewPath(space.key, view.id)),
    active: current === view.id,
  }))
})

/*
 * Built with `wpath`, like every other link in the frame.
 *
 * `/` is not Home. It is the workspace list, so Home has to carry the
 * workspace segment or it lands somewhere else entirely.
 *
 * `wpath` reads a plain value rather than reactive state, so the workspace
 * param is read here to rebuild the links when the workspace changes, even
 * between two routes with the same name.
 */
const navEntries = computed(() => {
  void route.params.workspace
  void ws.workspaceSlug.value
  return [
    {
      to: wpath('/'),
      label: 'Home',
      icon: 'house',
      tour: 'nav-home',
      active: route.name === 'home',
    },
    {
      to: wpath('/activity'),
      label: 'Activity',
      icon: 'pulse',
      tour: 'nav-activity',
      active: route.name === 'activity',
    },
    // Right under the workspace-wide views and above Docs and the spaces,
    // because goals are what the rest of the work is for. Jose set the order.
    {
      to: wpath('/goals'),
      label: 'Goals',
      icon: 'target',
      tour: 'nav-goals',
      active: route.name === 'goal' || route.name === 'goals',
    },
    // `file-text`, not a book: the book is the product Documentation link at
    // the foot of the rail, and the two must not read as the same thing.
    {
      to: wpath('/docs'),
      label: 'Docs',
      icon: 'file-text',
      tour: 'nav-docs',
      active: route.name === 'docs',
    },
  ]
})

function openCount(space: {
  lists: { role?: string; items: number }[]
}): number | undefined {
  const n = space.lists
    .filter((l) => l.role !== 'done')
    .reduce((sum, l) => sum + l.items, 0)
  return n > 0 ? n : undefined
}
</script>

<template>
  <NbNotificationCenter
    v-model:open="open"
    class="bell"
    label="Notifications"
    :unread-count="unread"
    :item-count="entries.length"
    :loading="loading"
    :error="failed"
    error-title="Could not load your notifications"
    error-description="The list below may be out of date."
    empty-title="Nothing waiting on you"
    empty-description="You hear about work you are mentioned in, assigned to, or already part of."
    :width="360"
    side="right"
    align="end"
    close-on-select
    close-on-navigate
    @mark-all-read="markAllRead"
    @retry="load"
  >
    <template #trigger="{ triggerProps, setTriggerRef, toggle }">
      <!-- One menu item in both rail states, like every other row. Expanded
           it is a labelled row with the count at its end. Collapsed it is the
           icon alone, and the library draws the count on the icon's corner,
           so the bell stays where every other icon is. The hand-rolled
           collapsed link with its own badge pushed the icon off centre. -->
      <NbSidebarMenu density="compact">
        <NbSidebarMenuItem
          :ref="setTriggerRef"
          v-bind="triggerProps"
          label="Notifications"
          :icon="unread > 0 ? 'bell-ringing' : 'bell'"
          :active="open"
          :badge="unread > 0 ? unread : undefined"
          badge-variant="danger"
          @click="toggle"
        />
      </NbSidebarMenu>
    </template>

    <!-- Replacing the header actions keeps the library's pending-safe mark-all
         (aria-disabled rather than disabled, so the in-flight button keeps
         focus) and adds the way out to the settings that govern this list.
         The desktop-permission prompt used to live in this panel, which made
         the panel a settings page that also showed notifications. It is in
         Your settings under Notifications now, alongside the email window. -->
    <template #header-actions="{ markAllProps, markAllText }">
      <NbButton
        v-nb-tooltip="{ body: 'Notification settings' }"
        size="xs"
        variant="ghost"
        icon="sliders-horizontal"
        aria-label="Notification settings"
        @click="openSettings"
      />
      <NbButton
        v-if="unread > 0"
        size="xs"
        variant="ghost"
        outlined
        v-bind="markAllProps"
      >
        {{ markAllText }}
      </NbButton>
    </template>

    <NbNotificationCenterItem
      v-for="entry in entries"
      :key="entry.id"
      :title="entry.title"
      :body="reasonFor(entry)"
      :time="entry.timestamp"
      :read="entry.read"
      :variant="variantFor(entry.verb)"
      :icon="null"
      @select="openEntry(entry)"
    >
      <!-- A person is represented by their face everywhere else in Acta, and
           an inbox is a list of things people did. A status glyph here would
           say what kind of event it was, which the sentence beside it already
           says, and would drop the one thing the sentence cannot carry. -->
      <template #media>
        <ActorAvatar
          v-if="entry.actorHandle"
          :handle="entry.actorHandle"
          :size="24"
        />
      </template>
    </NbNotificationCenterItem>
  </NbNotificationCenter>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { wpath } from '@/lib/paths'
import { useTours } from '@/lib/tours'
import ActorAvatar from '@/components/ActorAvatar.vue'
import {
  notificationPath,
  useInspector,
  useWorkspace,
  type IAppNotification,
} from '@/stores/workspace'

const ws = useWorkspace()
const router = useRouter()
const inspector = useInspector()

const open = ref(false)
const loading = ref(false)

// The notifications walkthrough plays once the panel is closed for the
// first time: the reader has seen what lands here, and the tour then shows
// where it is set up. Not while it is open, which would cover the list they
// opened it to read. The pause lets the panel finish closing.
const tours = useTours()
watch(open, (now, before) => {
  if (before && !now)
    setTimeout(() => void tours.maybeStart('notifications'), 250)
})
const failed = ref(false)

const entries = computed(() => ws.notifications.value)
const unread = computed(() => ws.unreadCount.value)
const REASONS: Record<IAppNotification['reason'], string> = {
  mention: 'Mentioned you',
  assigned: 'Assigned to you',
  involved: 'You are on this',
}

/**
 * A goal's owner is told as "assigned" and a follower as "involved", which
 * are the reasons the inbox has, but "Assigned to you" is the wrong sentence
 * about a goal somebody owns.
 */
const GOAL_REASONS: Record<IAppNotification['reason'], string> = {
  mention: 'Mentioned you',
  assigned: 'Your goal',
  involved: 'A goal you follow',
}

function reasonFor(entry: IAppNotification): string {
  return (entry.verb.startsWith('goal.') ? GOAL_REASONS : REASONS)[entry.reason]
}

/**
 * Colour by consequence, not by entity.
 *
 * A date that has passed and a card that is blocked are the two things in
 * this list somebody has to do something about, so they are the two that are
 * allowed to be loud. Everything else is news, and a list where every row is
 * coloured is a list with no colour in it.
 */
function variantFor(verb: string): 'neutral' | 'info' | 'success' | 'warning' {
  if (verb === 'item.overdue' || verb === 'item.blocked') return 'warning'
  if (verb === 'item.completed' || verb === 'item.unblocked') return 'success'
  if (verb === 'item.due_soon') return 'warning'
  return 'info'
}

/** Opens the thing and marks that one read. The rest stay as they were. */
function openEntry(entry: IAppNotification): void {
  void ws.markRead(entry.id)
  // In place, the way every other card reference opens: the page you were
  // on stays under it (UX audit, 2026-10-09).
  if (entry.itemKey) {
    inspector.open(entry.itemKey)
    return
  }
  const target = notificationPath(entry)
  if (target) void router.push(target)
}

function openSettings(): void {
  open.value = false
  void router.push(wpath('/me?tab=notifications'))
}

async function markAllRead(): Promise<void> {
  await ws.markAllRead()
}

/**
 * The inbox is server-side, so it survives a reload and has to be fetched
 * rather than accumulated from whatever happened while the tab was watching.
 * A failure is its own state and not a flavour of empty: an inbox that says
 * "nothing waiting on you" because the request failed is the one wrong answer
 * this component can give.
 */
async function load(): Promise<void> {
  loading.value = entries.value.length === 0
  failed.value = false
  try {
    failed.value = !(await ws.loadNotifications())
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

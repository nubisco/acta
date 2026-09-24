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
    close-on-select
    close-on-navigate
    @mark-all-read="markAllRead"
    @retry="load"
  >
    <template #trigger="{ triggerProps, setTriggerRef, toggle }">
      <NbSidebarLink
        v-if="compact"
        :ref="setTriggerRef"
        v-bind="triggerProps"
        v-nb-tooltip="{ body: bellTitle }"
        :active="open"
        @click.prevent="toggle"
      >
        <NbIcon :name="unread > 0 ? 'bell-ringing' : 'bell'" :size="18" />
        <NbBadge v-if="unread > 0" variant="red" size="sm" class="bell__badge">
          {{ unread }}
        </NbBadge>
      </NbSidebarLink>
      <!-- The same component Settings and Collapse sidebar use. A hand-rolled
           button here inherited none of the sidebar's typography, which is why
           this one row rendered in a different size and weight to every other. -->
      <NbSidebarMenu v-else density="compact">
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
         Settings under Notifications now, alongside the email window. -->
    <template #header-actions="{ markAllProps, markAllText }">
      <NbButton
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
      :body="REASONS[entry.reason]"
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
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { wpath } from '@/lib/paths'
import ActorAvatar from '@/components/ActorAvatar.vue'
import {
  notificationPath,
  useInspector,
  useWorkspace,
  type IAppNotification,
} from '@/stores/workspace'

defineProps<{ compact?: boolean }>()

const ws = useWorkspace()
const router = useRouter()
const inspector = useInspector()

const open = ref(false)
const loading = ref(false)
const failed = ref(false)

const entries = computed(() => ws.notifications.value)
const unread = computed(() => ws.unreadCount.value)
const bellTitle = computed(() =>
  unread.value > 0 ? `${unread.value} unread notifications` : 'Notifications',
)

const REASONS: Record<IAppNotification['reason'], string> = {
  mention: 'Mentioned you',
  assigned: 'Assigned to you',
  involved: 'You are on this',
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
  if (entry.itemKey) {
    void router.push(wpath(`/s/${entry.itemKey.split('-')[0]}`))
    inspector.open(entry.itemKey)
    return
  }
  const target = notificationPath(entry)
  if (target) void router.push(target)
}

function openSettings(): void {
  open.value = false
  void router.push(wpath('/settings'))
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

<style scoped lang="scss">
/* Only what the component has no opinion about. Everything the panel draws,
   the surface, the border, the rows, the unread affordance and the placement,
   belongs to NbNotificationCenter and is not restyled here. */
.bell__badge {
  margin-inline-start: auto;
}
</style>

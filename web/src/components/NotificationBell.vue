<template>
  <div ref="root" class="bell">
    <NbSidebarLink
      v-if="compact"
      v-nb-tooltip="{ body: bellTitle }"
      :active="open"
      @click.prevent="open = !open"
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
        label="Notifications"
        :icon="unread > 0 ? 'bell-ringing' : 'bell'"
        :active="open"
        :badge="unread > 0 ? unread : undefined"
        badge-variant="danger"
        @click="open = !open"
      />
    </NbSidebarMenu>

    <NbPanel v-if="open" class="bell__panel">
      <header class="bell__head">
        <span>Notifications</span>
        <NbButton
          v-if="unread > 0"
          size="xs"
          variant="ghost"
          outlined
          @click="ws.markAllRead"
        >
          Mark all read
        </NbButton>
      </header>
      <!-- Offered until it is answered. Browsers only accept the request
           from a real click, so it cannot be asked for on load. -->
      <NbButton
        v-if="canAskForDesktop"
        size="xs"
        variant="secondary"
        class="bell__enable"
        @click="enableDesktop"
      >
        Notify me on this device
      </NbButton>

      <p v-if="ws.notifications.value.length === 0" class="bell__empty">
        Nothing waiting on you.
      </p>
      <ul v-else class="bell__list">
        <li
          v-for="entry in ws.notifications.value"
          :key="entry.id"
          :class="{ 'bell__item--unread': !entry.read }"
        >
          <button type="button" class="bell__entry" @click="openEntry(entry)">
            <span class="bell__reason">{{ reasonLabel(entry.reason) }}</span>
            <span>{{ entry.title }}</span>
            <time :datetime="entry.timestamp">
              {{ relativeTime(Date.parse(entry.timestamp)) }}
            </time>
          </button>
        </li>
      </ul>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { relativeTime } from '@/lib/state'
import { wpath } from '@/lib/paths'
import {
  useInspector,
  useWorkspace,
  type IAppNotification,
} from '@/stores/workspace'

defineProps<{ compact?: boolean }>()

const ws = useWorkspace()
const router = useRouter()
const inspector = useInspector()

// Offered until answered: 'default' means never asked. Once granted or
// denied the browser will not ask again, so neither should we.
const permission = ref(
  typeof Notification === 'undefined' ? 'denied' : Notification.permission,
)
const canAskForDesktop = computed(() => permission.value === 'default')

async function enableDesktop(): Promise<void> {
  await ws.enableDesktopNotifications()
  permission.value =
    typeof Notification === 'undefined' ? 'denied' : Notification.permission
}

const REASONS: Record<IAppNotification['reason'], string> = {
  mention: 'Mentioned you',
  assigned: 'Assigned to you',
  involved: 'You are on this',
}
const reasonLabel = (r: IAppNotification['reason']) => REASONS[r]

/** Opens the card and marks that one read; the rest stay as they were. */
function openEntry(entry: IAppNotification): void {
  void ws.markRead(entry.id)
  open.value = false
  if (!entry.itemKey) return
  void router.push(wpath(`/s/${entry.itemKey.split('-')[0]}`))
  inspector.open(entry.itemKey)
}
const open = ref(false)
const root = ref<HTMLElement | null>(null)

const unread = computed(() => ws.unreadCount.value)
const bellTitle = computed(() =>
  unread.value > 0 ? `${unread.value} unread notifications` : 'Notifications',
)

function onOutside(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node))
    open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onOutside)
  // The inbox is server-side now, so it survives a reload and has to be
  // fetched rather than accumulated from whatever happened while watching.
  void ws.loadNotifications()
})
onUnmounted(() => document.removeEventListener('pointerdown', onOutside))
</script>

<style scoped lang="scss">
.bell {
  position: relative;

  &__badge {
    margin-inline-start: auto;
  }

  /* The panel opens sideways: below the trigger is only the window edge. */
  &__panel {
    position: absolute;
    inset-block-end: 0;
    inset-inline-start: calc(100% + var(--nb-spacing-8));
    inline-size: 20rem;
    max-block-size: 24rem;
    overflow-y: auto;
    z-index: var(--nb-zindex-dropdown, 30);
    display: grid;
    gap: var(--nb-spacing-8);
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: var(--nb-type-label-lg-weight, 600);
  }

  &__empty {
    margin: 0;
    color: var(--nb-c-text-muted);
    font-size: var(--nb-type-body-sm-size);
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--nb-spacing-8);

    li {
      display: grid;
      gap: var(--nb-spacing-2);
      font-size: var(--nb-type-body-sm-size);
      color: var(--nb-c-text-muted);

      time {
        font-size: var(--nb-type-label-sm-size);
        color: var(--nb-c-text-subtle);
      }
    }
  }

  &__item--unread {
    color: var(--nb-c-text);
  }
}

.bell__entry {
  display: grid;
  gap: var(--nb-spacing-2);
  inline-size: 100%;
  padding: var(--nb-spacing-8);
  background: none;
  border: 0;
  border-radius: var(--nb-radius-sm, 6px);
  text-align: start;
  color: inherit;
  font: inherit;
  cursor: pointer;

  &:hover {
    background: var(--nb-c-surface-hover, rgb(128 128 128 / 8%));
  }

  &:focus-visible {
    outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
    outline-offset: -2px;
  }

  time {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-xs-size, 0.75rem);
  }
}

/* Why it reached you, said plainly, so the list is scannable without
   reading every summary. */
.bell__reason {
  font-size: var(--nb-type-body-xs-size, 0.75rem);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--nb-c-text-subtle);
}

.bell__enable {
  margin-block-end: var(--nb-spacing-8);
}
</style>

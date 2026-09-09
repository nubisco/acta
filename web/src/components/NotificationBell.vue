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
      <p v-if="ws.notifications.value.length === 0" class="bell__empty">
        Nothing waiting on you.
      </p>
      <ul v-else class="bell__list">
        <li
          v-for="entry in ws.notifications.value"
          :key="entry.id"
          :class="{ 'bell__item--unread': !entry.read }"
        >
          <span>{{ entry.title }}</span>
          <time :datetime="entry.timestamp">
            {{ relativeTime(Date.parse(entry.timestamp)) }}
          </time>
        </li>
      </ul>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { relativeTime } from '@/lib/state'
import { useWorkspace } from '@/stores/workspace'

defineProps<{ compact?: boolean }>()

const ws = useWorkspace()
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

onMounted(() => document.addEventListener('pointerdown', onOutside))
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
</style>

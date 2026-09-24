<template>
  <div class="notify">
    <NbPanel class="notify__section">
      <header class="notify__head">
        <div>
          <h2 class="type-heading-01">When Acta chases you</h2>
          <p class="notify__lede">
            Everything that concerns you lands in the bell. If you have not
            opened it after a while, Acta emails you the ones you missed, as a
            single message rather than one per notification. Opening the bell is
            what stops it, so a morning spent in Acta never produces an email at
            all.
          </p>
        </div>
      </header>

      <NbRadio
        v-model="delay"
        name="notify-after"
        label="Email me about anything I have not seen after"
        :options="DELAY_OPTIONS"
        :disabled="saving"
        @update:model-value="save"
      />

      <!-- Callout rather than inline: these are standing facts about the
           account and the browser, not the outcome of something just done,
           and dismissing one would not make it untrue. -->
      <NbBanner
        v-if="noAddress"
        status="warning"
        variant="callout"
        title="No email address on your account"
      >
        There is nowhere to send this. The bell still works.
      </NbBanner>
    </NbPanel>

    <NbPanel class="notify__section">
      <header class="notify__head">
        <div>
          <h2 class="type-heading-01">This device</h2>
          <p class="notify__lede">
            A desktop notification arrives the moment something happens, while
            Acta is open in a tab. It is per browser, so allowing it here says
            nothing about your phone.
          </p>
        </div>
      </header>

      <div class="notify__device">
        <NbButton
          v-if="permission === 'default'"
          size="sm"
          variant="secondary"
          icon="bell"
          @click="askForDesktop"
        >
          Allow notifications on this device
        </NbButton>
        <NbBanner
          v-else-if="permission === 'granted'"
          status="success"
          variant="callout"
        >
          Allowed on this device.
        </NbBanner>
        <NbBanner
          v-else-if="permission === 'denied'"
          status="info"
          variant="callout"
        >
          Blocked on this device. Browsers only ask once, so turning it back on
          means changing the site permission in the address bar.
        </NbBanner>
        <NbBanner v-else status="info" variant="callout">
          This browser does not support desktop notifications.
        </NbBanner>
      </div>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { api } from '@/api/client'
import { useWorkspace } from '@/stores/workspace'
import { humanise } from '@/lib/state'

/**
 * Deliberately few, and coarse. This is a question about temperament rather
 * than a duration anyone wants to type, and the sweep runs on a fixed tick,
 * so a value between two of these would only look more precise than it is.
 * The server holds the same list and rejects anything else.
 */
const DELAY_OPTIONS = [
  { label: '10 minutes', value: '600' },
  { label: '1 hour', value: '3600' },
  { label: '4 hours', value: '14400' },
  { label: '24 hours', value: '86400' },
  { label: 'Never email me', value: '0' },
]

const ws = useWorkspace()
const toast = useToast()

const delay = ref('600')
const saving = ref(false)
const noAddress = ref(false)
const permission = ref<NotificationPermission | 'unsupported'>('unsupported')

onMounted(async () => {
  permission.value =
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission
  noAddress.value = !ws.me.value?.email
  try {
    const prefs = await api.notificationPrefs()
    delay.value = String(prefs.notify_after_seconds)
  } catch (err) {
    toast.error(humanise(err))
  }
})

/**
 * Saved on change rather than behind a Save button. There is one field here
 * and no way to get it into an invalid state, so a button would exist only to
 * be forgotten, which is how a setting ends up not applying.
 */
async function save(next: string): Promise<void> {
  saving.value = true
  try {
    await api.setNotificationPrefs(Number(next))
    toast.success(Number(next) === 0 ? 'Acta will not email you' : 'Saved')
  } catch (err) {
    toast.error(humanise(err), { title: 'Could not save' })
  } finally {
    saving.value = false
  }
}

async function askForDesktop(): Promise<void> {
  const allowed = await ws.enableDesktopNotifications()
  permission.value =
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission
  if (!allowed && permission.value === 'denied') {
    toast.info('Notifications are blocked for this site in your browser')
  }
}
</script>

<style scoped lang="scss">
.notify {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);

  &__section {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
  }

  &__head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--nb-spacing-16);
  }

  &__lede {
    max-width: 68ch;
    margin-block-start: var(--nb-spacing-4);
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  &__device {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }
}
</style>

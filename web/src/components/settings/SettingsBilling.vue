<template>
  <div class="billing">
    <NbBanner
      v-if="loadError"
      status="error"
      variant="inline"
      :title="loadError"
    />

    <template v-if="state">
      <NbBanner
        v-if="notice"
        :status="notice.status"
        variant="callout"
        :title="notice.title"
      >
        {{ notice.body }}
      </NbBanner>

      <NbPanel class="billing__section">
        <header class="billing__head">
          <div>
            <h2 class="type-heading-01 billing__plan">
              {{ planName }}
              <NbBadge
                v-if="state.state !== 'free'"
                size="sm"
                :variant="stateBadge.variant"
              >
                {{ stateBadge.label }}
              </NbBadge>
            </h2>
            <p class="billing__lede">{{ planLede }}</p>
          </div>
          <div class="billing__actions">
            <NbButton
              v-if="state.subscription"
              variant="secondary"
              :loading="openingPortal"
              @click="manageBilling"
            >
              Manage billing
            </NbButton>
            <NbButton
              v-if="state.sales_url"
              variant="ghost"
              :href="state.sales_url"
              target="_blank"
              rel="noopener"
            >
              Contact sales
            </NbButton>
          </div>
        </header>

        <ul class="billing__meters" aria-label="Usage against the plan">
          <li v-for="m in meters" :key="m.key" class="billing__meter">
            <NbProgressBar
              :label="m.label"
              :value="m.value"
              :max="m.max"
              size="sm"
              :status="m.over ? 'error' : 'active'"
              :helper="m.helper"
            />
          </li>
        </ul>
      </NbPanel>

      <NbPanel v-if="state.plan === 'free'" class="billing__section">
        <header class="billing__head">
          <div>
            <h2 class="type-heading-01">Upgrade to Team</h2>
            <p class="billing__lede">
              20 spaces, {{ state.team.members_included }} members included and
              up to {{ state.team.members_max }} in all, 50 GB of storage, 20
              agents, a year of history. Every feature is on both plans: Team
              only raises the limits. 14 days free, then billed
              {{ billing === 'yearly' ? 'yearly' : 'monthly' }}. Prices exclude
              VAT.
            </p>
          </div>
        </header>
        <div class="billing__form">
          <NbRadio
            v-model="billing"
            name="billing-period"
            label="Billed"
            :options="PERIODS"
          />
          <NbField
            v-slot="{ id }"
            label="Extra members"
            :hint="`Above the ${state.team.members_included} included, at ${extraPrice} each.`"
          >
            <NbNumberInput
              :id="id"
              v-model="extraAtCheckout"
              :min="0"
              :max="maxExtra"
            />
          </NbField>
          <p class="billing__total">
            <strong>{{ total }}</strong>
            {{ billing === 'yearly' ? 'a year' : 'a month' }} after the trial
          </p>
          <div>
            <NbButton
              variant="primary"
              :loading="checkingOut"
              :disabled="!state.paddle.client_token"
              @click="upgrade"
            >
              Start the free trial
            </NbButton>
          </div>
        </div>
      </NbPanel>

      <NbPanel v-else-if="canChangeSeats" class="billing__section">
        <header class="billing__head">
          <div>
            <h2 class="type-heading-01">Extra members</h2>
            <p class="billing__lede">
              {{ state.team.members_included }} members come with Team. Each one
              above that is {{ extraPrice }}, added to the next invoice rather
              than charged now, up to {{ state.team.members_max }} in all.
              Inviting someone when the workspace is full adds one for you.
            </p>
          </div>
        </header>
        <div class="billing__form billing__form--inline">
          <NbField v-slot="{ id }" label="Extra members">
            <NbNumberInput
              :id="id"
              v-model="extraMembers"
              :min="0"
              :max="maxExtra"
            />
          </NbField>
          <NbButton
            variant="secondary"
            :loading="savingSeats"
            :disabled="extraMembers === currentExtra"
            @click="saveSeats"
          >
            Save
          </NbButton>
        </div>
      </NbPanel>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Plan and billing (LA-399), for workspace admins on an instance with plans.
 *
 * Usage against the plan, the upgrade to Team through Paddle's checkout, the
 * extra members, and the customer portal for everything else (payment method,
 * invoices, cancelling). The page never talks to Paddle's API: the server
 * asks licenses, and Paddle.js only opens what the server made.
 */
import { computed, onMounted, ref } from 'vue'
import { useToast } from '@nubisco/ui'
import { api, ApiHttpError, type IBillingState } from '@/api/client'
import { openCheckout } from '@/composables/usePaddle'
import { trackEvent } from '@/composables/useAnalytics'

const toast = useToast()

const PERIODS = [
  { label: 'Monthly, $39 a month', value: 'monthly' },
  { label: 'Yearly, $390 a year (two months free)', value: 'yearly' },
]
const PRICE = {
  monthly: { base: 39, member: 4 },
  yearly: { base: 390, member: 40 },
} as const

const state = ref<IBillingState | null>(null)
const loadError = ref('')
const billing = ref<'monthly' | 'yearly'>('monthly')
const extraAtCheckout = ref(0)
const extraMembers = ref(0)
const checkingOut = ref(false)
const openingPortal = ref(false)
const savingSeats = ref(false)

const maxExtra = computed(() =>
  state.value
    ? state.value.team.members_max - state.value.team.members_included
    : 40,
)
const currentExtra = computed(
  () => state.value?.subscription?.extra_members ?? 0,
)
const period = computed<'monthly' | 'yearly'>(
  () => state.value?.subscription?.billing ?? billing.value,
)
const extraPrice = computed(() =>
  period.value === 'yearly'
    ? `$${PRICE.yearly.member} a year`
    : `$${PRICE.monthly.member} a month`,
)
const total = computed(() => {
  const p = PRICE[billing.value]
  return `$${p.base + p.member * extraAtCheckout.value}`
})
const canChangeSeats = computed(
  () =>
    state.value?.plan === 'team' &&
    state.value.source === 'subscription' &&
    ['trialing', 'active', 'grace'].includes(state.value.state),
)

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  team: 'Team',
  enterprise: 'Enterprise',
}
const planName = computed(
  () => PLAN_NAMES[state.value?.plan ?? 'free'] ?? state.value?.plan,
)

const stateBadge = computed(() => {
  switch (state.value?.state) {
    case 'trialing':
      return { label: 'Trial', variant: 'blue' as const }
    case 'active':
      return { label: 'Active', variant: 'green' as const }
    case 'grace':
      return { label: 'Payment due', variant: 'orange' as const }
    case 'restricted':
      return { label: 'Restricted', variant: 'red' as const }
    default:
      return { label: 'Free', variant: 'grey' as const }
  }
})

function day(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

const planLede = computed(() => {
  const s = state.value
  if (!s) return ''
  if (s.source === 'override')
    return 'This workspace is on an agreement with Nubisco. Contact sales to change it.'
  if (s.plan === 'free')
    return 'Every feature, within the limits below. Nothing is ever deleted when a limit is reached: you are asked to upgrade before adding more.'
  const renews = s.subscription?.current_period_end
  return renews && !s.subscription?.ends_at
    ? `Billed ${s.subscription?.billing ?? 'monthly'}. Renews on ${day(renews)}.`
    : `Billed ${s.subscription?.billing ?? 'monthly'}.`
})

/** What is true about the subscription right now, if anything needs saying. */
const notice = computed(() => {
  const s = state.value
  if (!s) return null
  const sub = s.subscription
  if (s.state === 'trialing')
    return {
      status: 'info' as const,
      title: `Free trial until ${day(sub?.current_period_end)}`,
      body: 'The first payment is taken when the trial ends. Cancel before then from Manage billing and nothing is charged.',
    }
  if (s.state === 'grace')
    return {
      status: 'warning' as const,
      title: 'The last payment failed',
      body: `Team limits stay until ${day(sub?.grace_until)}. Update the payment method in Manage billing to keep them.`,
    }
  if (s.state === 'restricted')
    return {
      status: 'error' as const,
      title: 'Back on Free limits',
      body: 'Payment did not go through, so the workspace is held to the Free limits. Nothing was deleted: what is over a limit is read-only until the plan is restored.',
    }
  if (sub?.ends_at)
    return {
      status: 'warning' as const,
      title: `Team ends on ${day(sub.ends_at)}`,
      body: 'The subscription was cancelled. After that date the workspace moves to Free and anything over its limits becomes read-only. Nothing is deleted.',
    }
  return null
})

const METERS: { key: string; label: string; bytes?: boolean }[] = [
  { key: 'spaces', label: 'Spaces' },
  { key: 'members', label: 'Members' },
  { key: 'storage_bytes', label: 'Storage', bytes: true },
  { key: 'agents', label: 'Agents and connections' },
  { key: 'rules', label: 'Rules' },
  { key: 'webhooks', label: 'Webhooks' },
]

function size(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1)
    return `${Number.isInteger(gb) || gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`
}

const meters = computed(() => {
  const s = state.value
  if (!s) return []
  return METERS.map((m) => {
    const used = s.usage[m.key] ?? 0
    const cap = s.limits[m.key] ?? null
    const fmt = (n: number) => (m.bytes ? size(n) : String(n))
    return {
      key: m.key,
      label: m.label,
      value: cap === null ? 0 : Math.min(used, cap),
      max: cap ?? 1,
      over: cap !== null && used > cap,
      helper:
        cap === null
          ? `${fmt(used)}, no limit`
          : used > cap
            ? `${fmt(used)} of ${fmt(cap)}: over the limit, so the rest is read-only`
            : `${fmt(used)} of ${fmt(cap)}`,
    }
  })
})

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiHttpError ? err.message : fallback
}

async function load(): Promise<void> {
  try {
    state.value = await api.billing()
    extraMembers.value = state.value.subscription?.extra_members ?? 0
    loadError.value = ''
  } catch (err) {
    loadError.value = messageOf(err, 'The plan could not be loaded.')
  }
}

async function upgrade(): Promise<void> {
  checkingOut.value = true
  try {
    const res = await api.billingCheckout({
      billing: billing.value,
      extra_members: extraAtCheckout.value,
    })
    trackEvent('Checkout Opened', {
      billing: billing.value,
      extra_members: extraAtCheckout.value,
    })
    await openCheckout(res.transaction_id, res.paddle, (name) => {
      // The webhook may land a moment after Paddle says it is done, and the
      // page fetches from licenses on load either way.
      if (name === 'checkout.completed') {
        toast.success('Welcome to Team. Your trial has started.')
        window.setTimeout(() => void load(), 2000)
      }
    })
  } catch (err) {
    toast.error(messageOf(err, 'The checkout could not be opened.'))
  } finally {
    checkingOut.value = false
  }
}

async function manageBilling(): Promise<void> {
  // Opened before the request, so the browser treats it as the click's own
  // window rather than a popup to block.
  const tab = window.open('', '_blank')
  openingPortal.value = true
  try {
    const { url } = await api.billingPortal()
    if (tab) {
      tab.opener = null
      tab.location.href = url
    } else window.location.href = url
  } catch (err) {
    tab?.close()
    toast.error(messageOf(err, 'Billing could not be opened.'))
  } finally {
    openingPortal.value = false
  }
}

async function saveSeats(): Promise<void> {
  savingSeats.value = true
  try {
    await api.billingSeats(extraMembers.value)
    toast.success('Extra members saved. The change shows on the next invoice.')
    await load()
  } catch (err) {
    toast.error(messageOf(err, 'The extra members could not be changed.'))
    extraMembers.value = currentExtra.value
  } finally {
    savingSeats.value = false
  }
}

onMounted(load)
</script>

<style scoped lang="scss">
.billing {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);
}

.billing__section {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-16);
}

.billing__head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--nb-spacing-16);
}

.billing__plan {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
}

.billing__lede {
  max-width: 68ch;
  margin-block-start: var(--nb-spacing-4);
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-type-body-sm-size);
}

.billing__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-8);
}

.billing__meters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
  gap: var(--nb-spacing-16) var(--nb-spacing-24);
  margin: 0;
  padding: 0;
  list-style: none;
}

.billing__form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-16);
  max-inline-size: 32rem;
}

.billing__form--inline {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
}

.billing__total {
  margin: 0;
}

/* A phone: the actions go under the heading, as on the Workspace tab, and
   the meters stack. */
@include variables.phone {
  .billing__head {
    flex-wrap: wrap;
  }
}
</style>
